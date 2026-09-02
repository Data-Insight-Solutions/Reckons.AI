# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-08-29.** Working branch: `feat/task-bridge` (PR #208, stacked on #207 /
`fix/claude-review-hardening`). PRs target `dev`. Note the branch tracks `origin/dev` directly, so
a bare `git push` would push to dev — always `git push origin HEAD:refs/heads/<branch>`.

## ▶ SESSION 2026-08-29 (latest) — honor 3D, and make voice truly opt-in

- **Renderer selection:** Getting Started no longer silently changes a saved/default 3D choice to
  2D. Intentional saved 2D, no-WebGL fallback, FPS detection, the downgrade notice, and its manual
  action remain. The production smoke gate covers all three paths.
- **Starter media:** the everyday starter graph now demonstrates a GIF, WebM video, and GLB model;
  the asset render path is covered by the production smoke gate.
- **Voice is explicit opt-in:** a fresh profile does not import or request Kokoro, Hume, Whisper,
  Transformers, ONNX, a model, WASM, microphone access, or Hume configuration. Saved explicit
  consent remains supported. Imported Turtle preferences cannot grant voice consent.
- **Initial-load boundary:** Shelly chat, Hume narration, Kokoro, and the voice catalogue are loaded
  dynamically only after the corresponding user action. PWA precache excludes optional voice/ML
  runtimes and WASM while retaining runtime caching after an opted-in use.
- **Verification:** 187 unit files / 2,614 unit tests plus 5 Playwright performance-probe tests;
  `svelte-check` 0/0; production build; deploy-gate smoke 5/5; offline evidence 81 tested / 17
  declared / 0 undeclared; fresh production navigation
  made zero optional voice/ML or WASM requests. PWA precache is 484 entries / 31,023.45 KiB with
  zero optional-runtime leaks.
- **CI boundary fixed:** the five performance-probe tests had launched Playwright from the Vitest
  job, where Actions intentionally installs no browser. Pure performance rules remain in Vitest;
  browser probes now run in the Chromium E2E job that already owns the browser dependency.
- **CodeQL boundary fixed:** task documents use atomic create-if-absent; drained n8n rows are
  validated and allowlist-serialized locally before a locked queue write; integration version
  responses are structurally validated before they can reach the review queue. Four correctness
  warnings in storage-event tests and a URL-like label assertion were corrected as well.
- **Full-E2E blockers fixed:** cascade aggregation now inspects all pending bookkeeping even when
  the detail control hides low-altitude rows, so unplanned completion logs still produce their
  required purpose question. The hierarchy regression drives the current layout popover, nav
  assertions await SvelteKit navigation, and Indico diagnostics no longer race a full-page reload
  against their settings write.

## ▶ SESSION 2026-08-28 (latest) — the bridge, the schedule, and eight standing jobs

**MATT'S STATED PRIORITIES (F159, his order):** 1 dictated notes → actionable agent task ·
2 SKOS/SHACL alignment across app features · 3 a terse review process. **1 is DONE.**

- **F160 task bridge** — `tasks-export.ts` writes a markdown FORM for every task missing the fields
  only a person can supply; `tasks-import.ts` turns answers into pending facts and PROPOSES the
  promotion out of `proposed` rather than performing it. No app change, no MCP, no harness adapter:
  the crossing point is the workspace sync, which already writes every graph to disk as Turtle.
- **F162 n8n document output** — live workflow `VarVHunvq5O6oZVW` on Matt's n8n, header-auth gated,
  reusing his existing Outlook credential. Proven by executions 3531/3532.
- **F163 the schedule had NEVER run** — 3,216 consecutive failures: the installed crontab line had
  no `cd`, so cron ran from `$HOME`. The installer was already correct; nothing re-runs it. **And
  the installer WIPED the crontab when re-run** (`grep -v` exiting 1 under `set -e` killed the
  subshell before the echo). Both fixed. **Matt's other cron entries, if any, were lost.**
- **Eight jobs now scheduled** (quarter-hourly trigger, drain-not-cron): pull-notes 15m ·
  drain-queue and offer-tasks 1h · reconcile 6h · orchestrate and review-stars 24h ·
  integration-health 168h.
- **F164 graph-cleanup · F166/F167 generation catalogue (20 tools, API-gated) · F168 integration
  health** — all script tier. **F161 meme story · F165 per-graph autonomy · F156/F157** recorded,
  not built.
- **Notes are Documents** (Matt) — typed at capture. The deterministic type survey could settle 1
  of 183 entities, because most untyped entities were notes and no type existed for one to have.

**KNOWN-BAD, do not rediscover:**
- `review.test.ts:184` fails — bisected to review-page work carried in from an earlier session, NOT
  from this work. Recorded on `bd071d8`.
- **Every good audio-portrait model fails the licence gate** — LivePortrait, MuseTalk and the whole
  Tencent Hunyuan family all report NOASSERTION. Open-weight, not OSI-open. So does `open-webui`.
- **The second cause of bad typing is unfixed:** the extractor emits `used-by` / `has-property` /
  `has-purpose`, which appear in NO built-in type's `schemaPredicates`. That is F149's rdfs:domain
  gap from the other end, and it is why the model has to type everything itself.
- `server-health` reports the kernel has security updates **installed but not in effect** — needs a
  reboot window. Matt's call.

**MEASUREMENT LESSON, cost two wrong numbers in one day:** parsing raw TTL counts reification
triples the importer folds into `Statement` fields. Measure the graph the app builds, not the file.

## ▶ SESSION 2026-08-28 (later) — detail ladder, typing, markdown interchange, SKOS/SHACL

**Built and tested (97 files / 1,493 tests, svelte-check 0/0, smoke gate 4/4):**

- **F144/F151 detail ladder** — `all · detailed · evidence · judgments · decisions · hubs`, default
  `detailed`, on the graph view (in the layout group) and the review queue. It did NOT filter when
  first shipped: the floor was applied to `topologyStatements`, and both renderers resurrect a
  subject node for any excluded statement (right for attributes, wrong for a floored fact). Fixed
  via `hidden.statementIds`. **Two correct rules composing into a wrong one.**
- **F148 hub gates** — a node whose every edge is a record/log is never a hub at any degree, plus
  `EntityTypeDef.allowHub` (false for Document/Web Page). The type gate ALONE would not have
  worked: captured note entities carry no `rdf:type` at all.
- **F147 altitude proposals + user override** — `setUserAltitudes` exists and **nothing calls it**.
- **F145** — verified: `setStatus` has no cascade, so rejecting a fact leaves its `extracted-from`
  link CONFIRMED. The approve direction works via auto-trust; the reject direction is broken.
- **F150 vocabulary revalidation** — computes what a shared-vocabulary change does to the whole
  graph, reporting facts LEAVING the review queue first. Pure function, **no caller yet**.
- **entity-typing** — a `type` stage in the ingest pipeline; types are set before review.
- **F153 markdown interchange** — `task-markdown.ts` renders a task (checklist of what is missing)
  and parses a filled-in one back. Frontmatter only, never prose. **Nothing writes the files yet.**
- **F155 controlled vocabularies** — `static/reckons-vocabulary.ttl`, 300 quads, SKOS schemes +
  SHACL shapes. graph-lint READS the lifecycle from it and checks altitude/task-state/status. The
  check was PROVED to fire with a probe. **No app code reads it** — the unions are still in TS.

**Measurement lesson, learned twice in one day:** parsing raw TTL counts reification triples the
importer folds into Statement fields. It inflated personal-notes from 547 facts to 1,739 and
coverage from 96.3% down to 39.6% — and the second wrong number was used to justify building F147.
**Measure the graph the app builds, not the file format.**

**Pre-existing broken test:** `review.test.ts:184` fails on the uncommitted patch and passes on the
committed page. Bisected — not from this session's work. Fix before that patch lands.

**Recorded, not built:** F146 extraction strategies (scored corpus FIRST), F152 ask-before-extract,
F154 headless-orchestration positioning (the SKOS/SHACL half is aspiration), F156 terse
communication with sender context (SKOS mapping properties are the standard answer), F157 the verb
— expand and refine a statement, which no surface is organized around today.

## ▶ ROADMAP ADDITIONS (2026-08-28) — F141 interview mode, F142 graph goal, F143 game dev

Three new roadmap entries, all TTL only, no code. `graph-lint` clean apart from the untracked-file
dead links below.

- **F141 `kb:interview-mode`** (planned, 4 phases) — in Add (`/ingest`), the model interviews the
  user instead of waiting for input. **The honest part:** `scripts/agent/interview.ts`
  (`kb:async-desk`, functional) already computes open questions and records answers — in the
  TERMINAL, over JSONL on disk, unreachable from the browser. So this is not "add a UI"; it is
  lifting one shared definition of an open question into `src/lib/rdf/`, then building the
  proactive half neither channel has. Governed by an existing principle rather than a new one:
  *an agent must not ask what it can verify*.
- **F142 `kb:graph-goal`** (planned) — minted because F141 needs it and F99.1 already named it
  missing. "telos" appears exactly once in the roadmap: in the 2026-08-13 note saying it is absent.
  Without it, ranking can only produce what is IMMINENT, never what is IMPORTANT — and question
  generation can only find what is incomplete, never what matters.
- **F143 `kb:game-development`** (**speculative**, 4 phases) — a game's canon as a graph. The sharp
  framing: *we are not entering the asset-generation market, we are entering the approval market*.
  Status is speculative and not planned because no game developer has asked for this; phase 1 is a
  falsifiable experiment on shipped machinery (one real canon, does it catch anything a human
  missed) and phases 3-4 should not be built before it.
- **License gate** on Matt's three TS engines, GitHub API, recorded in `reckons-competitive.ttl`:
  MavonEngine/Core MIT 30★ · WesUnwin/three-game-engine MIT 111★ (rapier physics) ·
  rogerscg/era-engine MIT 72★ **DORMANT since 2023-01-06**. All three are Three.js wrappers, which
  incidentally settles F59.1's open weighing: in-process, no server, offline-first thesis intact.
- **F59.1 `kb:int-game-engine` is NOT this and must not be merged with it** — it asks an engine to
  render OUR graph; F143 asks our graph to hold a GAME.

## ▶ LATEST (2026-08-28) — dictated instructions become tasks, not invented facts

**A dictated sentence can ask for work, and extraction had no mode for that.** "Run research on
grants for kids sports" went to a machine whose only output is assertions, so it invented some
(`research has-subject grants`) and lost the actual request. `src/lib/rdf/note-intent.ts` now
routes each sentence BEFORE the model sees it; an instruction is written into the existing F87
task vocabulary instead (`ktype:AgentTask` + `kpred:goal`, verbatim).

- **Script tier, running first.** English commands have a shape a rule can see — bare verb in
  first position, no subject in front. Deterministic, free, backend-independent, and a note that
  is wholly an instruction costs NO extraction call at all. Follows `triple-shape.ts`.
- **Three bands.** Confident → task only. Ambiguous → task proposal AND extraction, both pending,
  human keeps one. No signal → prose as before. Nothing is ever dropped, and every routing carries
  its own explanation in `signals`.
- **A dictated task is NOT runnable.** State `proposed`, no `kpred:effect`, no `kpred:done-when` —
  neither was said out loud. `blockedReason` refuses it by name. Voice must never be a path to
  unsupervised action.
- **The goal is the transcript, verbatim**, fillers and comma splices included.
- Roadmap: `kb:orch-dictated-task` (F87 phase 6, `functional`). 39 + 5 tests; 93 files / 1407 in
  `rdf`+`stores`; svelte-check 0/0.

**The first draft got the real sentence wrong, and that is the lesson.** Matt dictated
"...grants that are, for city, uh, Parks and Rec, that have, uh, childhood activities..." — scored
0.5, hedged instead of routed. Its `are`/`have` sit in relative clauses describing the grants being
asked for, so the detector got WORSE the more detail the speaker gave. Fixed by ignoring finite
verbs after a subordinator. **Invented test sentences never surfaced it; the first real transcript
did, immediately.** Re-scored 0.75, zero text to the extractor.

## ⚠ NOTHING BUFFERS ON THE CAPTURE DEVICE — an offline note is LOST, not delayed

Matt tested a dictation while offline. It never arrived. Verified against the n8n API, not
inferred: **zero executions on either capture workflow all day** (last capture
2026-08-27T22:50:41Z), and the drain returned zero rows. The n8n data table buffers for the
LAPTOP being shut — which is what it was built for and what this file already claimed. It does
nothing for the phone or ring being out of signal: the MCP call fails client-side and there is no
local queue behind it.

**Matt's call, queued as a question:** retry inside the iOS Shortcut (no new components, but
Shortcuts has no durable queue), or move capture off MCP onto a plain webhook the Shortcut can
retry against? Until one exists, dictating out of signal loses the note silently.

## ▶ LATEST (2026-08-27) — voice capture works end to end; extraction is automatic

**The ring → graph path is live and proven.** Pebble Index 01 double-click → MCP
`/mcp/reckons-capture` (Streamable HTTP, bearer) → tool `capture_note` → `/webhook/reckons-note`
→ n8n data table → `scripts/notes-pull.ts --watch` → `knowledge.pending.jsonl` → app import →
automatic extraction → review queue. First successful n8n execution 2826 at 15:22:58Z.

**Root cause of the multi-day tool-call failure was CLIENT-SIDE, not n8n.** The Pebble connection
was named `Reckons.AI`; the dot must be sanitised to `_` when building a tool-name prefix, so
Pebble's strip step could never match what it prepended, and the doubled
`Reckons_AI__Reckons_AI__capture_note` stayed cached in its registry. Fix was renaming the
connection to a sanitisation-stable word (`Reckons`) and REMOVING/RE-ADDING it. **The n8n workflow
was never modified.** Diagnosis came from the n8n API: zero webhook-mode executions ever = no tool
had ever run. Do not chase n8n-side naming again.

## What was built (all tested, 172 files / 2393 tests, svelte-check 0/0)

- `rdf/vocabulary-repair.ts` — LEXICAL/PHONETIC tier. Neither `entityAnswersTo` (exact after
  case-fold) nor `normalizeEntities` (BGE cosine ≥0.90) can catch "Recon's AI" → "Reckons.AI": a
  misspelling has no semantics to embed. Damerau-Levenshtein + a phonetic key, two independent
  signals. Real transcript scores: `Recon's AI`→0.85, `dams`→0.75. **Everything real lands in the
  suggest band — approval IS the feature.** Homophones ("dams"/"DAMs") are UNSOLVABLE here.
