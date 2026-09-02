# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-09-02.** Working branch: `fix/cascade-real-graph` (3 commits, **unpushed,
no PR** — Matt's call). PRs target `dev`. The branch tracks `origin/dev` directly, so a bare
`git push` would push to dev — always `git push origin HEAD:refs/heads/<branch>`.

## ▶ SESSION 2026-09-02 (latest) — the graph audit, and the chain measured composed

Branch `fix/cascade-real-graph` off `dev`, 3 commits, **not pushed and no PR opened** —
Matt's call. 86 files / 1,397 rdf tests, svelte-check 0/0, graph-lint 0 errors.

### ⚠ UNRELATED AND URGENT: `nvme1n1` SMART health FAILED
`host-health` reports `critical_warning 0x9`, `available_spare 0%` (threshold 10%). The drive
is failing NOW. Matt said he will "look at drive RMA and camera re-network later" — it is
acknowledged, not fixed. `exposure` also flags port 8000 listening on all interfaces.

### THE GRAPH AUDIT — it does not save context the way the ledger claims
- **102 graph queries EVER** (79 reads + 23 writes) against 3,652 file-touching calls. Graph
  share of context 3.6%, of carry 6.6% (was 1.1%/1.7% in August — tripled, from near-zero).
- **Head-to-head, kb_compress is 3x MORE expensive than grep for a KNOWN entity**: 1,950
  tokens vs 660. Its value is DISCOVERY, not retrieval. `graph-economics` claims 28.0K saved
  per query against a 30K baseline the job itself flags as never measured — do not quote it.
- **What the graph does earn: 118K tokens of avoided rework**, 5 features not rebuilt under new
  names. Matt: *"the avoided rework is the win for sure."* That is the plan working, not
  compression. `npm run ab:benchmark` — the experiment that would settle it — STILL never run.

### WHY THE PENDING-FACT SUMMARY NEVER LANDED — root-caused, three layers
1. **Five summaries, none of which summarizes the facts.** `reviewTreeSummary`,
   `reviewPlanSummary`, `attentionSummary`, `routingSummary`, `reanalysisSummary` all count
   QUEUE SHAPE ("12 decisions open; 3 contested"). None says what the facts CLAIM.
2. **The harness measured the FILE, not the graph — third instance.** `read-graph.ts` mapped
   raw quads 1:1, so an app-EXPORTED graph read 2,295 where the file declares 217 (10.6x —
   it counted the reification the importer folds away), and stamped every statement with the
   TTL's own path as sourceId. Result: ONE question proposing to settle 944 facts, and 0 facts
   left for the agent tier. Invisible on `reckons-roadmap.ttl`, which is what the job defaults
   to. Fixed by delegating to the app's own `importTurtleFull`.
3. **Prompt and validator disagreed on the vocabulary, pinning yield at 0% BY CONSTRUCTION.**
   `aggregationRequest` taught `kb:`/`kpred:` shorthand; the validator accepted full IRIs only.
   A model echoing what it was shown was rejected every time. **Yield 0% → 100%** once fixed.

After the fixes, on the real Pebble notes: facts 2,295→217 · clusters 1→33 · 944.0→4.5 per
question · agent input 0→16. It now produces a real question: *"Is Orange Logic an enterprise
dam?" settles 4 facts.* (The transcription damage survives — should be **DAM**.)

