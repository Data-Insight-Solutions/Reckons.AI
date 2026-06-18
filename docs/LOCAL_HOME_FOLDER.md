# Reckons.AI Local Home Folder

## Problem

All user data lives in browser-scoped storage:
- **KBs** in IndexedDB (Dexie) — cleared by "Clear site data"
- **Models** in Cache API (`transformers-cache`) — evicted under storage pressure
- **Settings/API keys** in localStorage — also cleared
- **KB Registry** in localStorage — also cleared

A single browser action can delete everything. Users of local-first WASM mode are most at risk since they have no cloud backup by default.

## Current State

A **workspace** system already exists (`src/lib/stores/workspace.svelte.ts`):
- Uses File System Access API (`showDirectoryPicker`)
- Stores the directory handle in IndexedDB (structured-clone safe)
- Auto-exports `knowledge.ttl` to the folder on every KB mutation (debounced 2s)
- Reads `knowledge.pending.jsonl` from MCP server
- Settings profile save/load (`settings_profile.json`)
- Permission must be re-granted each browser session (Chromium limitation)

**Gaps:**
- Only exports one KB (the active one) as a flat `knowledge.ttl`
- Multi-KB structure not represented on disk
- Models not stored in the folder
- No automatic recovery from folder on browser cache clear
- No folder-level backup of sources, changelog, or assets
- Google Drive sync exists but only for manual TTL upload/download

## Design

### Folder Structure

```
~/Reckons/                              (user picks once via showDirectoryPicker)
├── kbs/
│   ├── default/
│   │   ├── kb.ttl                      (full TTL export, auto-synced)
│   │   ├── meta.json                   (stableId, name, description, color, timestamps)
│   │   ├── sources.json                (Source[] — ingestion metadata)
│   │   └── changelog.jsonl             (append-only mutation log)
│   ├── my-research/
│   │   ├── kb.ttl
│   │   ├── meta.json
│   │   └── sources.json
│   └── ...
├── models/
│   ├── Qwen2.5-0.5B-Instruct/
│   │   ├── onnx/
│   │   │   └── model_q4.onnx
│   │   ├── config.json
│   │   ├── tokenizer.json
│   │   └── tokenizer_config.json
│   └── all-MiniLM-L6-v2/
│       └── ...
├── settings.json                       (non-sensitive: backends, UI prefs, model choices)
└── sync.json                           (sync timestamps per KB, conflict markers)
```

### meta.json per KB

```json
{
  "stableId": "uuid",
  "name": "My Research",
  "description": "Papers and notes from Q1 2026",
  "color": "#6b4399",
  "createdAt": 1718700000000,
  "lastModified": 1718712345678,
  "statementCount": 342,
  "sourceCount": 12,
  "dbName": "kbase-my-research"
}
```

### Sync Lifecycle

```
Browser (IndexedDB)            Filesystem (~/Reckons/)
       │                               │
       ├── KB mutation ────────────────>│  debounced write (kb.ttl + meta.json)
       │                               │
       ├── Browser cache cleared        │
       │   (IndexedDB gone)             │
       │                               │
       ├── App loads, detects empty ───>│  "Restore from Reckons folder?"
       │   IndexedDB but folder exists  │
       │                               │
       ├── User confirms ──────────────>│  Import all kbs/*/kb.ttl + meta.json
       │   KB restored in IndexedDB     │  Rebuild registry from meta.json files
       │                               │
       ├── Model download ─────────────>│  Write to models/ AND Cache API
       │                               │
       ├── Cache API cleared            │
       │   (models gone)                │
       │                               │
       ├── Model load, cache miss ─────>│  Check models/ folder first
       │   Found in folder              │  Copy to Cache API, proceed
       │                               │
```

## Implementation Plan

### Phase 1: Multi-KB folder sync (this PR)

Expand the existing workspace to write per-KB subfolders.

**Files to modify:**
- `src/lib/stores/workspace.svelte.ts` — new functions:
  - `writeKbToFolder(kbId, ttl, meta, sources)` — write a KB subfolder
  - `readKbFromFolder(kbId)` → `{ ttl, meta, sources }`
  - `listKbFolders()` → scan `kbs/` for `meta.json` files
  - `syncAllKbs()` — export all registered KBs to folder
  - `restoreAllKbs()` — import all KB folders into IndexedDB
  - `getOrCreateSubdir(parent, name)` — helper for nested dirs