- `rdf/captured-notes.ts` + `stores/note-extraction.svelte.ts` — finds unextracted notes, runs
  `ingest({kind:'note'})`, adds provenance. Idempotent via a `kpred:extracted-at` marker IN THE
  GRAPH (capture is at-least-once). A failure leaves no marker so it retries.
- `rdf/auto-trust.ts` — log/system-asserted facts are auto-confirmed; extracted CLAIMS stay
  pending. `extracted-from` is trusted for WHO WROTE IT, not its altitude — `relates-to` is also a
  `record` and must not be auto-confirmed. Test guards that.
- `rdf/claims-context.ts` — grounding now includes what the graph already CLAIMS about anchors,
  not just their names, so a follow-up note can refine/contradict instead of restating. Pending
  claims included but marked `(unconfirmed)`.
- `rdf/partition-run.ts` + review UI — purpose questions are now answerable with free text.
  `purposeAnswers` had been declared and never read while the card promised "queued for the local
  model". The model only SORTS; `validateProposedPartition` drops any purpose not in the user's words.
- `storage/app-db.ts` — workspace handle moved to an app-level DB. It was per-graph, so every new
  graph lost it. Adopts from this graph then the default graph.
- `storage/kb-naming.ts` — one writer for `KbEntry.name` AND `settings.kbTitle`, which had diverged.
- Connecting a workspace now drains the pending queue (it previously only pulled TTLs).

## Open / next

- ~~**Altitude in the graph UI**~~ — **DONE 2026-08-28** as F144/F151, and both open decisions are
  answered: hiding uses LIFTED altitude so a log under a live decision is never hidden, and hidden
  is visibly hidden via the node/fact counter beside the control. Do not rebuild it.
- **Cross-graph vocabulary** — grounding sees only the CURRENT graph. Biggest remaining lever on
  extraction quality. Matt wants "highly aware of all existing graphs, default to personal notes".
- **Migrating triples between graphs** — not built. Personal Notes as a triage inbox.
- **Outlook/GMail/Drive agent control** — needs an ACTION queue with a review gate; nothing exists.
- n8n "Read me first" sticky still draws the abandoned Google Drive hop.


**Last updated: 2026-08-26.** Working branch: `fix/claude-review-hardening`, based directly on
`origin/dev` at `61700e5`. The review/refinement patch below is being organized into release-ready
commits; do not rebase the dirty tree without first preserving it.

## ▶ LATEST (2026-08-26) — four external repos analyzed, licensed, and recorded

Matt flagged four repos for analysis, license check, and incorporation of learnings. All four are
in `static/reckons-competitive.ttl` now; nothing was copied and no code changed.

**License gate (deterministic, GitHub API, script tier).** `ai-memory` MIT · `MegaMemory` MIT ·
`hyperframes` Apache-2.0 (+NOTICE, patent grant) · `sv-table` MIT. All permissive: expression as
well as ideas is available to us with attribution. `competitor-scan.ts` now tracks 17 repos and
reports **no `license-changed` finding** on any of the four — the scanner independently confirms
the licenses recorded by hand.

**Two competitors** (`kb:comp-ai-memory`, `kb:comp-megamemory`) and **two references**
(`kb:ref-hyperframes`, `kb:ref-sv-table` — not competitors, and the graph says so). Six
`kb:adopt-*` candidates, all `speculative`, and two new `ktype:Decision` refusals
(`kb:avoid-model-as-index`, `kb:avoid-agent-harness-layer`).

**The finding that matters is about this file.** ai-memory COMPILES a bounded handoff from captured
session state. HANDOFF.md is 107,738 bytes plus a 94,002-byte archive, and this session — under
instructions to read it first — grepped its headers instead. That is recorded as evidence on
`kb:adopt-bounded-handoff`. We hold better raw material than they do (the plan is already a graph);
what is missing is the compiler and the cap. Nothing built, and the prose should not be deleted
before something demonstrably replaces it.

**Waiting on Matt** (`kpred:decision-owner`, plus two partial facts in the queue):
- TanStack Table v9 as a dependency for `sv-table`'s blocks, or port only the dependency-free
  presentation pieces? Offline-first bundle weight is the trade.
- Invert the workspace-sync capture default (denylist → user-marker allowlist)? A breaking UX change.
- Replace the prose handoff with a generated, bounded one?
- Unconfirmed, asked not guessed: does our merge path record resolution EVIDENCE or only the outcome?

**Verification:** `graph-lint` 0 errors · `npm run align` green (5/5) · `offline:script-tier` 23/23
clean · `agent:run` 1 task, 0 failed. Warnings in graph-lint are pre-existing and unrelated.

---

## ▶ LATEST (2026-08-23) — Claude/Opus review completed, UI/trust/performance follow-through

Parallel code, accessibility, test-integrity, and performance reviews are now integrated. Besides
the earlier graph-context, transaction, review-tree, hierarchy-fit, mobile navigation, error-state,
and false-green harness repairs, the final pass fixed six more defects: invalid RDF terms crossing
the pending-queue boundary; self-asserted `verifiedBy` labels appearing to authorize confirmation;
nested interactive review cards; a visual test that contradicted the transient 2D starter; freeze
reports that charged stillness outside the click window; and recursive hierarchy construction that
overflowed on a valid 6,000-level taxonomy. Queue rows are categorically proposals: verifier output
is advisory `verificationClaim` evidence and every drained fact still enters human review.

The full browser suite also exposed three deliberately expected-failure multi-tab cases. They are
no longer expected failures: graph add/remove events propagate through lifecycle-safe registry
subscriptions, fact/source writes propagate through Dexie `liveQuery`, and same-tab snapshots are
content-deduplicated before reactive assignment. Chrome passed the promoted suite 12/12 across
three repeats, then 20/20 registry race stress and 10/10 fact/duplicate stress; Firefox passed 4/4.
WebKit still aborts at `page.goto` before app code, including the unchanged control, on this host.

The starter performance result is now genuinely green on the production bundle. CPU profiling
located an intermittent ~225ms task in repeated disposable `checkWebGL()` context creation—not in
the 2D simulation (about 38ms total physics and 15ms total draw). WebGL probing is lazy and once-only
for non-empty graphs that actually request 3D, so the transient-2D starter never pays it. Four
headed RTX 3090 runs settled in **1,423–1,485ms**, with **82–133ms worst frames**, **zero ≥200ms long
tasks**, and the video run reported **zero frozen spans**. Reports are
`tests/visual/results/perf/perf-crawl_2026-08-24T03-13-{01-891,09-782,17-661,34-284}Z.json`.
Thresholds and attribution were not weakened.

Final static verification: **166 Vitest files / 2,327 tests pass**, `svelte-check` reports **0 errors
and 0 warnings**, the integrated mock production build succeeds, and `git diff --check` is clean.
The 123-case desktop run completed 114 pass / 9 opt-in or device skips; final focused desktop,
Android, review-visual, settled-signal, topology, and multi-tab repetitions cover the follow-up
changes. One final topology assertion was corrected after proving that 3D DOM labels are a lossy
camera-visible subset; its complete settled-2D inventory passed 3/3 repeats. Everything remains
uncommitted, including generated performance reports.

## ▶ LATEST (2026-08-21e) — why the demo tree was empty, folder grouping, retention, click perf

### THE DEMO TREE WAS EMPTY, AND IT WAS NOT THE TREE
Diagnosed, not guessed: `demo-decision-tree.ttl` imports as **87 plain triples**
(`cleanImportCount: 87`), so `isAnnotated` is false and `kb-import.ts:76` overrides every
statement to **`confirmed`**. Via workspace sync the graph lands fully settled → the review queue
is empty → the tree correctly shows nothing. The fixtures only ever worked through
**`/ingest` → graph → turtle file**, which keeps them pending. That is the path to use today.

**Fix added, half-wired, say so:** `populateKbFromTtl` / `ingestNewKb` / `ingestExistingKb` now take
`{ asPending }` — import a plain TTL as REVIEW WORK rather than settled knowledge. Ignored for an
annotated file, which already states real statuses. **NO UI EXPOSES IT YET** — the option exists,
the toggle does not.

### The workspace is `reckons-workspace/`, not the repo root
`reckons-workspace/kbs/preview-collage/preview-collage.ttl` was rewritten at 14:46 during the
session — that is what the app is syncing. Both demos were in repo-root `kbs/` only, which is why
they never appeared. Now copied to `reckons-workspace/kbs/demo-decision-tree/` and
`.../demo-review-tree/`.

### /kb: group graphs by synced folder sub-directory (F113 `folder` basis)
`graph-sets.ts` already had declared → defined → derived. Folder is the missing source, and it
outranks the name-prefix guess because a folder the user made is intent, not spelling.
- `folderSetOf(path, name)` — **a graph's own folder is not a set; a folder that CONTAINS graphs
  is.** `kbs/clients/acme` → "clients"; `kbs/acme` → null; the shared `kbs/` wrapper never groups.
- `KbEntry.folderPath` (a cache of where a file WAS, never authoritative for reading).
- `syncFolderPaths()` in the workspace store; the /kb page refreshes it while connected.
- Header shows **"by folder"** distinctly from "by name" — a guess must look like one.
- 11 new tests (34 in `graph-sets.test.ts`).

### Log/event nodes archive separately from decisions — `src/lib/rdf/retention.ts`
`fact-altitude.ts` has classified facts since F139 and `archive.ts` has pruned since F97, and
**neither has ever read the other** (grep "altitude" in archive.ts: zero hits). So retention was
altitude-blind, and the only safe policy was keep-everything.
- `log` → ageable · `record` → conditional · `evidence`/`judgment`/`decision` → **keep, at any age**.
- **REFERENCE BEATS AGE:** nothing ageable is archived while a live decision or judgment still
  points at it — archiving it would leave the ruling asserting something with nothing behind it.
- Unclassified predicates default to `judgment` and therefore PROTECT. Fail-safe, and tested.
- 12 tests. Pure — it partitions and explains; it archives nothing.

### Click performance across the whole app — `perf-crawl.ts --clicks`
Every visible button on a route, clicked and timed: settle-to-DOM-quiet (MutationObserver, not a
fixed wait), long tasks attributed to that click only, worst frame, and **whether the DOM changed
at all** — a 900ms click that changes nothing is a different, worse bug. Destructive labels
(delete/clear/reject/unlink…) are never clicked and are reported as skipped.

**It immediately caught the freeze.** `/` with `--throttle=4`:
```
✗ /   9 clicked · 3 skipped · 7 over budget
   1200ms Getting started →   2 long task(s)  worst frame 42868ms  never settled
```
**A 42,868 ms frame.** Two other buttons never settled; two could not be clicked at all (5s timeout).

**HARDWARE HONESTY (Matt: "most users would not have as powerful of dual GPU system as I do").**
`--throttle=N` applies a CDP CPU throttle, the rate is recorded in every report, and an unthrottled
run prints a warning that its numbers are a best case and budgets must be set from a throttled run.
The throttle does not slow the GPU or network — a blunt instrument, stated as one.

**A measurement bug found and fixed mid-run:** the change signature compared node count and text
LENGTH, so /kb's sort buttons ("recent", "size", "name") were reported as inert — reordering
changes neither. Now a content hash.

### Verification
`vitest src/lib/{stores,rdf,storage}` **99 files / 1,504 tests green** · `svelte-check` 0 errors ·
`graph-lint` 0 errors · tsc clean. Nothing committed.

---


## ▶ LATEST (2026-08-21d) — F139 step 3: freeform re-analysis of the pending set

Matt: *"the summary of the pending facts is a start to step 3, and the analyze buttons are a start
to the guidance actions. In addition we need a way to prompt directly after the summary, to suggest
freeform re-analysis of the pending facts."*

**Built.** A freeform instruction field renders immediately below the altitude headline in
`/review` — placement is the feature, because that is where a person has just read what the shape
IS and can say what it should be instead.

- `src/lib/rdf/reanalysis.ts` — pure types + `validateProposedReanalysis` + `reanalysisSummary`.
  10 tests (`__tests__/reanalysis.test.ts`).
- `src/lib/rdf/reanalysis-run.ts` — provider dispatch, mirroring `generateDiffSummary` rather than
  inventing a second selection path.
- `/review` UI: input → run → summary line → the proposed operations → a `<details>` of every
  rejection → "Nothing has been applied."

**THE LOAD-BEARING RULE: RE-ANALYSIS MOVES FACTS, IT NEVER MINTS THEM.** Every other guard here
protects something different — aggregation protects the recorded VALUE, distillation protects the
ALTERNATIVES. The risk here is a reorganization pass quietly introducing a claim under cover of
tidying: the human asks for grouping and receives an assertion they never read. So the operation
set is **closed**:

| op | what it does |
|---|---|
| `attach` | put pending facts under an open decision (the 1,688 orphans) |
| `group` | gather facts into ONE question |
| `depend` | mark one decision prerequisite to another |
| `drop` | flag as noise or duplicate — a proposal to reject, never a rejection |

There is no `add`, no `edit`, no `settle`. A pass that cannot invent a fact cannot launder one into
the graph, whatever the instruction said and whatever the model returned. Unknown ids,
double-claimed facts, self-dependencies, groups of one and unanswerable questions are rejected
loudly **and shown in the UI** — a pass that ignored the instruction must not look identical to one
that followed it.

**No ethics preamble on this prompt, deliberately** — per `kb:content-safety` it is injected by
purpose and locality, and this is stricter than the structured-output exclusion: the entire output
is a closed operation set over existing ids, so there is no channel through which generated content
reaches a person.

### Honest gaps
- **The operations are proposals that are DISPLAYED but not yet APPLIED.** There is no apply
  handler — the next step is wiring `attach`/`group`/`depend`/`drop` to the pending store. Right
  now the value is "see what a re-analysis would do", not "do it".
- No e2e asserts a real re-analysis RESULT: it needs a configured backend, and a test that silently
  passes when no model is reachable is worse than no test. The operation-level guarantees are
  pinned deterministically in unit tests instead.
- Not visually verified in a browser beyond the e2e assertions.

### Verification
`vitest src/lib/rdf` **71 files / 1,115 tests green** · review e2e **29/29** across all projects
(desktop-chrome/firefox/safari, mobile-ios, tablet) · `svelte-check` **0 errors**, 4 warnings all
pre-existing (pointer handlers, video captions) · `graph-lint` 0 errors.

**One thing worth knowing:** running a SINGLE review e2e with `-g` fails on the WebKit projects
with "WebKit encountered an internal error" at `page.goto`. This is **pre-existing, not from this
work** — an untouched test (`altitude headline renders`) fails identically in isolation. The
full-file run, which is how CI runs it, is green.

---


