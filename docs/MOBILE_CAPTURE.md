# Mobile Voice Capture — Async Note Ingestion

Reckons.AI has no mobile app, but you can capture voice memos on iOS or Android and have
them automatically appear in your review queue the next time you open the desktop app.

The mechanism is `knowledge.pending.jsonl` — a sidecar file next to your workspace's
`knowledge.ttl`. Any JSON lines appended to it are drained into the pending review queue
on the next app load and then cleared. Your phone writes to the file via a cloud sync
folder; the desktop app reads it from the same folder synced locally.

---

## 1. Desktop setup (do this first)

1. Install the desktop sync client for your chosen service and sign in.
2. Create a dedicated folder, e.g. `ReconsAI/workspace/`.
3. In Reckons.AI: **Settings → Integrations → Workspace folder** → pick that folder.
4. Confirm `knowledge.ttl` appears there after your next KB action (confirm/reject/add).

The `knowledge.pending.jsonl` file is created automatically the first time a note is
appended. You do not need to create it manually.

---

## 2. The pending entry format

Each line in `knowledge.pending.jsonl` must be a single valid JSON object:

```json
{"subject": "urn:kbase:my-topic", "predicate": "urn:kbase:predicate/note", "object": "Your transcription text here.", "addedAt": "2026-06-03T10:00:00Z"}
```

| Field | Required | Notes |
|---|---|---|
| `subject` | yes | IRI for the entity. Use `urn:kbase:<slug>` for simple notes. Spaces become `-`, lowercase. |
| `predicate` | yes | IRI for the relationship. `urn:kbase:predicate/note` is a safe default for free-form text. |
| `object` | yes | The text value — your transcription goes here. |
| `addedAt` | no | ISO 8601 timestamp. Useful for history/audit trail. |
| `note` | no | Optional human-readable annotation shown in the review card. |

For quick voice capture you can keep subject and predicate generic and let Shelly (or the
re-analyze tool) extract structured triples later during review.

---

## 3. iOS — Shortcuts app

iOS Shortcuts has built-in file append support for iCloud Drive, and via the Files app
provider for Google Drive and OneDrive.

### 3a. iCloud Drive

**Requires:** iCloud Drive enabled on iPhone and Mac. The workspace folder must be inside
`iCloud Drive/` (e.g. `iCloud Drive/ReconsAI/workspace/`).

**Shortcut steps:**

1. **Trigger:** "Share Sheet" (so you can share from Voice Memos or any other app) or add
   a home screen button.
2. **"Transcribe Audio"** action — set input to `Shortcut Input` (if sharing a recording)
   or `"Record Audio"` first to capture live.
3. **"Text"** action — build the JSON line:
   ```
   {"subject": "urn:kbase:voice-memo-[Current Date]", "predicate": "urn:kbase:predicate/note", "object": "[Transcribed Text]", "addedAt": "[Current Date, ISO 8601]"}
   ```
   Replace `[Transcribed Text]` with the variable output of the Transcribe step.
   Replace `[Current Date]` with the "Format Date" action (format: `yyyy-MM-dd`,
   and `yyyy-MM-dd'T'HH:mm:ssZ` for `addedAt`).
4. **"Append to File"** action:
   - File path: `/ReconsAI/workspace/knowledge.pending.jsonl`
   - Storage: iCloud Drive
   - If file doesn't exist: Create
   - **Important:** enable "Make New Line" so each entry is on its own line.

### 3b. Google Drive

**Requires:** Google Drive app installed on iPhone. The workspace folder must be inside
Google Drive and synced to your Mac via the Google Drive desktop app
(`~/Google Drive/My Drive/ReconsAI/workspace/`).

**Shortcut steps:** Same as 3a, except in the "Append to File" action:

- Storage: **Google Drive** (appears as a Files provider once the app is installed)
- File path: `/ReconsAI/workspace/knowledge.pending.jsonl`

> **Note:** If "Google Drive" does not appear as a storage location in Shortcuts, open
> the Files app, tap the three-dot menu, choose "Edit", and enable Google Drive. Then
> return to Shortcuts.

### 3c. OneDrive

**Requires:** Microsoft OneDrive app installed on iPhone. Workspace folder synced to Mac
via the OneDrive desktop app (`~/OneDrive/ReconsAI/workspace/`).