### THE CHAIN, MEASURED COMPOSED — `npm run` → `scripts/offline/extraction-chain.ts`
Every stage had passing unit tests and NOTHING measured them composed, which is exactly where
both bugs above lived. New script-tier job + `tests/fixtures/extraction-chain.ttl` (synthetic —
the repo is PUBLIC and `reckons-workspace/kbs/*` is gitignored, so Matt's notes stay local).

**Baseline on the real corpus, published before any strategy is added to beat it:**
`217 statements · 32 entities · typing 0 of 16 proposable · hierarchy 0 of 32 placed ·
aggregate 33 batch questions over 148 BOOKKEEPING facts · tree 0 DECISIONS, 53 orphans.`

**Two of five stages contribute NOTHING.** Typing proposes 0 types because no built-in type
carries the predicates a dictated note produces (F149's rdfs:domain gap from the other end).
Hierarchy places 0 because extraction emits no `skos:broader` at all. No types + no parents =
no structure = every claim lands as an orphan and review degrades to a flat list. **That is the
reported symptom, measured.**

### CO-HYPONYMS — the seam closed (`src/lib/rdf/co-hyponyms.ts`, 10 tests)
One lexical signal, two opposite readings, and only the destructive one ran:
`node attribute {name,value,type,...}` scored 0.85 to vocabulary-repair, which offered to MERGE
them. A shared head with DIFFERENT tails is positive evidence they are DIFFERENT things.
`areCoHyponyms()` withdraws any repair between two members of one sibling group.
**Real corpus: suspects 8→1, 10 destructive merges withdrawn, 6 of 32 entities would be placed.**

Also fixed: **vocabulary-repair no longer merges identifiers differing only in digits.**
`phoneticKey` strips digits, so all 14 note ids keyed alike and scored 12 confident FALSE
repairs — and a repair merges entities, destroying the provenance link to the note.

**HONEST LIMIT, pinned by a test: PROPOSING IS NOT PLACING.** Nothing in the app calls
`proposeCoHyponyms`; it runs only in the offline harness. Hierarchy still places 0 of 32 and the
tree still has 0 decisions open. Do not report "6 of 32 would be placed" as "placed".

### KNOWN-GOOD, do not re-derive
- **`triple-shape.ts` WORKS.** All 5 collapsed subjects (`orange-logic-is-an-enterprise-dam`
  etc.) are caught by `looksLikeProposition`. The 3 still in the notes graph are LEGACY,
  extracted before the guard landed. Not a broken control — do not "fix" it.
- **There is no `repair` or `hierarchy` stage in `ExtractionStageName`** (route/extract/validate/
  ground/normalize/type/archive/diff/persist). Vocabulary repair lives beside the pipeline in the
  note path; hierarchy is used only by `page.ts` for rendering. That is the STRUCTURAL reason
  neither reaches the decision tree.
- **Extracted entities are often OBJECTS ONLY.** All six `node-attribute-*` entities never
  appear as a subject. A stage that walks subjects only sees a fraction of the graph — this cost
  one wrong "no groups found" result.

### Next, in order
1. Wire `proposeCoHyponyms` into the pipeline as a stage and surface each group as ONE review
   question. This is what moves the tree off 0 decisions.
2. The scoring half of F146 phase 1: a corpus of raw note TEXT with hand-checked expected
   triples, and `extraction-score.ts`. The chain harness measures graph SHAPE; it cannot measure
   extraction ACCURACY without ground truth. **This gates every "extraction got better" claim.**
3. Then the content summary — what the pending facts SAY, which is still unbuilt. The five
   counters remain the only summaries.

---


## ▶ SESSION 2026-08-29 — honor 3D, and make voice truly opt-in

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

## ▶ SESSION 2026-08-28 — the bridge, the schedule, and eight standing jobs

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

## Older sessions (2026-07-16 → 2026-08-15) — `HANDOFF-ARCHIVE.md`

Everything before 2026-08-16 lives in [`HANDOFF-ARCHIVE.md`](HANDOFF-ARCHIVE.md), verbatim.
It was moved out on 2026-08-21: this file was 2,377 lines (~33k tokens) and CLAUDE.md makes
reading it the first act of every session, so closed sessions from a month ago were being
re-read forever. Measured cost before the split: **45.0M carried tokens across 14 reads**, the
single most expensive artifact in this project's context (`npm run offline:context`).

**Do not read the archive by default.** Grep it for a specific thing, or ask the graph —
`kb_search` / `kb_compress` hold what was actually decided, which is the part worth keeping.

**Keep this file short.** When you add a session section, move the oldest one to the archive.