## ▶ LATEST (2026-08-21c) — decision dependency, and a faked fixture for the tree UI

### Decision order is now projected from the plan
`Statement.blocks` was meant to carry decision ordering and never did (8 of 529 rows). But the
relations were never missing — they were held at FEATURE level: `kpred:depends-on`, 140 edges.
`decisionDependencies()` in `src/lib/rdf/review-tree.ts` projects them onto open decisions:

- `DecisionNode` gains **`blockedBy: string[]`** (open decisions to settle first, transitively) and
  **`inCycle: boolean`**.
- Sort order is now contested → forced → **unblocked before blocked** → weighted. Being blocked
  sits above the weighted signals because it is not a matter of degree: settling a decision whose
  foundation is still open is how you settle it twice. The blocked one is still shown, lower, and
  carrying the name of what to settle first.
- A cycle is REPORTED, never silently broken (lower bound, same discipline as `unlockCounts`).
- `offline:decisions` prints `⇢ settle first: …`. 6 tests (`__tests__/decision-dependency.test.ts`),
  including one pinning that a contested decision is NEVER buried beneath an unblocked one.

**Measured, and modest: 7 of 78 roadmap decisions are dependency-ordered.** The projection works;
most `depends-on` edges simply connect a feature that has an open decision to one that does not.
Do not read 7/78 as a failure of the mechanism, and do not read it as success either.

### A faked fixture for the tree UI — `tests/fixtures/demo-decision-tree.ttl`
Matt: *"we can work on the accurate extraction, separately than the UI/UX of the intended result."*
So this graph is hand-authored in the shape extraction is TRYING to reach, to let the tree layout
be designed and judged now. Companion to `demo-review-tree.ttl` (which shows the review PROCESS);
this one shows **depth and order**. Verified output:

```
5 decisions open; 1 contested (1 needing a reckoning); 1 prose-only; 35 bookkeeping never shown
◆ Opening night          CONTESTED implied → needs a reckoning
◆ What the capital grant is spent on   deadline
◆ Where the signal comes from          unlocks 2 in-progress
    ○ Shared airtime on the county mast — costs 1 fact
    ○ Own mast on the roof             — costs 2 facts
◆ The broadcast chain    ⇢ settle first: Where the signal comes from
◆ How volunteers book    ⇢ settle first: The broadcast chain, Where the signal comes from
```

**It is NOT evidence that extraction works** — on the live roadmap 78 of 78 are still prose-only.
It shows the destination, not the current position. Lives in `tests/fixtures/` (not `static/`)
because it asserts a lifecycle conflict on purpose and graph-lint scans `static/*.ttl`.

**A real rule it exposed:** a priced fact must carry `kpred:part-of` back to its decision, because
`optionsFor()` scopes options to the decision's subtree (one hop). A floating `ruled-out-by` is
invisible. Found by running the tree over the fixture, not by reading the code — which is the
point of having one. Noted in the fixture header.

### Matt's 3-step extraction architecture (2026-08-21) — recorded in the graph
1. **Incorporation** — ground new extraction in the existing graph AND the already-pending facts.
2. **Intermediary automated analysis** — relate every pending fact to existing facts AND to other
   pending facts by logic hierarchy and dependency, so root decisions become stacked upon with
   greater and greater detail.
3. **Re-analysis on a manual trigger** — consolidation/reorganization of the pending set, with
   analyze features that surface divergence from the user's graph intention.

**The principle:** not all divergence from optimal is auto-detectable by LLMs or structured
process. The human is still the best layer of intelligence, and nudging pending facts toward their
ideal shape BEFORE they enter the graph means less graph editing and analysis afterwards.
**Shape the pending set; do not repair the graph.**

State, checked in code so the gap is visible: **step 1 is largely built** (`ingest.svelte.ts`
grounds on `allStatements()`; `structural-context.ts` excludes only rejected/superseded, so pending
facts DO reach the extractor). **Open question on step 1:** pending and confirmed anchors are
treated identically, and a pending fact is a weaker anchor than a reviewed one — grounding on
unreviewed claims can propagate them. **Step 2 is partial** (decision→decision only; 1,688
judgments still under no decision root; nothing relates pending fact to pending fact).
**Step 3 is not built** — no manual re-analysis trigger, no divergence surface.

### Verification
`vitest src/lib/rdf` **70 files / 1,105 tests green** · `graph-lint` 0 errors, 8 warnings · tsc
clean · fixture renders as documented. Nothing committed.

---


## ▶ LATEST (2026-08-21b) — the review's last step: prose decisions now split into options

**The core-premise gap, measured.** `npm run offline:decisions` said it plainly: **78 of 78 open
decisions are prose-only** — "no options modelled, so there is nothing to weigh side by side" —
and the question shown was a truncated paragraph. The tree already hides 1,592 bookkeeping facts
and ranks roots by what they unlock; the thing it finally put in front of a human was still a wall
of text. `distillationRequest()` had defined the contract since 2026-08-19 and **nothing executed
it** — `graph-decisions.ts` called it only to print the task name.

**Built and measured on real data:**
- `validateProposedOptions()` + `DistillationOutcome` in `src/lib/rdf/review-tree.ts`, 12 tests
  (`src/lib/rdf/__tests__/distill-options.test.ts`).
- `scripts/offline/distill-decisions.ts` — agent tier, ground → prompt → validate → emit pending
  `kpred:has-option` proposals. Writes no TTL, settles nothing. `npm run offline:distill`.

**The load-bearing rule is different from aggregation's.** Aggregation guards the recorded VALUE
(one fact settles fifty). Distillation guards the ALTERNATIVES: an invented option is a course of
action nobody proposed, shown to the human inside the frame of their own material. So every option
must be grounded in the question's own words or its facts — the model splits and phrases, it never
adds.

**First real run, qwen3-coder, 6 decisions: 12/12 options survived validation, 5/6 decisions got
weighable options.** The splits were faithful — "first-class `ktype:EntitySet` node" vs "saved
selection/template"; the three NeMo sidecar architectures named in the prose. The 6th correctly
produced nothing: its prose poses a question without naming alternatives.

**A real defect the run exposed, now guarded:** all three options of one decision claimed to kill
the *same nine facts*. A price identical across every option is not a price — it looks like
graph-derived evidence while carrying no information. The validator now drops such prices and keeps
the options bare, with a test either way.

**HONEST LIMIT — do not quote the 100%.** n=12 is far too small to call the validator calibrated.
A 100% acceptance rate is equally consistent with a permissive validator as with a good model, and
**no rejection fired on real data at all** (all 12 rejection paths are covered only by unit tests).
The job is registered in `jobs.json` **DISABLED** for exactly that reason. **Next: run
`--limit=40`, read the rejections, and only then consider enabling it.**

### Still open — the other half of "consolidated and dependency tracked"
- **1,688 judgments sit under no decision root.** They reach a human and attach to nothing. That
  is the remaining consolidation gap, and it is bigger than the options gap just closed.
- **Dependency tracking is partial**: roots rank by "unlocks N", but `Statement.blocks` is sparse
  and `aggregate-decisions.ts` (which proposes dependencies) is still disabled and unmeasured.
- Duplicate roots: one feature can spawn several decision roots (Entity sets ×2, NeMo ×2).

### Also this session — maintenance
- **`npm run offline:dead-weight`** (`scripts/offline/dead-weight.ts`, script tier, registered):
  a repeatable flag for **orphaned and superseded features**, not a disk report. Finds artifacts
  whose *producing* job is disabled, graph features whose files have all vanished, unshipped plans
  whose files a shipped feature already owns, and never-called exports **rolled up per owning
  feature**. Two precision bugs found and fixed while building it: treating "mentions" as
  "produces" hid the 209MB button-crawl finding behind an enabled job, and conflating "never
  called" with "used only in its own file" produced 112 findings where 46 were real — the roll-up
  cut that to **6 feature-level questions**.
- Current findings: `kbs/button-crawl` **209.5MB** + `tests/visual/screenshots/button-crawl`
  **79.1MB** from a DISABLED job; 6 orphaned-feature candidates (Svelte Stores 14 uncalled
  symbols, LLM Backends 8, Google Integration 5, Storage 4, Indico 3). **Nothing was deleted** —
  every one is a question for you.

### Verification
`vitest src/lib/rdf` **69 files / 1,099 tests green** · distill+review-tree 34/34 · `graph-lint`
0 errors, 8 warnings · tsc clean · JSON valid. Nothing committed.

---


## ▶ LATEST (2026-08-21) — context management: measured, and the counterfactual now has a harness

**The bill is not where the doctrine said it was.** Across all 16 sessions / 9,054 requests:
fresh input 0% of weighted cost, cache-write 16%, output 12%, **cache reads 72%**. So F74.3
local-offload targets at most ~12% of consumption. `session-tokens.ts` had been printing
"offloading fresh input + output is what moves weighted down" — its own totals falsify that,
and the line is now corrected to print the actual shares.

**New: `npm run offline:context`** (`scripts/offline/context-composition.ts`, script tier, in
`jobs.json`). Measures CARRY COST — tokens x turns re-read — because a block entering context
early is paid for on every later request. Results:

| what fills context | share of context | share of CARRY |
|---|---|---|
| tool-params (what we SEND) | 36.8% | **35.2%** |
| Bash results | 24.5% | 26.8% |
| Read results | 13.8% | 19.0% |
| assistant text | 10.5% | 9.8% |
| human | 10.0% | 4.3% |
| **all graph queries** | 1.1% | **1.7%** |

Two things nobody had guessed. (1) The largest category is tool **parameters**, not results.
(2) File reading outweighs graph querying **27x** — F135's premise holds on our own data.
Caveat: `words*1.33` undercounts code/JSON by 1.7-1.9x vs prose, so the tool-heavy shares are
FLOORS. Calibration is honest — modelled carry is 0.16x billed cache reads, so the SHARES are
the signal and the totals are not quotable.