**Shortcut steps:** Same as 3a, except in the "Append to File" action:

- Storage: **OneDrive**
- File path: `/ReconsAI/workspace/knowledge.pending.jsonl`

### Reusable Shortcut template

Once built, set the Shortcut as a Share Sheet action (type: Media or Audio) so you can
invoke it directly from the Voice Memos share button. You can also add it to your Lock
Screen or Action Button for one-tap capture.

---

## 4. Android

Android does not have a universal file-append Shortcut equivalent. Two approaches:

### 4a. Google Drive + Tasker (full automation)

**Requires:** Tasker app (~$3, no subscription), Google Drive desktop sync on Mac.

**Tasker profile:**

1. Create a new **Task**: "ReconsAI Capture"
2. Add action: **Microphone** → "Record Audio" (or use the share intent from your
   recorder app as the trigger).
3. Add action: **Speech** → "Record" (built-in speech-to-text). Save result to
   variable `%transcript`.
4. Add action: **Variable Set** → `%entry` =
   ```
   {"subject": "urn:kbase:voice-memo-%DATE", "predicate": "urn:kbase:predicate/note", "object": "%transcript", "addedAt": "%TIMES"}
   ```
5. Add action: **Google Drive** plugin → "Append to File"
   - File: `ReconsAI/workspace/knowledge.pending.jsonl`
   - Content: `%entry`
   - Create if missing: yes

Alternatively, use Tasker's **HTTP Request** action to call a Google Apps Script web app
endpoint (see section 4c) if you prefer not to grant Tasker Drive access.

### 4b. Google Recorder / Samsung Voice Recorder (semi-manual, no extra apps)

Pixel phones and many Samsung devices auto-transcribe recordings.

1. Record your memo. Wait for auto-transcription to complete.
2. Tap the transcript → **Share** → **Save to Drive** (or OneDrive).
3. Save as a `.txt` file to your `ReconsAI/workspace/` folder.
4. On desktop: open Reckons.AI Ingest page → import the text file from Drive.

This path uses the existing Ingest page rather than `knowledge.pending.jsonl`. It
requires a manual import step but no automation tools.

### 4c. Google Apps Script webhook (advanced, any Android app)

For a fully cloud-based append that any app can trigger via share-to-email or HTTP:

1. In Google Drive, create a new Apps Script project.
2. Deploy a Web App that accepts a POST body with `{ object: "..." }` and appends a
   JSONL line to `knowledge.pending.jsonl` in your workspace folder.
3. In Tasker (or MacroDroid, or Automate), make an HTTP POST to that URL after
   transcription.

This keeps Drive credentials server-side and lets any Android automation tool participate
without needing its own OAuth setup.

---

## 5. How import works on desktop

On every app load, Reckons.AI checks for `knowledge.pending.jsonl` in the workspace
folder. If it contains entries they are:

1. Converted to pending `Statement` objects
2. Grouped under a source named **"MCP — N queued notes"** (where N is the line count)
3. Added to the **Review** queue for human confirmation
4. The file is cleared

You can also trigger a manual drain from **Settings → Integrations → Drain pending**.

Entries are never auto-confirmed — they always land in the review queue regardless of
source trust level.

---

## 6. Tips

- **Keep subjects specific** when you can: `urn:kbase:project-atlas` rather than
  `urn:kbase:voice-memo-2026-06-03`. Shelly can merge duplicates, but a good subject
  speeds up review.
- **One thought per entry.** If your memo covers three topics, structure three JSON
  lines in the Shortcut (or record three short memos).
- **Test the sync lag.** iCloud and OneDrive typically sync within 30 seconds on a good
  connection; Google Drive is similar. If you open the app immediately after saving,
  allow a few seconds before refreshing.
- **The file is line-delimited JSON, not a JSON array.** Do not wrap lines in `[...]`.
  Each line must be parseable independently. Malformed lines are silently skipped.
- **Backup note:** `knowledge.pending.jsonl` is cleared after each drain. If you want a
  permanent log of raw captures, add a second "Append to File" step in your Shortcut
  that writes to a separate `voice-log.jsonl` that Reckons.AI never reads.