- `src/lib/stores/kb.svelte.ts` — call `writeKbToFolder()` in mutation handlers
- `src/lib/storage/kb-registry.ts` — add `folderName` to `KbEntry` (sanitized from name)
- `src/routes/settings/+page.svelte` — UI:
  - Show KB count synced to folder
  - "Restore from folder" button (visible when IndexedDB is empty but folder has data)
  - "Sync all KBs now" manual trigger
  - Per-KB sync status indicator

**Sync rules:**
- Browser → folder: debounced 2s after any KB mutation (existing pattern)
- Folder → browser: manual trigger or on-startup detection of empty IndexedDB
- Conflict: folder file newer than last sync timestamp → prompt user
- Sensitive data (API keys): NEVER written to folder (stays in localStorage/IndexedDB)

### Phase 2: Model folder persistence

Store downloaded models in `models/` alongside the browser Cache API.

**Files to modify:**
- `src/lib/integrations/llm/wasm.ts` — on model init:
  1. Check `models/{modelName}/` in workspace folder first
  2. If found, sideload into Cache API from folder files
  3. If not found, download normally and also write to folder
- `src/lib/integrations/llm/model-cache.ts` — `sideloadFromFolder(manifest)` function
- `src/lib/stores/workspace.svelte.ts` — `writeModelFile()`, `readModelFile()` helpers

**Constraints:**
- ONNX files are large (500MB+) — use streaming writes via `FileSystemWritableFileStream`
- File System Access API has no progress events for reads, but we can show file size
- Only write models the user has explicitly downloaded (not auto-download to folder)

### Phase 3: Cross-device sync via cloud folders

The `~/Reckons/` folder can be placed inside any cloud sync directory:
- Dropbox, Google Drive (desktop app), OneDrive, iCloud Drive, Syncthing

**This works automatically** because:
- TTL files are plain text (mergeable, diffable)
- meta.json is small JSON (last-write-wins is fine for metadata)
- Models are immutable binaries (same content regardless of device)
- `sync.json` tracks per-KB timestamps to detect conflicts

**For native Google Drive sync** (no desktop app needed):
- Extend existing `src/lib/integrations/google/drive.ts`
- Upload `kbs/{name}/kb.ttl` to a `Reckons/` folder in Drive
- Download on other device and import
- Conflict resolution: compare `lastModified` timestamps, merge TTL if needed

### Phase 4: Settings backup

- `settings.json` in the folder root stores non-sensitive preferences
- On app load, if localStorage is empty but `settings.json` exists, restore
- API keys are NEVER written to the folder

## Browser Compatibility

| Feature | Chrome/Edge | Firefox | Safari |
|---------|-------------|---------|--------|
| File System Access API | Yes | No | No |
| OPFS | Yes | Yes | Yes |
| IndexedDB | Yes | Yes | Yes |
| Cache API | Yes | Yes | Yes |

**Firefox/Safari fallback:** The folder sync is a progressive enhancement. On unsupported browsers:
- Manual TTL export/import continues to work
- Model sideload from file input continues to work
- Google Drive sync (Phase 3) works everywhere
- OPFS could be explored as a future alternative (but still browser-managed)

## Security Considerations

- API keys and credentials NEVER leave browser storage (localStorage/IndexedDB)
- The folder is user-chosen — no default path assumptions
- `settings.json` excludes all `*ApiKey`, `*Token` fields
- If the folder is in a cloud sync directory, only KB data and models are shared
- Directory handle permission expires each session — user must re-grant

## UX Flow

### First Setup
1. User goes to Settings > Local Workspace
2. Clicks "Pick Reckons folder" → OS folder picker
3. Selects or creates `~/Reckons/`
4. App creates `kbs/`, `models/` subdirs
5. Immediately syncs all KBs to `kbs/{name}/`
6. Status: "3 KBs synced to ~/Reckons/"

### Recovery After Cache Clear
1. User opens app, sees empty state (IndexedDB cleared)
2. App detects stored folder handle in IndexedDB (survives some clears) or prompts
3. Shows banner: "Found 3 KBs in your Reckons folder. Restore?"
4. User clicks restore → all KBs imported, registry rebuilt
5. Models re-warm from `models/` folder (no re-download)

### Normal Operation
- Green dot next to workspace name when connected
- Sync happens silently in background after mutations
- "Last synced: 2 minutes ago" indicator
- Manual "Sync now" button for peace of mind