**Baseline (Matt's question: "compared to what?").** `offline:context -- --projects`: this repo
carries **334.8K ctx/request, peak 998.7K**; the only other project with >=20 requests carries
**66.2K, peak 115.8K**. Ratio 5.1x. n=1 baseline, different work, and a bigger window invites a
bigger context — so it is a floor, not an experiment. It does refute "the graph made these
sessions lean"; it says nothing either way about kb_compress's per-query saving.

**Matt's A/B design is built: `npm run ab:benchmark`** (`scripts/offline/ab-graph-benchmark.ts`).
One task, twice, same base commit, two worktrees — CONTROL (no CLAUDE.md/HANDOFF.md/.mcp.json,
`--strict-mcp-config`) vs GRAPH (as shipped). Measures each arm from its own stream-json and
captures each diff so the OUTCOME can be judged. **Dry-run by default; `--run` spends real
tokens, so it is deliberately NOT in jobs.json.** `--kind=greenfield|decided` is required and
recorded because task selection decides the result. Example spec: `tests/ab-tasks/`.
**Not yet run — that is the next step, and it is Matt's call to spend on it.**

### Also landed
- **HANDOFF.md was the single most expensive artifact in this project's context**: 2,377 lines,
  ~33k tokens, 46 sections back to 2026-07-16, and CLAUDE.md orders every session to read it
  first — 45.0M carried tokens across 14 reads. Split: everything before 2026-08-16 moved
  verbatim to `HANDOFF-ARCHIVE.md`. This file is now ~1,090 lines / ~15k tokens.
  **Keep it that way — when you add a section, move the oldest one to the archive.**
- **`graph-lint` gained `mcp-invisible`** — F104 decision (1)'s missing guard. 3 of 26 graphs
  (`reckons-code-files.ttl`, `website.ttl`, `website-status.ttl`) are not linked into any MCP
  workspace, so `kb_search` returns silence for them and silence reads as "does not exist".
  Warning, not error: a fixture may be excluded on purpose.
- **`.claude/settings.local.json` gained `env.PATH`** with the nvm node bin dir. 575 Bash calls
  had been paying an `export PATH` preamble (~16.5M modelled carry). Machine-specific, so it is
  in the gitignored local file, not a shared one. **Takes effect next session start.**

### Verification
`offline:all --tier=script` 21/22 · `graph-lint` 0 errors, 8 warnings · tsc clean on all four
touched scripts · JSON valid. **`status-evidence` FAILS (1 undeclared shipped-untested
feature) — pre-existing, not from this work: no TTL was touched here; it comes from the
uncommitted F139 roadmap patch (+670 lines).** Unit/visual suites not re-run: no `src/` change.
4 findings queued to the review queue via `kb_add_note` (context-engine, graph-economics x2,
session-tokens).

---


## ▶ WRAP-UP (2026-08-19, end of session) — READ THIS FIRST

### One commit landed; most of the work is still uncommitted, and that is deliberate

Branch **`feat/review-altitude-tree`**, commit **`2857578`** — 15 files, all of them NEW and
unambiguously from this session:

- `src/lib/rdf/{fact-altitude,review-tree,fact-aggregation,structural-context}.ts` + their 4 test files
- `scripts/offline/{read-graph,altitude-report,graph-decisions,aggregate-decisions,perf-crawl}.ts`
- `tests/fixtures/demo-review-tree.ttl`, `kbs/demo-review-tree/demo-review-tree.ttl`

**NOT COMMITTED, because these files interleave this session's edits with the broad uncommitted
review patch that was already in the working tree when the session started.** Separating the hunks
needs interactive staging, and guessing which lines are whose risks losing your work:

| file | total changed | roughly mine |
|---|---|---|
| `src/lib/3d/KnowledgeGraph.svelte` | 147 | ~40 (cooling schedule) |
| `src/lib/3d/KnowledgeGraph2D.svelte` | 59 | ~45 (cooling schedule) |
| `src/routes/(app)/review/+page.svelte` | 620 | ~250 (tree + cascade UI) |
| `src/lib/stores/ingest.svelte.ts` | 563 | ~35 (F136.3 grounding) |
| `src/lib/rdf/types.ts` | 130 | ~20 (settledBy/settledByDecision) |
| `static/reckons-roadmap.ttl` | 661 | ~145 (F139/F139.1/F136.3/F140/F141 + kb:dichotomy) |
| `tests/e2e/review.test.ts` | 126 | all of it |
| `src/lib/rdf/{dichotomy,review-routing}.ts` | 13 | all (quadratic fixes) |
| `scripts/offline/jobs.json`, `package.json` | 21 / small | job + npm script registration |

**Commit your own patch first, then these separate cleanly.** Nothing is lost — it is all in the
working tree and the whole suite is green on it.

### F141 cooling schedule — the numbers, production build, RTX 3090

The simulation had NO termination condition. Grepping either renderer for `alpha`/`cooling`/
`alphaDecay` returned zero matches: only a constant per-frame `DAMP`, with forces re-injecting
energy forever. Added an alpha that decays (d3's 0.0228 → floor in ~300 ticks), scaling the FORCES
only — damping and integration keep raw `dt` — plus a gate that skips the whole physics block once
cooled, so a settled graph stops running an O(n²) pass every frame.

| graph | lines | before | after |
|---|---|---|---|
| demo-review-tree | 110 | 8,674 ms | **5,651 ms** |
| starter-quickstart | 113 | 13,001 ms | **5,695 ms** |
| starter-everyday | 254 | 24,677 ms | **5,693 ms** |
| starter-guide | 398 | 27,649 ms | **8,489 ms** |
| reckons-production | 451 | **never settled** | **17,936 ms — now terminates** |
| reckons-roadmap | 4,247 | never, 10.1 s frames | still never, 10.1 s frames |

Delta traces now decay cleanly (`5.35 4.57 2.17 0.84 0.38 0.19`) instead of hovering at 3–5.

### Three things left, in order

1. **The ~5.7 s floor is now the decay schedule itself, not the physics** — three graphs of very
   different sizes all landed at 5,651/5,695/5,693 ms, which is 300 ticks at 60 fps. Tunable
   (0.04 → ~2.8 s), but faster decay gives the layout less time to resolve, so it is a real
   quality/latency trade rather than a free win.
2. **`starter-guide` still spikes mid-settle**: `11.85 11.41 7.76 2.57 → 14.8 10.76 → 0.45`. Something
   REHEATS partway through — most likely the anchors `$effect` re-running. It recovers and settles,
   but that spike is the remaining oscillation and it should be traced to its trigger.
3. **4,247 nodes still never settles, with 10.1 s frames.** Cooling cannot touch this; it is the
   O(n²) all-pairs repulsion. Needs Barnes-Hut or a node budget (`topByDegree` already exists).
   Then the worker extraction — the physics reads only `nodes`, `edges`, `activeAnchors` and three
   scalars, so it is a clean lift — and then hub-outward progressive loading.

### Two findings worth not re-deriving

- **The reported "hang" is ~92% dev-server.** CDP profile of the docs flow: `get_stack` 14,003 ms +
  `get_error` 3,319 ms — Svelte 5 dev-mode stack capture. Same flow on a production build settles in
  ~2 s. Always measure this class of complaint against `npm run build && vite preview`.
- **`kbs/button-crawl/` is 209 MB from 1,792 statements** — `scripts/offline/button-crawl.ts` inlines
  every screenshot as a `kmeta:gif "data:image/png;base64,…"` literal, single lines up to 928,817
  chars. Delete or stop syncing it; the real fix is asset references via `storage/kb-assets.ts`.

### Verification at wrap-up

Unit 157 files / 2,194 tests green · review e2e 7/7 · visual 89 passed / 14 failed (clean run; the
14 are all outside the code touched here, and **no pre-change baseline was taken**, so they are not
proven pre-existing) · svelte-check 0 errors · graph-lint errors are untracked-file links only.

## ▶ LATEST (2026-08-19) — F139 altitude + F139.1 cascade: review is a tree of decisions (uncommitted)

Matt asked for a hierarchical review process and corrected the design four times while it was being
built. Every correction is recorded in the roadmap TTL as a `kpred:decided`, and each one changed
code — read those before touching this.

**What was missing.** The pipeline had three classification axes (F88 who settles, finding-class
what kind of wrong, dichotomy is-it-contested) and all three answer "how do I handle this". None
answered "does this matter". So `kpred:relates-to` — 476 facts, the roadmap's most common predicate —
routed to the human and got ranked. A shorter flat list is still flat.

**Built and wired.** `fact-altitude.ts` (decision/judgment/evidence/record/log, by the test "if this
fact were wrong, what would we do differently?"), `review-tree.ts` (decision roots, options priced by
`kpred:ruled-out-by`, STP escalation, weighted ranking), `fact-aggregation.ts` (cascade: one question
settles N facts, with provenance). All three render in `/review` — altitude headline plus a cascade
lane that settles a cluster in one click. 66 unit tests; full suite 156 files / 2,166 tests; 7/7
review e2e; svelte-check 0 errors.

**Matt's four corrections, in order:**
1. *No artifacts.* Reckons.AI is a live site with publishing; the review process belongs in the app.
2. *Aggregate and cascade, don't summarize.* "50 statements of datetime stamps are noise, one
   question, did this work occur on X date?" The answer is recorded as the user's own fact and
   propagates to every member via `settledByDecision`.
3. *Not just script tier.* "The summarization of many detailed facts into accurate decision points is
   not mechanically viable… aggregation and dependency decisions I'm certain need LLM assistance."
   The deterministic bases are now explicitly a FLOOR; the agent tier is primary, made safe by
   `validateProposedAggregation` rather than by its prompt.
4. *The answer restructures the set.* A purpose answer ("a package update and debugging") splits one
   cluster into two labelled sets. Three invariants: exhaustive, disjoint, and every purpose traceable
   to the user's own words.

**Claims this work disproved — do not re-assert them:**
- "1,641 outstanding review items" was wrong. It came from `graph-decisions.ts` feeding every
  CONFIRMED fact in as pending. `buildReviewTree` now filters by status itself and `read-graph.ts`
  requires an explicit `asReviewSet` opt-in.
- "Route first, then tree, shrinks the tail" is false on this graph: 1,639 of 1,646 gate to `user`
  because nothing writes `Statement.verifiableBy` (the F135.2 gap). Fixing F135.2 is what would
  actually reduce the human's load.
- A `same-predicate-value` cascade basis was implemented and DELETED the same day — it batched 2,348
  facts into 141 fake questions. `kb:a relates-to kb:x` and `kb:b relates-to kb:x` are independent
  claims that merely agree.

**Honest gaps (why F139/F139.1 are `scaffolded`, not `functional`):**
- The cascade lane has NO in-browser test. `extractMock` returns three fixed triples with
  unclassified predicates → `judgment` → never cascadable, so no mock ingest can build a cluster.
  The e2e records a `coverage-gap` annotation rather than passing silently. Needs a seeding route
  yielding pending BOOKKEEPING facts (manual paste path is the likely candidate).
- The partition pass is a validated CONTRACT with no caller: the UI shows the purpose prompt but does
  not yet collect prose and run the model. A purpose answer currently queues.
- `aggregate-decisions.ts` is in `jobs.json` **disabled** — its yield is unmeasured, and enabling a
  proposal job of unknown precision moves cost to triage rather than removing it.
- All 78 open decisions in the roadmap are prose-only, so the tree renders every root with "no
  options to weigh". Matt decided: agent tier for the 35 literals that already state alternatives,
  lazily-on-open for the other 23.

**LOCAL TEST DEMO — how to try the review process (2026-08-19).**

The demo graph is IN THE SYNCED WORKSPACE at `kbs/demo-review-tree/demo-review-tree.ttl`, so it
appears as a graph after a workspace sync. The same file is at `tests/fixtures/demo-review-tree.ttl`
for the e2e test and for file-picker import. It is deliberately NOT in `static/` — graph-lint scans
`static/*.ttl` and the fixture asserts a lifecycle conflict on purpose, so shipping it there would
make a real check fail for a fictional reason.

Either open it from the graph list after a sync, or: `/ingest` → **graph** tab → **turtle file** →
pick the fixture → **import →**, then `/review`. Every fact lands PENDING, so the whole graph
arrives as review work.

**⚠ DELETE OR STOP SYNCING `kbs/button-crawl/` BEFORE TESTING.** It is 209,460,660 bytes from 1,792
statements: `scripts/offline/button-crawl.ts` embeds every Playwright screenshot as a full
`kmeta:gif "data:image/png;base64,..."` literal, 98 inline PNGs make up 59.9MB of the first 60MB, and
single lines reach 928,817 characters. That is the "massive graph that never finished loading" — the
failure is at graph LOAD, so no review-surface guard helps. The app already has the right mechanism
(`storage/kb-assets.ts` round-trips binaries as workspace files under `urn:kbase:asset/*`), so the
real fix is for the exporter to write asset references instead of data URIs.

The fixture's own header says what each block is meant to demonstrate and what counts to expect, so
it can be judged rather than just looked at. It lives in `tests/fixtures/` and NOT `static/` because
graph-lint scans `static/*.ttl` and the fixture asserts a deliberate lifecycle conflict — shipping it
there would make a real check fail for a fictional reason.

Two defects in the F139 design were found BY this demo and fixed:
- A contested entity with no written question never appeared in the tree at all, despite the tree's
  own rule that contested outranks everything. `buildReviewTree` now synthesizes an IMPLIED root for
  it, anchored on the oldest conflicting side, with the question composed at read time.
- The `same-source` cascade basis swept up `evidence`, putting 61 facts including every measurement
  into one "do you trust this source?" question. It is now record+log only: trusting a source is a
  weaker claim than confirming a measurement, and the weaker claim must not settle the stronger fact.

**F136.3 structural grounding (same session, Matt's fifth correction).** "The dependency for tree
could be better determined with the context of the current graph more available during the definition
of the new fact?" — correct, and it is the ROOT CAUSE of the inert ranking above, not a separate
improvement. `Statement.blocks` is sparse because nothing knew the graph when a fact was born.

- `src/lib/rdf/structural-context.ts` offers the extractor the entities that already exist with their
  real `depends-on` edges and statuses, plus the graph's open questions, both ranked by overlap with
  the source text. `validateStructuralClaims` drops a structural claim pointing at something that
  exists neither in the graph nor in the same batch — a fabricated edge is worse than a missing one
  because the tree RANKS by dependency.
- **This closed the F136 gap**: all six `buildExtractionUserPrompt` call sites in `ingest.svelte.ts`
  plus the manual copy-prompt path now pass graph context. F136 had been scaffolded-but-inert since
  2026-08-16 with no production caller.
- **Bug found and fixed the same day**, and it is the one F136 predicted: open decisions were taken in
  DOCUMENT order, so a text about Set View was offered the open questions about NVIDIA sidecars and
  Facebook's deprecated API. Now ranked by overlap, with zero-overlap questions dropped rather than
  used as filler. Regression test pinned.
- **Honest limit:** functional for selection, validation and wiring; UNMEASURED for effect. No
  before/after extraction benchmark exists, so the claim is that the information is now present, not
  that dependency quality improved. `tests/bench/run-ollama-bench.ts --ground` is where to measure it.
- Grounding costs ~4.4k characters (~1,100 tokens) per extraction prompt; budgets are configurable
  (12 anchors, 6 decisions) because F136's "how much context fits" question is still open.

**Commands:** `npm run offline:altitude` (census), `offline:decisions` (the tree),
`offline:aggregate` (agent tier, needs `OLLAMA_BASE_URL`). `queue-tree.ts` still owns dependency
ORDER — deliberately not merged; altitude is depth, dependency is order.

**Nothing committed, nothing pushed.** 10 `graph-lint` errors are the new untracked files and clear
on commit.

## ▶ LATEST (2026-08-17) — Wave 0 concurrency/evidence contract + graph-view plans (uncommitted)

This section supersedes the two older August 17 runner sections immediately below. Terra and three
bounded local-agent audits were used as reviewers/designers; their conclusions were checked against
the files and the roadmap MCP context before edits. No agent settled a proposal, committed, pushed,
or changed a feature status.

### Wave 0 implemented contract

- A task now succeeds only when **both** its command and independent `done-when` exit zero. The old
  runner could mark a non-zero visual/review command green when a fresh report happened to exist.
  Focused process coverage injects command exit 7 with a passing verifier and proves the task stays
  failed with both exit codes in its receipt.
- `button-crawl`, `visual-diff`, and `local-code-review` write schema-versioned stable reports with
  `finishedAt`. `tasks.ttl` verifies report content and freshness through
  `scripts/agent/verify-run-report.ts`, not file mtime/size. Skipped routes, failed review files,
  incomplete selected/discovered accounting, a wrong schema, or stale content cannot pass.
- Git receipts no longer hash an empty string after `execSync` exceeds its buffer. The new streamed
  fingerprint binds HEAD, porcelain state, tracked staged+unstaged diff, and sorted untracked paths
  plus bytes. Fingerprint failure prevents success. A temporary-repo test covers staged, unstaged,
  untracked, and >1 MiB content independently.
- Runner state changes use a short Linux kernel `flock`, fresh-state conditional claim, unique claim
  token, unexpired-lease fencing, fresh retry baseline, and same-directory fsync+rename. WAITING
  persists its subject|predicate question keys and resumes only from the answers file even after the
  UI drains the pending row. Two deterministically synchronized runner subprocesses execute one
  shared task once; corrupt state fails closed; receipt/context writes are atomic and token-named.
- The shared pending-queue path uses the same locked atomic transaction. All production TypeScript
  host writers/rewriters found by the direct-write sweep now participate; the standalone MCP package
  implements the same `<queue>.lock` protocol. Identity includes graph destination and question
  blockers, recomputation is graph-scoped, and incoming recompute duplicates collapse before write.
- Local review consumes runner-fetched `kb_compress` text only after recomputing its source hash and
  records separate source/consumed hashes and lengths plus truncation. Its worktree discovery unions
  tracked and untracked files, Git failures are loud, findings go through the shared deduplicating
  queue, and the report distinguishes discovered/selected/omitted instead of calling a capped batch
  complete. Oversized file diffs are split into complete bounded prompts and a file counts reviewed
  only after every chunk succeeds. The standing task explicitly names 19 Wave 0 files; it no longer
  implies that this broad dirty branch was reviewed.
- The shared `AgentTask` parser now includes `waiting`, requires at least one known effect, and retains
  unknown effects as blocking diagnostics rather than silently dropping them. This closes drift
  between the reusable RDF contract and the executable runner.

### Honest limits before calling Wave 0 complete

- The corrected standing MCP query returned F81 / `local-orchestration`, 8,561 characters, SHA-256
  `b26d3ab851e98c02e5558f62fad9520327bd4f8a35f7be2a36628a4d9a410c63`, and no F108.3. A bounded
  post-hardening consumer proof then reviewed `runner.ts` and `tasks.ttl` through local
  `qwen3-coder`: **2/2 files, five complete chunks, 0 omitted, 0 failed, 0 truncated**, with source
  and consumed hashes both equal to that F81 hash; independent report verification passed. It was
  a direct consumer-contract proof, not a runner receipt over the complete 19-file standing scope.
- That proof emitted 13 candidate lines for `runner.ts`; the cap retained one and suppressed 12.
  The retained proposal says `--graph` lacks an empty/invalid check, but `runner.ts` already rejects
  missing/empty `GRAPH` before file operations, so Codex assesses it as a false positive. It remains
  pending for the human gate; do not silently settle it. This is evidence that precision/yield is
  still the limiting orchestration metric even when transport and evidence are correct.
- Effects are a declared/gated contract, not an OS capability sandbox. `artifact-write` also remains
  absent, so report/screenshot-producing tasks currently overstate themselves as `source-write`.
- Host locking does not make the browser File System Access drain atomic with Node workers. The UI's
  read/replace path and the shell-only `alignment-sweep.sh` appender remain explicit cross-runtime
  gaps; do not run them concurrently with local queue writers or claim end-to-end queue atomicity.
- `flock` makes this host runner Linux-specific and intentionally fails loud where util-linux is not
  present. Do not replace it with a racy mkdir/mtime stale-lock protocol.
- The first historical local-review receipt is not valid whole-worktree evidence: it covered only the
  first capped 25 tracked paths, omitted untracked paths, consumed unrelated F108.3 context, and its
  worktree hash is SHA-256(empty). Keep it as the failure fixture, not the proof of hardening.
- The latest script-tier sweep ran all **20/20** jobs successfully with explicit Node 22 on `PATH`, but
  it also generated/recomputed proposals as designed. The current brief is **535 total / 532 valid /
  3 invalid / 410 untargeted**; no acceptance-yield measurement exists. Advisory output included five
  predicate-economy warnings, two warn-only SHACL findings in a stale export, 37 alignment suggestions,
  and three reboot/kernel findings. These are observations, not settled product defects.

### MCP-reconciled feature plans recorded in the roadmap

- **F137 Set View** extends F65/F83/F96/F101; it does not create another grouping primitive. A pure
  upstream projection supplies Nodes/Sets/Mixed modes to counts, filters, selection, labels, 2D and
  3D. Unique members collapse to their real set IRI, overlaps stay once as bridge nodes, boundary
  edges aggregate with original statement IDs, filters lift to matched/total, and centroid-based
  collapse preserves spatial memory. Within-set descent is view state; graph leaps remain graph
  transitions and later compose with F131's maximum-three preloaded graph regions.
- **F137.1 shared entity appearance** separates topology from appearance config and gives entities and
  sets one renderer-neutral color/icon/media resolver plus deterministic member-collage fallback.
- **F138 predicate appearance and visual inheritance** adds first-class rule entities, full predicate
  IRIs, direction/channel/strength/priority/conflict/depth/scope settings, literal and IRI status
  sources, deterministic cascade and provenance traces. Confirmed/refined relations drive canonical
  appearance; pending is provisional; derived style is never materialized; collapsed sets require an
  explicit aggregation policy; status must have a non-color channel. The pure resolver precedes the
  Predicate Manager/editor and renderer integrations.

### New local-model and Vault-LD evaluations recorded as references

- The context harness ran two direct `kb_compress` queries before planning. The local-VLM query
  returned F31/F93/F81 context (6,121 characters, SHA-256
  `cc66bc120cc6bdcc190f88ee9a3681140a90bfb6f4ca43a6b4f1e3cde894a0ed`); the RDF/vault/storage
  query returned the ingest/storage/TriG/graph-set contracts (10,903 characters, SHA-256
  `94788f604581d9d6a372f5e734008e35e47ed9a1f45e8ee24a529069a774c98a`). Terra then checked the
  exact F31/F70.2/F74.6/F108.1 and F75/F107/F113 entities through MCP. This avoided creating a new
  product feature for either external project. After writing the references, a fresh 3,000-token
  MCP query returned both exact entities (16,564 characters, SHA-256
  `38e4c2f274a5215f9853cf55c1a55e34109ff5608ff9a774a53f61c775eb5eb1`).
- `kb:ref-lfm2-5-vl-3b` records the exact six-day-old Liquid model as a role-specific candidate, its
  custom license boundary, and fresh local evidence. Official Q4_K_M + projector is now installed in
  Ollama as `hf.co/LiquidAI/LFM2.5-VL-3B-GGUF:Q4_K_M` (2.3 GB; local id `3e9bb91d3103`). On the
  existing 48-check screenshot gate it scored **38/48, zero misses, 10 false flags, p50 769 ms**;
  same-session qwen2.5vl:7b scored **44/48, one miss, three false flags, p50 537 ms**. Reports are
  `tests/visual/results/vlm-gate_2026-08-17T16-16-10.json` and
  `vlm-gate_2026-08-17T16-17-15.json`.
- The exact production two-image `diffImagesVLM` path exposed role separation: on a duplicated image
  both models said IDENTICAL; on two clearly different app views in both orders, Liquid said CHANGED
  twice with concrete layout differences. Qwen said IDENTICAL in the forward order and CHANGED in
  reverse with partly invented node details. Keep Qwen as the current single-image gate default;
  Liquid is the leading pairwise-diff candidate, not promoted until a labelled multi-pair corpus,
  repeats, JSON/evidence-schema, OCR/layout, VRAM/power, and concurrency checks exist.
- `kb:ref-vault-ld` records Vault-LD v0.5 as useful interchange/security prior art and a **current
  no-go for authoritative Reckons storage, backup, or sync**. Its 31 upstream security tests and tiny
  44-triple example pass, but a live RDF -> vault -> RDF probe rebased `urn:kbase:*` subject,
  predicate, and type IRIs under an HTTP base; a minimal `@vocab` fixture also diverged from the spec.
  It has no manifest, revision, locking, atomic promotion, conflict, or sync contract and cannot
  preserve Reckons review/provenance/package state. If Matt wants interoperability, run only the
  bounded exact-IRI/loss-boundary/staged-write conformance spike recorded on the reference; do not
  add an adapter feature before those gates pass.

### Exact continuation for the visual-model evaluation

1. Do **not** change `VLM_MODEL` globally from this one smoke. Add a small pairwise benchmark beside
   `run-vlm-gate-bench.ts`: at least 10 identical pairs, 5 harmless rescale/anti-alias pairs, and 15
   real regressions (blank/missing graph, overlap, mobile layout, text/status-color and moved nodes).
   Run both image orders and three repetitions because the Qwen smoke was order-sensitive.
2. Exercise the production contract, not a bespoke prompt: `diffImagesVLM` plus the structured
   visual-evidence report. Record strict parse rate, false negatives first, false flags, p50/p95,
   exact Ollama artifact/digest, image hashes and corpus revision. A model may not certify itself.
3. If Liquid keeps zero pairwise misses, route only `visual-diff` to it through F74.6. Keep Qwen on
   single-image presence gates unless replicated F31 evidence changes that result. Then compare Q8
   or BF16 only as a quality ceiling and test GPU co-residency/concurrency; do not spend time on
   long visual-design reasoning that Liquid's own card says is outside the model's intended role.
4. Matt independently observed that Liquid looked very good at multi-image work. That observation is
   now attributed on `kb:ref-lfm2-5-vl-3b`; treat it as a reason to test the role thoroughly, not as
   permission to bypass the benchmark. Note also that ordinary search initially missed this six-day
   release—query the live publisher registry before declaring a new model absent.

### Verification and immediate continuation

- Focused verification: **12 test files / 139 tests passed** across runner process races, report/Git
  contracts, MCP binding, queue concurrency, async interview/triage, AgentTask parsing and audit
  rules. `npm run check` reports **0 errors / 4 pre-existing warnings in 2 files**. MCP TypeScript
  check passes. Task TTL parses as **232 quads / 25 tasks**; all 25 declare effects and only the
  deliberate `no-acceptance` refusal fixture lacks `done-when`. Graph lint reports **0 errors / 5
  known predicate-economy warnings**. `git diff --check` passes.
- The next runner proof is the complete **19-file standing Wave 0 review** when its existing 8-hour
  due time permits (the current derived state correctly reports it not due). It must leave a runner
  receipt tied to the full Git fingerprint and the verified report/context. Do not erase derived
  schedule state merely to make a demo green, and do not widen WIP or add the two-GPU scheduler until
  this serial proof and sampled proposal yield are credible.

## ▶ LATEST (2026-08-17) — MCP-grounded local-agent pilot (uncommitted)

- Added `scripts/agent/mcp-context.ts`: it calls the configured local Reckons MCP server over
  stdio JSON-RPC and records a `kb_compress` context file with query, budget, SHA-256 and transport
  provenance. `runner.ts` supports `kpred:context-query` / `kpred:context-budget`, exposes the
  saved path as `TASK_MCP_CONTEXT`, and includes its provenance in the run receipt.
- `local-code-review` is the first consuming task. It now injects runner-fetched MCP graph text as
  **reference data, not instructions**, retains its graph file-owner grounding, and records the
  MCP context hash in its review report. The standing query names `scripts/agent/runner.ts` and
  task-orchestration terms so `kb_compress` lands on F81 rather than the unrelated F108.3 hit from
  the first broad wording.
- Historical pilot run: the runner claimed only `local-code-review`, queried MCP, selected **25**
  paths, wrote a report/receipt, and added proposals without source edits. The newer audit proved
  this was **not** a complete worktree review: it silently capped a much larger tracked set, omitted
  every untracked file, consumed unrelated F108.3 context, and recorded SHA-256(empty) for the
  overflowing diff. Treat it as the motivating failed contract, not end-to-end proof.
- **Quality warning:** that first run emitted **73** code-review proposals. The queue now
  has **535** pending proposals and no proposal has yet been ruled on, so acceptance yield remains
  unknown. Do not treat the 73 as bugs or auto-settle them. The harness now limits future runs to
  **12 total / 1 per file**, reporting suppressed observations; this limits human triage load but
  does not establish precision. Next evaluation work is a sampled human/Codex triage of the capped
  proposals, then measure accepted-over-ruled-on before widening the local-agent schedule.
- Validation: direct `kb_compress` call succeeded through `scripts/mcp-server.sh`; 20 focused
  tests (agent task + MCP response parser) passed under node environment; runner targeted dry-run
  displayed its MCP query and effect gate; `git diff --check` passed.

## ▶ LATEST (2026-08-17) — Wave 0 task-runner hardening (uncommitted)

- `scripts/agent/runner.ts` now requires every runnable task to declare one or more effects
  (`read-only`, `queue-write`, `source-write`, `external-read`, `external-write`), defaults to
  **read-only** authority and **WIP 1**, and requires explicit `--allow-effects=…` / `--all` for
  broader execution. It records hash-only structured JSON receipts under
  `reckons-workspace/runs/` and links the latest receipt from derived task state. Do not invoke
  `npm run agent:run` expecting the old all-task drain.
- All 25 contracts in `reckons-workspace/tasks.ttl` now declare effects. Safety attestation is
  report-only; prompt-audit reflects purpose/locality gating; button-crawl and visual-diff now
  require a fresh task-specific report instead of the shared pending queue.
- Local code review now accepts `--worktree`, `--files`, and `--report`; its standing task reviews
  the uncommitted worktree and verifies a fresh structured review report. Visual diff writes its
  own report and exits nonzero when any route was skipped.
- Validation: task graph parses; 25/25 tasks have effects; no contract still uses the shared
  `knowledge.pending.jsonl` existence check; runner dry-run exposes the effect gate and schedules
  one read-only task. `git diff --check` passes. The focused Vitest invocation is currently blocked
  before test discovery by the existing `html-encoding-sniffer` → ESM dependency mismatch; direct
  `tsc --noEmit` reaches unrelated existing Svelte export errors in badge/button and docs params.
- A bounded local `qwen3-coder:latest` review was run on this diff. Its output was mostly generic
  effect-label concerns; the actionable concern (fresh-report timestamp handling) was manually
  checked against the runner-provided `TASK_RUN_EPOCH` and retained as the task-specific contract.

## ▶ LATEST (2026-08-17) — deterministic audit reliability and refreshed handoff facts

This section supersedes stale counts and the contradictory atomicity line in the August 16 section.
No commit, push, PR, queue settlement, legacy graph assignment, or workspace/export cleanup was
performed. The existing broad patch remains intentionally uncommitted for review.

### Completed in this session (uncommitted)

- Ran the required script tier with an explicit Node 24.18 path because this shell initially had no
  `npm` on `PATH`. All **20/20 jobs exited clean**. Advisory output included the five known graph
  vocabulary warnings, 37 branch-alignment suggestions, and three self-hosted-server reboot/kernel
  findings; those are not represented here as product failures.
- Fixed a repeated false-positive class in the blocking published-graph guard. `toTurtle()` declares
  app `Statement` objects, while N3 also parses two provenance triples per statement. The honest
  header is therefore **221 statements**, not 663; 663 is the raw RDF triple count. The guard now
  reports both units, excludes provenance plus the derived advisory triple from header comparison,
  and uses a **100 asserted-statement** catastrophic-truncation floor rather than staying green only
  because provenance inflated the old 400-triple floor.
- The hand-written claim audit now distinguishes explicit capability absence from a built claim.
  It no longer flags the counsel sentence saying Reckons does not mediate Graph Publication, while
  it still flags an ordinary present-tense claim and still treats statements such as "Graph
  Publication does not require a Reckons server" or "does not exist on a Reckons server" as claims
  that the capability exists.
- Added pure rules in `scripts/offline/lib/audit-rules.ts` and focused coverage in
  `scripts/offline/lib/__tests__/audit-rules.test.ts`. Both files are still untracked inside this
  review patch; formal graph file/test edges are deliberately deferred until the commit that first
  tracks them. `static/knowledge.ttl` was not edited—the warning was in the guard, not the graph.
- Updated the canonical F74.3/tier-script roadmap facts with the correction and current evidence.
  This is plan/evidence maintenance, not a feature-status promotion.

### Verification and local-agent disposition

- Focused audit rules: **10/10 passed**.
- Full unit suite: **147 files / 2,026 tests passed**.
- `npm run check`: **0 errors / 4 warnings in 2 files**. These are the same deliberately unresolved
  Sheet drag-handle, graph pointer-move, and two missing-video-caption-model warnings documented
  below; this slice did not suppress them.
- Published graph guard: **221 asserted statements / 663 RDF triples, 0 errors, 0 warnings**.
- Claim audit: **0 findings** across 5 hand-written surfaces / 156 unbuilt features.
- `git diff --check`: passed.
- A read-only local `qwen3-coder:latest` review received only this bounded diff and made no edits.
  It emitted seven observations. Accepted: scoped "does not exist on our server" needed to remain a
  built-capability claim, and the truncation-floor comment/unit needed tightening. Rejected as
  direct code/test misreads: the intentional helper call, blank-node term access, already-handled
  auxiliary spacing and `does not exist`, the checked-in graph integration fixture, and the
  negated-property test. The accepted edge is now covered.

### Queue and next work (current, not the August 16 snapshot)

- `scripts/brief.ts --json` now reports **460 total** rows: **457 valid, 3 invalid, 410 untargeted**.
  The script-tier sweep changed the prior 421-row snapshot by recomputing/superseding its own job
  findings and adding current targeted findings; it did not infer graph targets for legacy rows or
  settle any proposal. Do not describe 418 targetless rows as the current count.
- Review and commit the broad uncommitted patch as coherent slices before starting another large
  feature. When the new audit-rule files are first tracked, add their formal roadmap file/test edges.
- Then resume the CLI-first grouped/deduplicated human settlement flow. Legacy graph assignment and
  the three invalid proposal types remain explicit human migration decisions.
- F136.1's atomic source/statement/changelog/run transaction **is implemented and rollback-tested**.
  The remaining F136.1 work is the typed invoke/parse adapter split, complete pre-filter loss
  metadata, inspectability/query UI, and the benchmark failure/object-shape/direction fixes before
  production vocabulary wiring. Do not repeat the older statement that atomicity is unfinished.

## ▶ LATEST (2026-08-16) — repository/roadmap audit after the Claude handoff

This section is the current correction layer over the August 15 narrative below. The canonical
roadmap is **`static/reckons-roadmap.ttl`** (also reached through
`reckons-workspace/kbs/roadmap/roadmap.ttl`). The generated browser export at
`kbs/reckons-roadmap/reckons-roadmap.ttl` predates F136 and other August 14–15 changes and is not a
current source of truth.

### Work completed after this audit (2026-08-16; uncommitted)

The highest-priority accuracy and data-integrity slice from the audit is now implemented. These
changes are deliberately still uncommitted so the next maintainer can review them as one coherent
patch. No existing pending-queue row or untracked workspace/export artifact was modified, migrated,
or deleted.

#### Queue validation and graph routing

- Added a shared runtime parser and partitioner in `src/lib/rdf/pending-entry.ts`. It validates the
  JSON object and required fields, proposal type, priority, timestamps, and optional blockers;
  normalizes graph names; and retains the original line for anything that cannot be safely consumed.
  Legacy priority `medium` is accepted and normalized to `normal`, but arbitrary proposal types are
  rejected.
- `drainWorkspacePending` now consumes only schema-valid entries whose explicit `kb` target matches
  the active graph. Targetless, other-graph, invalid, and malformed rows are retained verbatim. A
  malformed line can no longer disappear merely because other entries were drained.
- All repository queue producers now emit an explicit target. General audit/agent/digest/review
  producers default to `roadmap`; production alignment targets `production`; the offline queue API
  accepts an explicit override. Per-KB MCP queue files remain scoped by their containing KB.
- While inventorying producers, fixed a pre-existing name collision in `button-crawl.ts`: its local
  `queueFindings` function shadowed the imported shared writer, recursively called itself with the
  wrong input shape, and swallowed the resulting failure. Crawl findings now reach the shared,
  targeted, recomputing writer and the reported queued count is the actual count.
- The live queue was inspected but **not rewritten**: 421 parseable nonblank rows, of which 418 are
  schema-valid but targetless and 3 have invalid proposal types (`high` once, `normal` twice).
  Consequently all 421 are safely held. Assigning those 418 legacy rows to graphs is a content
  decision, not a migration to infer automatically.
- Added focused coverage in `src/lib/rdf/__tests__/pending-entry.test.ts` and updated offline/agent
  queue tests. The tests cover explicit matching, display/folder-name normalization, legacy priority,
  field validation, and verbatim retention of invalid and malformed rows.

#### F136.1 ExtractionRun ledger — first local foundation (in progress)

- Added the typed, metadata-only `ExtractionRun` contract in `src/lib/rdf/types.ts`, pure lifecycle
  functions in `src/lib/ingest/extraction-run.ts`, and a Dexie **v8** `extractionRuns` table indexed
  by id, source id, start time, and status. Stored runs contain source hash, pipeline/prompt/schema
  identifiers, route decision, attempts, stage timing/status, candidate ids and output ids read
  from the actual write funnel, grounded vs
  explicitly ungrounded counts, terminal status and failure details. They deliberately do **not**
  retain source text, prompts, raw model responses, or credentials.
- `ingest.svelte.ts` now creates and updates a run across the truthful seams the current monolith
  actually exposes: `route → extract → validate → ground → normalize → archive → diff → persist`.
  It records the existing configured backend selection and locality; it does **not** add model
  selection, retries, egress, or fallback behavior. `Source.latestExtractionRunId` and new
  `Statement.extractionRunId` link successful work back to the run.
- The `validate` stage is now a real pre-write boundary. `parseTriplesJSONWithReport()` records
  total array entries and parser-rejected entries for raw-chat adapters; `validateExtractedTriples()`
  rejects blank identifiers, non-scalar/non-finite literal values, invalid literal/datatype pairs,
  out-of-range confidence, and wrongly typed optional presentation/evidence fields. A provider
  result with zero usable candidates throws and leaves no source or statement write; mixed batches
  continue with their accepted candidates and an explicit loss count. Direct Turtle imports skip
  this boundary because their parser has already produced Statements. Adapter APIs that return
  `ExtractedTriple[]` (Claude, Ollama, WASM) can report the candidates they return but cannot yet
  report entries discarded inside their private parser boundary—do not describe those loss counts
  as complete until adapter result metadata is unified.
- The old WASM error path still produces placeholder facts, but its evidence is now honest: the run
  keeps a failed WASM attempt and a succeeding browser-local `placeholder-extractor-v1` attempt.
  The source's extraction metadata names that actual placeholder producer, while the run retains
  the requested WASM primary and its failure.
  Archive-decision cancellation becomes `cancelled`; provider/pipeline errors become `failed` at
  the active stage and are rethrown. A repository-only prompt lazy import was moved inside this
  tracked boundary after local review found it could otherwise leave a run permanently `running`.
- The successful ingest boundary is now atomic. `prepareStatementsForWrite()` preserves the same
  currents/content/agent/archive admission path that `addStatements()` uses, but returns its exact
  accepted batch before a transaction opens. `persistIngestBatch()` then commits source, accepted
  statements, associated changelog entries, and the terminal `ExtractionRun` in one Dexie
  transaction; reactive state, review notifications, autosave/export scheduling, and source hooks
  happen only after commit. A statement-table failure is tested to roll **all four** durable
  records back. A late official-graph switch throws rather than leaving a successful-looking run.
  Content-blocked or archive-held batches can still deliberately persist a source/run with no
  accepted statement rows; that is a policy result, not a partial database failure.
- **Deliberate limits:** no extraction-run UI/query endpoint, no replay, no raw trace option, no
  vocabulary-selector wiring, no token/cost accounting, and no full invoke/parse split yet. The
  parser report is complete only at raw-chat call sites; adapter-returned extraction has the
  terminal typed guard but not pre-filter loss accounting. Atomicity is currently scoped to this
  ingest path; other callers that separately invoke `addSource()` then `addStatements()` retain
  their pre-existing boundary and must not inherit this claim.
- Focused evidence: `src/lib/integrations/llm/__tests__/extractor.test.ts`,
  `src/lib/ingest/__tests__/extraction-run.test.ts`, updated `ingest-archive.test.ts`, and the new
  `kb-ingest-atomic.test.ts` cover parser-loss accounting, typed candidate rejection, local/manual
  route lifecycle, an empty provider result failing before graph writes, cancellation, exact
  accepted-output ids, visible WASM→mock fallback, and transactional source/statement/run/audit
  rollback plus intentional policy-held zero-statement persistence. The full suite passed
  **146 files / 2,016 tests**; `svelte-check`
  reports **0 errors** and the existing 81 warnings.
- Post-documentation verification: `graph-lint` passed with **12,666 quads, 0 errors, 5 existing
  predicate-economy warnings**; `status-evidence` remains **71 tested / 15 declared-untested /
  0 undeclared**; `git diff --check` passed.
- The four new F136 source/test files are still untracked with this broader worktree patch. The
  roadmap therefore records their paths in progress prose but intentionally omits formal
  `kpred:has-file`/`kpred:tested-by` edges: graph-lint correctly treats an uncommitted link as
  dead for every other checkout. Add those edges in the same commit that tracks the files.
- Local-agent review: read-only `qwen3-coder:latest` reviewed only the uncommitted diffs through
  the local Ollama daemon (nothing queued or sent to a cloud service). Its earlier repository
  lazy-import lifecycle finding is fixed. On this validation slice it incorrectly alleged broken
  parser accounting (the count is exactly `array entries - retained entries`) and a Turtle/import
  bypass; the former is covered by a focused test and the latter is deliberate because Turtle
  already arrives as parsed Statements. Its useful reminder was the honest scope boundary above:
  current adapter-returned triples cannot expose parser losses from their private parser. The local
  agent remained review-only; `scripts/agent/orchestrate.ts` continues to emit task drafts only and
  `runner.ts` refuses to run a local-agent task when Ollama is unavailable rather than failing it.
  A second local review request for the transaction seam returned no usable model text within its
  time budget, so it is **not** treated as review evidence; focused rollback tests are the evidence.

#### Dependency, override, and security review (2026-08-16; no package changes made)

- `npm audit --omit=dev --json` is clean: **0 production vulnerabilities** across 155 production
  packages. The full lockfile audit reports **6 vulnerable development/build-tool dependency paths**
  (4 high, 2 moderate; no critical): direct `@sveltejs/kit` 2.70.0 (Accept-header ReDoS), plus
  `brace-expansion` 2.1.3 and 5.0.8, `fast-uri` 3.1.4, `nanoid` 3.3.15, `postcss` 8.5.19, and
  `undici` 7.28.0. The paths are Kit, Vite/PWA Workbox build tooling, shadcn/PostCSS, and jsdom;
  they are dev dependencies in the lockfile, but Kit is a direct build/preview tool and should be
  patched promptly rather than treated as irrelevant.
- A read-only `npm audit fix --dry-run --json` proposed only compatible patch/minor lock updates:
  Kit 2.70.2, `brace-expansion` 2.1.4 + 5.0.9, `fast-uri` 3.1.5, `nanoid` 3.3.18, `postcss`
  8.5.26, and `undici` 7.29.0. Do **not** use a blind audit fix: first update the override test
  floors, apply the lockfile change in an isolated commit, then run the full suite, build, PWA and
  extension checks. The existing `dependency-overrides.test.ts` passes today but accepts the two
  vulnerable brace-expansion versions (`>=2.1.3`, `>=5.0.8`); it should require the audit-fixed
  floors before that test is relied on as a security regression control.
- Overrides are purposeful and presently resolved as intended: `uuid: "$uuid"` aligns the direct
  uuid 14.0.1 with Hume/Storybook; `cookie: ^0.7.0` constrains Kit's copy; `sharp: "$sharp"`
  aligns the direct 0.35.3 package with Transformers; and exact `adm-zip: 0.6.0` constrains
  ONNX Runtime. The focused override-compatibility test passes. Keep these only with the test:
  Sharp and AdmZip cross native/ONNX boundaries, so removing or broadening them on an audit pass is
  not a safe mechanical change.
- **Priority warning — incompatible Storybook family.** Root `storybook`, `@storybook/svelte-vite`,
  and `@storybook/sveltekit` resolve to 10.5.2, while direct `@storybook/addon-essentials` and
  `@storybook/test` are 8.6.18 and declare `storybook ^8.6.18` peers. `npm ls` marks the tree
  peer-invalid. This does not ship in the static application, but it can invalidate component-story
  builds/tests and makes future dependency changes noisier. Align all Storybook packages to one
  supported major in a separate tooling change before trusting `build-storybook` as a release gate.
- Maintenance warnings, not current vulnerabilities: deprecated `boolean` is transitively owned by
  Transformers -> ONNX Runtime -> global-agent; deprecated `rdf-dataset-ext` is owned by
  `rdf-validate-shacl`; old/beta `source-map` copies arise through Storybook/Vite PWA tooling.
  Treat parent upgrades/replacement as the remediation path; do not add direct overrides for these
  deprecated leaves without a compatibility test.
- Lock metadata drift is present: `package.json` is 0.2.0 but root metadata in `package-lock.json`
  remains 0.1.0. `npm ci --dry-run --ignore-scripts` succeeded, so this is not a current install
  reproducibility failure, but synchronize the metadata in the next intentional dependency commit.
- Security controls checked clean: `secret-scan --ci` found only expected `VITE_*` references and
  no inline provider secret; `csp-origin-audit` found every network-call origin admitted by CSP;
  and the safety attestation passed **6/6** when executed with the project's Node bin on `PATH`
  (including 47 safety tests). The Vite secret guard blocks builds if a secret-bearing `VITE_*`
  variable is set, unless the explicit `VITE_SECRET_GUARD_ALLOW=1` bypass is supplied; preserve
  that guard and treat the bypass as a distribution-risk exception.
- Attestation portability warning: called directly in an environment with Node/tsx but no ambient
  npm/npx, the attestation falsely reports its Vitest and graph-lint controls as indeterminate
  because it shells out to `npx`. `npm run safety:attest` supplies the normal PATH and passes.
  Later harden the script to invoke local project binaries through `process.execPath`/resolved paths
  rather than ambient `npx`, so an environment setup defect cannot look like a security failure.

Recommended order when dependency work resumes: (1) reconcile the Storybook major-version split;
(2) tighten the brace-expansion test floors; (3) apply and review the audit dry-run's seven package
updates in one lockfile-only change; (4) synchronize lockfile version metadata; (5) make safety
attestation independent of ambient `npx`. Re-run production and full audits, override tests, unit
suite, builds/extension checks, secret/CSP scans, and the attestation after each relevant change.

#### Dependency/security remediation completed (2026-08-16; uncommitted)

- Completed the ordered repair above without changing application behavior. `@storybook/addon-essentials`
  and `@storybook/test` were removed from the root dev dependencies. The existing Storybook 10
  config already leaves `addons` empty because controls/actions/docs/etc. are built into Storybook
  core; Storybook's v10 addon migration guide specifically says to remove those legacy packages.
  The config's stale "Storybook 8" heading is now accurate as "Storybook 10." The prior mixed-major
  peer-invalid tree is gone and `npm run build-storybook` now completes successfully.
- Raised the direct Kit floor from `^2.69.3` to `^2.70.2`, then applied the compatible audit lock
  updates: `brace-expansion` 2.1.4 and 5.0.9, `fast-uri` 3.1.5, `nanoid` 3.3.18, `postcss` 8.5.26,
  and `undici` 7.29.0. Lock-root metadata is now 0.2.0, matching `package.json`. No override was
  removed, broadened, or added: `uuid`, `cookie`, `sharp`, and `adm-zip` retain their prior tested
  constraints. The fresh installed tree is peer-valid and has **0 full-audit vulnerabilities**;
  production-only audit remains zero.
- Strengthened `dependency-overrides.test.ts` so the two Workbox/Minimatch compatibility paths now
  require the actual security floors (`brace-expansion >=2.1.4` and `>=5.0.9`) while continuing to
  exercise the old function-shaped API required by Minimatch 5. Its four tests pass.
- Made `safety-attestation.ts` invoke the checked-in Vitest and tsx entry points with
  `process.execPath`/`execFileSync`, not shell-interpolated ambient `npx`. The same direct
  Node-only invocation that previously returned false indeterminate controls now passes **6/6**;
  it still preserves graph-lint's non-zero finding output for inspection.
- Fresh evidence after dependency installation: full unit suite **146 files / 2,016 tests**;
  `npm run check` **0 errors, 81 pre-existing warnings**; production `npm run build` passed with
  the secret guard green; Storybook 10.5.2 build passed; and the Chromium extension build passed.
  A clean `npm ci --dry-run --ignore-scripts` also accepts the reconciled lock. Full and
  production-only `npm audit --json` reports **0 vulnerabilities**. Storybook and production
  builds retain pre-existing Svelte/a11y, unresolved font-at-build-time, ineffective-dynamic-import,
  and large-chunk warnings. These are documented warnings, not part of this patch.
- A read-only local `lfm2.5` review received the source/config diff but exhausted its response
  budget in internal reasoning without a findings section. It is **not review evidence** and made
  no edits; the passing deterministic checks above are the evidence for this slice.

#### Extension bundler deprecation remediation (2026-08-16; uncommitted)

- Read the current Rolldown/Vite 8 migration documentation before changing the extension config.
  `inlineDynamicImports: false` is already the default; the recommended `codeSplitting: false`
  is equivalent to deprecated **true** and would incorrectly request a single bundle, which is not
  valid for this six-entry extension build. Removed the redundant deprecated option instead and
  renamed Vite 8's `build.rollupOptions` to `build.rolldownOptions`; no custom chunking is needed.
- A fresh `npm run build:extension` passes with the same entry artifacts and no deprecation warning.
  The Vite secret guard remains green. Do not re-add `inlineDynamicImports` or set
  `codeSplitting: false` unless the extension is deliberately redesigned as a single-input bundle.

#### Accessibility / warning-maintenance slice (2026-08-16; uncommitted)

- Reduced the Svelte compiler result from **0 errors / 81 warnings in 21 files** to **0 errors /
  4 warnings in 2 files**, without blanket warning suppression. The full unit suite remains
  **146 files / 2,016 tests** and the production build passes with the secret guard enabled.
- Repaired the calendar's invalid nested interactive controls by making its selectable event shell a
  keyboard-operable `role="button"` container and retaining the nested add button as the sole native
  button. Menu, popup, group, state-selection, input-label, and deprecated event-handler diagnostics
  were repaired across navigation, merge review, relation builder, QR sharing, history,
  disambiguation, integrations, and Turtle settings. The merge backdrop now dismisses only when the
  actual backdrop is clicked, preserving its prior modal behavior.
- Removed compiler-identified dead CSS; made graph renaming keyboard-operable; corrected reactive
  component references, stale incoming-diff drafts, and local initial-state declarations; and added
  `focusOnMount`, a client-only action that preserves intentional focus for dynamically opened edit
  fields and the fullscreen dialog's close control without the HTML `autofocus` attribute stealing
  focus on page load.
- Converted graph asset thumbnails and image/3D fullscreen affordances to named native controls or
  keyboard-operable controls. The fullscreen surface is now a labelled dialog that dismisses only on
  its backdrop, moves focus to its close control, and locally handles Escape. These are mechanical
  accessibility and correctness fixes; no product workflow was added or redesigned.
- The four remaining warnings are intentionally visible because they need an owning interaction or
  metadata design: (1) Sheet's swipe-down handle is pointer-only but has an independently accessible
  close control, so decide/implement its keyboard semantics rather than assigning a cosmetic role;
  (2) the graph viewport observes pointer movement for hover positioning but is not itself a control,
  so relocate/structure that listener without hiding child graph semantics; and (3–4) video assets
  have only a video URL (`urn:kbase:predicate/video`), no caption-track source. Add an explicit
  caption metadata model and render real `<track kind="captions">` elements before clearing those
  two diagnostics. Do not silence them globally merely to reach zero.

#### Visual/E2E verification slice (2026-08-16; uncommitted)

- Used two scoped, read-only local review agents with compact evidence capsules (changed-file manifest,
  exact test paths, and observations only). `jcode` is **not installed**. Ollama is available with
  local coding and vision models; use the same capsule/retrieve-by-artifact-ID pattern rather than
  passing full transcripts or screenshot payloads into future agent context.
- Installed Playwright Firefox and WebKit browser binaries locally. WebKit cannot launch on this host
  because `libavif16` is absent; do not treat its per-test launch failures as product results or alter
  system packages without approval. The attempted all-device run also exposed the three existing
  `test.fail()` multi-tab synchronization characterizations and one Firefox Vite dynamic-import error
  on an otherwise correctly rendered 404; neither belongs to this UI slice. The long matrix was
  deliberately stopped once WebKit infrastructure failures made continuation non-informative.
- Browser review found and fixed two real fullscreen regressions from this slice: dialog Escape had
  bubbled to the window handler and collapsed both fullscreen and large states; it now stops at the
  fullscreen → large step. Also, the notification bell (`z-index:701`) intercepted the fullscreen
  close control; the task-modal fullscreen surface now sits above it (`z-index:800`).
- `tests/visual/user-stories/previews.test.ts` now asserts the accessible button wrapper introduced
  for node thumbnails. `tests/visual/preview-collage.test.ts` now proves dialog focus, Escape step
  back, backdrop step back, and explicit close. The focused Chromium visual run completed without a
  Playwright error artifact after those repairs. It refreshed the seven tracked preview-collage
  screenshot evidence files; leave them visible for visual review rather than silently reverting them.
- Still required before claiming a complete device gate: run Android Chromium; supply the host WebKit
  dependency then run iOS/tablet; run `test:e2e:smoke`, workflows, and evidence/VLM review. Add
  focused browser tests for MergeReview immediate Escape, Analyze-menu focus transfer, Calendar
  outer-vs-add keyboard behavior, KB rename focus, and Turtle/Integrations selection persistence.

#### Generated brief and handoff facts

- `scripts/brief.ts` now parses the GitHub CLI response without the `jq` formatting trap. An empty PR
  array becomes `null`, not `#null → null: null`.
- Human and JSON output now report the tracking branch, ahead-of-upstream and ahead-of-`dev` counts,
  PR state, and queue totals split into valid, malformed, invalid, and targetless rows. Queue counting
  uses the same validator as ingestion. Pure formatting/count tests live in
  `scripts/__tests__/brief-data.test.ts`.
- Current generated facts: branch `plan/content-operations`, upstream
  `origin/plan/content-operations`, 9 commits ahead of upstream, 14 ahead of `dev`, no open PR found,
  and the held queue counts above.

#### Counsel and safety-record accuracy

- Corrected `COUNSEL-BRIEF.md`, the safety workflow commentary, the attestation generator, and the
  current log header. Claims now distinguish the local graph/content path from the optional
  maintainer feedback endpoint, which can receive name, email, message, source, timestamp, and
  ordinary request metadata. The brief expressly asks counsel for feedback privacy/retention advice.
- Replaced the false "every prompt gets the preamble" claim with the actual purpose/locality policy:
  sharing prompts always include it, remote conversation is gated, and local-only/structured paths
  have deliberate omissions. The safety check now discovers and classifies the prompt modules
  against that policy.
- The record no longer represents Git alone as impossible to backdate. Git supplies hash-linked
  ordering; a protected hosted remote and CI history are the independent timing evidence to preserve.
  Historical attestation entries remain historical and were not rewritten.
- The current safety attestation passes **6/6 controls** (including 47 safety-focused tests).

#### Roadmap evidence and external references

- Corrected F136 (`kb:vocabulary-grounding`) directly in the canonical graph: its selector and
  benchmark scaffold are committed, while production wiring and a usable score remain pending. The
  graph now links the implementation/test artifacts and preserves the measurement defects listed
  below rather than implying graph-aware extraction has shipped.
- Added the missing `kpred:tested-by` evidence for `kb:all-previews-modifier`; status-evidence is now
  green with 71 test-backed shipped features, 15 explicitly declared untested features, and no
  undeclared gaps.
- Recorded seven copy-permitted roadmap references from their primary repositories, with concrete
  lessons and constraints rather than adoption commitments:
  - [iai personal memory engine](https://github.com/CodeAbra/iai-personal-memory-engine) → ambient
    capture hooks and bounded context packs for the context engine; verbatim capture must not bypass
    F52/locality policy.
  - [fenic](https://github.com/typedef-ai/fenic) → typed, inspectable semantic pipelines, lineage,
    caching, and cost accounting for F136/extraction; preserve Reckons' TypeScript/RDF contracts.
  - [OntoCast](https://github.com/growgraph/ontocast) → ontology retrieval, critic/patch stages,
    SHACL repair, and provenance for extraction; schema evolution must remain proposal/review based.
  - [docTR](https://github.com/mindee/doctr) → transcription/layout/rotation OCR benchmark cases;
    do not replace the local WASM path without measured benefit.
  - [old-coder](https://github.com/AmazingAng/old-coder) → spec-to-gauntlet-to-fresh-evidence
    workflow for verification and work tiering; a gauntlet cannot prove its source spec complete.
  - [Docling Graph](https://github.com/docling-project/docling-graph) → validated extraction
    templates, stable IDs, bounding-box provenance, and deterministic fusion; benchmark before any
    integration and retain the existing RDF review model.
  - [NVIDIA NeMo Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) → protocol-normalised model
    routing, deterministic stage signals, escalation and per-route metrics for F74.6; retain direct
    browser providers, make any localhost proxy optional, and never let fallback silently cross the
    local-to-cloud egress boundary.

#### Architecture pass from the seven references (2026-08-16; design only)

Matt asked to architect each useful takeaway. Seven planned native Reckons features now sit beside
the references in `static/reckons-roadmap.ttl`; this pass changed the canonical plan, not product
code, storage schemas, provider selection, or user data:

1. **F136.1 `kb:extraction-run-ledger` — typed ExtractionRun.** A separate IndexedDB run record
   captures immutable source revision, provider/model, prompt/schema ids, selected vocabulary,
   ordered stage outcomes, metrics, validations, output statement ids and explicit failures. Source
   points to the latest settled run; proposed statements carry `extractionRunId`. Raw prompts,
   responses and source bodies remain opt-in local traces, never default publication payloads.
2. **F136.2 `kb:reviewable-graph-patches` — bounded graph operations.** The sequence is acquire ->
   select -> extract -> ground -> validate -> normalize -> diff -> propose. Existing `Diff` remains
   the review presentation; GraphPatch is the transactional execution artifact. First release is
   insert-only. Critics emit diagnostics/replacement proposals, deterministic code may repair only
   meaning-preserving form, and schema patches are separate human decisions from fact patches.
3. **F122.1 `kb:document-evidence-anchors` — source-addressable evidence.** Parsers return a neutral
   DocumentIR of ordered pages/blocks. An EvidenceAnchor names the exact source hash, block, excerpt,
   character span and optional normalized page/bbox geometry. Missing geometry stays unknown; source
   revision mismatch invalidates the anchor. Private document bytes remain outside graph packages.
4. **F135.3 `kb:local-session-memory` — memory as source, never authority.** Opt-in host adapters
   append a common immutable SessionEvent. Human turns remain verbatim; assistant/tool retention is
   separately bounded. Bounded packs query confirmed graph facts first and labelled session history
   second. Promotion creates an ordinary pending patch tied to the source turn; no conversation is
   auto-promoted, synced, or published.
5. **F34.1 `kb:risk-evidence-contract` — plan before, evidence after.** VerificationPlan states
   behaviors, non-goals, risks and required checks. A runner, not the agent, emits append-only
   EvidenceReports with diff hash, exact argv, versions, timing, exit codes, artifacts and an
   explicit unverified list. Risk can be elevated automatically; sensitive gates cannot be lowered
   silently. Green checks never settle qualitative UX/status claims.
6. **F70.2 `kb:ocr-provider-benchmark` — capabilities and measurement before provider changes.**
   Tesseract, Ollama VLM, Mistral and any future docTR sidecar declare text/layout/rotation/table/bbox
   capability and return the same DocumentIR. Benchmarks score CER/WER, reading order, regions,
   bbox IoU, rotation, tables, hallucination, latency, memory/download size and egress separately;
   there is deliberately no blended leaderboard score.
7. **F74.6 `kb:model-routing-ledger` — policy-driven routing with visible attempts.** A native
   `ModelRoutePolicy` first excludes targets that violate capability, locality, egress, availability
   or budget constraints, then applies explicit task overrides and deterministic workflow signals.
   A `ModelRouteDecision` records candidates, the decisive rule and every provider/model attempt,
   including errors, validators, locality, tokens/cost and latency. Local-to-cloud fallback requires
   an allowed policy edge; a recovered run still shows the failed primary. Random routing is only a
   sticky benchmark split. An LLM classifier is last-resort advice, never the primary router or the
   judge of its own output.

Cross-cutting decisions: copy contracts before engines; large/raw artifacts stay local while compact
provenance enters the graph; model stages cannot silently repair semantics; deterministic checks own
form and humans own meaning; routing cannot silently change data locality; failures and unrun checks
are explicit. Recommended delivery spine is F34.1's minimal evidence reporter alongside F136.1,
including F74.6's route-attempt record, then F122.1 + F70.2, then F136.2. Generalise F74.6 beyond
extraction only after that route is replayable. F135.3 can proceed independently once its
retrieval-recall fixture and private-location UX are specified. The three ingestion contracts and
memory remain high priority; the incremental evidence automation, OCR provider competition and
generalised router are medium priority rather than seven new simultaneous P0s.

Switchyard itself is deliberately **not** adopted as runtime infrastructure in this architecture.
Its README marks it pre-alpha, and its always-on Rust proxy/server shape is not a default fit for a
static browser application. The first implementation remains provider-neutral TypeScript around the
existing direct calls. A user-configured localhost Switchyard endpoint can later compete as one
adapter after a conformance corpus proves streaming, structured output, tool calls, cancellation,
usage/error reporting and safety metadata survive protocol translation without approximation.

#### Verification of the uncommitted patch

- Full unit suite: **144 files, 2,003 tests passed**.
- `npm run check`: **0 errors**, 81 pre-existing warnings in 21 files.
- Graph lint: **26 files, 12,657 quads, 0 errors**, 5 structural vocabulary warnings after the
  architecture pass.
- Status-evidence: **71 backed, 15 declared, 0 undeclared** (exit 0).
- Safety attestation: **6/6 controls passed**.
- `scripts/brief.ts --json` was exercised against the current repository and queue.
- The new pending-entry test is described in F80's progress evidence but is not yet a formal
  `kpred:tested-by` target: graph-lint correctly rejects links to untracked files. Add that edge in
  the commit that first tracks the test, or immediately afterward.

#### Remaining ordered work

1. Decide the target graph(s) for the current 410 legacy targetless rows and repair or reject the 3 invalid
   proposal types through an explicit, reviewable migration. Do not bulk-assign them based only on
   their current file location.
2. Build the CLI-first grouped/deduplicated settlement UI with human settler provenance. The runtime
   safety boundary is complete; the review experience is not.
3. F136.1's atomic success transaction is implemented and rollback-tested. Finish the typed
   invoke/parse/validation adapter split, complete pre-filter loss metadata, add inspectability, and
   then complete the existing F136 benchmark failure/object-shape/direction fixes before production
   vocabulary wiring.
4. Build F122.1 evidence anchors and the F70.2 provider-neutral DocumentIR/benchmark, then F136.2's
   insert-only patch path. Production vocabulary wiring follows only if that evidence supports it.
5. Decide an ignore/external-workspace policy for the seven pre-existing untracked export/workspace
   paths. They remain untouched.
6. Generate or retire stale `ROADMAP.md`/`AUDIT.md` inventories, and shrink this handoff after the
   current patch is committed. The implementation section above is the current state; findings below
   describe the pre-fix audit unless explicitly marked otherwise.

### Immediate corrections to the prior handoff

- F136 is committed, but only as a vocabulary selector, prompt-section builder, fixture, and
  baseline benchmark scaffold. It is **not wired into production ingestion**. Production callers in
  `src/lib/stores/ingest.svelte.ts` and `src/lib/ai/ollama-extract.ts` still call
  `buildExtractionUserPrompt` without vocabulary context. Keep `kb:vocabulary-grounding` planned
  until the production path is wired and measured; a precise interim description is **"selector and
  benchmark scaffold complete; production wiring and measurement pending."**
- Before hardening, `reckons-workspace/knowledge.pending.jsonl` had **421 parseable nonblank rows**,
  not 583: 418 are schema-valid under the compatibility parser and 3 have invalid proposal types.
  The queue was previously pruned/reconciled (the roadmap records 904 → 409), so "has never been
  cleared" is not literally true. The accurate claim is that it has not been drained through a
  working human settlement workflow.
- "Export to local agent is clearly next" and "review settlement is the highest-value item" are
  competing historical recommendations below, not a resolved order. The audit order is recorded at
  the end of this section.
- `npm run bench:agentic` does not answer whether Shelly can orchestrate skills. It contains three
  small TypeScript coding exercises (`fix-failing-test`, `implement-to-spec`, `two-file-rename`) and
  measures a coding loop, not action selection, argument correctness, accept gates, multi-step tool
  use, refusal, or recovery. Do not use it to unpark Shelly orchestration.

### P0 audit finding — counsel brief made false engineering assertions (addressed above)

`COUNSEL-BRIEF.md` says Reckons/DIS has no path by which user content reaches DIS infrastructure.
That conflicts with `src/lib/integrations/n8n/contact.ts`: when
`VITE_FEEDBACK_WEBHOOK_URL` is configured at build time, the feedback form sends name, email,
message, and source to the maintainer endpoint. The variable may be unset in the current production
build, but the conditional product data path exists and must be disclosed before counsel relies on
the brief. Mailto fallback is also still a communication path to DIS.

The same brief says the ethics preamble is injected into every LLM prompt. Current
`ethicsPreambleFor` policy omits it from some local and structured paths. Update the claim to match
the deliberate policy and document its rationale. The old 5/6 safety attestation is a dated result,
not current evidence. This is an engineering/documentation finding, not legal advice.

### P0 audit finding — pending queue integrity and graph routing (runtime guard addressed above)

Do not bulk-drain the current queue until these are resolved:

- All 421 audit-time entries omitted `kb`. The old `drainWorkspacePending` treated an entry without `kb` as valid
  for whichever graph is active, so roadmap/code-review proposals can be imported into the wrong
  graph.
- The producer schema and app type disagree. **286 entries use priority `medium`**, while
  `PendingEntry` declares `low | normal | high`. Three rows also use invalid proposal types
  (`high` once and `normal` twice). Runtime parsing casts JSON without validating it, so the bad
  values are silently accepted with fallback behavior.
- Malformed JSON rows are skipped rather than retained. If other entries are drained and the file
  is rewritten, a malformed row can disappear silently.
- There are 421 rows but only 213 unique subject+predicate pairs, with heavy clusters (including 74
  history-lesson proposals on one deep-testing predicate). Multiplicity can be legitimate, but the
  review flow needs grouping/deduplication rather than presenting this as 421 independent decisions.
- 51 entries have no `addedAt`; all omit `kb`; 57 lack `addedByMcp`. The answers file contains only
  8 entries. Provenance and targeting need to be required before settlement is trusted.

The CLI-first settlement recommendation remains sound because a human is at the keyboard, but the
same work must add schema validation, explicit graph routing, grouping/deduplication, and provenance.
Do not expose model-callable MCP settlement until the human/agent distinction is structurally
enforceable.

### F136 — measurement and implementation findings

The selector/test scaffold is useful and its focused tests pass, but the current experiment cannot
support a product claim yet:

1. `run-ollama-bench.ts` catches a model failure and returns `null`; the report then drops null
   results and exits 0. That is why the attempted grounded run produced selection output but no
   score. An explicitly requested model with no result must be reported as failed and produce a
   non-zero exit.
2. The scorer matches normalized subject/predicate/object text but ignores `objectIsLiteral` and
   datatype. Grounding could improve vocabulary agreement while turning a literal such as `blue`
   into an entity IRI, and the score would not notice. Add object-kind/datatype accuracy or require
   shape equality in the strict match.
3. The fixture's exact-token relevance check does not mark the motivating `has-heart-count` as
   mentioned. It is still offered only because all 16 fixture predicates fit the budget; in a
   mature 333-predicate graph it could be crowded out. Measure lexical variants/lemmatization or a
   partial topical score against a realistically sized graph.
4. The selected entity list mixes proper entities with literal-like values such as `blue` and
   `semelparity`. A reuse instruction can therefore change object typing. Separate candidate entity
   IRIs from known literal vocabulary, or make the prompt distinction explicit.
5. `--ground` currently measures baseline mode only, while production Ollama ingestion defaults to
   structured extraction. A successful baseline A/B still would not measure the production path.
   Thread vocabulary through the structured, production-shaped path before making a shipping claim.
6. Fact recall remains an upper bound because the scorer does not detect relation direction. Keep
   reporting it separately from vocabulary agreement and add a direction-sensitive metric/fixture.

### Roadmap, graph, and generated-artifact findings

- `npx tsx scripts/offline/graph-lint.ts --json` passes: 26 graph files, 12,402 quads, 0 errors.
  Its 5 warnings are structural signals, not syntax failures: 226 `skos:related` edges, 401
  `kpred:relates-to` edges, 4 `kpred:related`, 1 `kpred:link`, and 80 of 333 predicate types used
  only once.
- `status-evidence --json` currently exits 1. It finds 70 shipped features backed by tests, 15
  explicitly untested, and one undeclared gap: `kb:all-previews-modifier` is functional and names
  tests in its proof text but lacks a `kpred:tested-by` relationship. This looks like an evidence-link
  documentation gap, not proof that no tests exist.
- Roadmap readiness reports 119 startable features: 11 in progress, 93 planned, 15 scaffolded; 27
  ready, 21 blocked, and 71 underdefined. Its ordering is not wholly trustworthy because it reads
  moved stubs in the roadmap as unbuilt without resolving their shipped/production destinations.
  Fix that resolver before using the report to rank work.
- The shared-dependency report is useful for discovery but too noisy to set priority directly (283
  features, 126 hub-overlap pairs, 174 lexical pairs). The roadmap needs a much smaller explicit
  "Now" set and a WIP cap rather than more inferred candidates.
- Root `kbs/default-graph`, `kbs/docs-features`, `kbs/docs-use-cases`, and
  `kbs/reckons-roadmap` are untracked generated browser exports from August 13. The annotated
  roadmap export contains 28,194 parsed quads/3,458 subjects versus the canonical roadmap's 3,665
  quads/353 subjects because it expands annotations, but it is older and lacks F136. Size is not
  freshness.
- `reckons-workspace/kbs/farm-grants` and the two council worksheets are also untracked local
  workspace artifacts. Root `kbs/` already contains tracked examples, so these paths are one broad
  `git add -A` away from an accidental commit. Use an external workspace or targeted ignore rules;
  do not blanket-ignore the tracked samples.

### Stale hand-maintained documentation

`ROADMAP.md` and `AUDIT.md` were last updated around July 4 while the canonical graph continued
through August 15. Treat them as dated snapshots until they are generated or retired. Concrete
drift found:

- `ROADMAP.md` says "Alpha — feature-complete for personal use" while stabilization remains open and
  the graph has 93 planned plus 11 in-progress features.
- It says "7 total" extraction paths while listing 6; the current settings union has 9 provider
  values plus a separate manual path.
- Its 155+ test count is stale.
- It documents 20 MCP tools. `mcp-server/src/index.ts` registers **21**; `kb_merge` is missing from
  `ROADMAP.md`, `CLAUDE.md`, and the production graph's 20-tool inventory. Generate and compare the
  registered tool-name list instead of maintaining counts manually. `CLAUDE.md` also omits other
  current tools from its summary even where later prose mentions them.
- Its `kb_compress` wording attributes roughly 60–70% savings to format alone. Canonical measurement
  records about 18% versus grouped TTL and 29% versus flat triples; larger savings come from
  selecting a relevant subgraph. Separate selection savings from serialization savings.
- F6 points to old `src/lib/google/*` paths; current code lives under
  `src/lib/integrations/google`.
- It calls n8n sync complete. Server workflow/infrastructure may be operational, but graph
  upload/download and Currents application paths remain partially wired.
- It describes three MCP KBs; current setup creates six MCP graphs and seven Reckons workspace KBs.
- R5's client-side `.env` passphrase cannot authenticate access to a shared static deployment and
  mixes host access control, local device encryption, and published-graph authorization. Split the
  threat models: reverse-proxy/host auth, local vault encryption, and sharing access.
- The old Gist-publication design is no longer the same architecture as the newer graph-publishing
  work.
- `AUDIT.md` repeats the 20-tool, three-graph, completed-n8n, and every-prompt ethics claims; it also
  calls voice input a scaffold despite the current functional interface and names stale action
  vocabulary. It should be regenerated or labeled explicitly as a dated audit snapshot.

### Handoff/brief automation defects

- `scripts/brief.ts` formats an empty GitHub PR list as `#null → null: null`, making "no PR" look
  like a PR. Test the empty array before formatting.
- Its human report prints the pending queue total, but JSON output omits that total. The queue count
  therefore gets copied into prose and drifts. Put branch/ahead state, PR state, queue count, queue
  validity, and test evidence in the generated header.
- The current `HANDOFF.md` is over 1,300 lines, contains several `LATEST` headings, and retains public
  host addresses and private SSH key locations in tracked project history. Move old session detail
  to Git/history or a private operations document and keep this file to current state, decisions,
  blockers, and the next ordered actions.

### Council worksheet finding still worth tracking

`council-design.worksheet.json` decided that Poseidon's council verdict remains
`verifiable-by unknown` and belongs in provenance; the roadmap description reflects the decision
but still repeats it as an open question. Close the question when the graph is next edited.

`council-review.worksheet.json` contains one valid latent code-contract finding among considerable
model noise: `connectedComponents(adj, nodes)` can traverse to nodes outside the supplied `nodes`
set. The current production caller constructs adjacency and its complete node set together, so the
current caller is safe. The exported API should nevertheless restrict traversal, document that
`nodes` must be complete, or gain a subset test. Archive/ignore the generated worksheet once the
finding is represented durably.

### Verification performed during this audit

- Focused F136/scoring tests: **62/62 passed**.
- `npm run check`: **0 errors, 81 existing warnings in 21 files**.
- Graph lint: **0 errors, 5 warnings** as detailed above.
- Status-evidence: **1 failure**, the missing `tested-by` link above.
- No full test suite or live Ollama benchmark was run during this audit.

### Recommended execution order from this audit

1. **Control-plane/data integrity:** correct the counsel brief; make handoff facts generated; repair
   queue schema, routing, malformed-row retention, and artifact ignore/workspace policy.
2. **Finish F136 evidence:** fail loudly on missing benchmark results, score object shape and
   direction, use a mature vocabulary, and measure the structured production path.
3. **Wire F136 into production** only after that measurement is credible, then update the roadmap
   status and evidence.
4. **Build CLI-first human settlement** with explicit graph target and settler provenance. Keep
   model-callable MCP settlement a separate gated decision.
5. **Create a Shelly-specific orchestration benchmark** before choosing a local model or expanding
   action dispatch.
6. **Then choose between export-to-local-agent and additional CLI actions** from the smaller "Now"
   set, rather than treating the older prose below as a resolved priority.

---

## Older sessions (2026-07-16 → 2026-08-15) — `HANDOFF-ARCHIVE.md`

Everything before 2026-08-16 lives in [`HANDOFF-ARCHIVE.md`](HANDOFF-ARCHIVE.md), verbatim.
It was moved out on 2026-08-21: this file was 2,377 lines (~33k tokens) and CLAUDE.md makes
reading it the first act of every session, so closed sessions from a month ago were being
re-read forever. Measured cost before the split: **45.0M carried tokens across 14 reads**, the
single most expensive artifact in this project's context (`npm run offline:context`).

**Do not read the archive by default.** Grep it for a specific thing, or ask the graph —
`kb_search` / `kb_compress` hold what was actually decided, which is the part worth keeping.

**Keep this file short.** When you add a session section, move the oldest one to the archive.
