# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-07-18.** Branch: **`feat/archive-graph`** → **PR #119 open against `dev`**
(base verified). Continue F97 on that branch, or branch fresh off `dev` if #119 has merged.

## ▶ NEXT TASK (2026-07-18): F97 next phases — wire the archive core into the app

The PURE CORE is built, tested and merged into PR #119. What remains is the ADAPTER + UI layer.
Read `src/lib/rdf/archive.ts` first — it is fully commented and the design rationale is in the
roadmap under F97 `kpred:scope-decision`.

**Do NOT redesign the core.** These decisions are Matt's and are already recorded in
`static/reckons-roadmap.ttl` (F97):
- Archive is a **separate graph** named `"<parent> (archives)"`, shown on the graph settings page,
  linked to its parent by `stableId`. ON BY DEFAULT.
- The archive is an **edit journal**: events (delete/merge/prune/age-drop/revert) with actor +
  timestamp + a **FULL pre-operation snapshot**.
- Full snapshots were chosen knowing the storage cost. **Retention is load-bearing**, already
  implemented as `applyRetention` — wire it in, do not defer it.

**Build next, in this order:**
1. **Store adapter** — a thin layer over `kb-registry.ts` + `db.ts` that creates the `(archives)`
   graph on demand (`archiveGraphName`), writes `archiveEntities()` output to both graphs, and
   persists journal events via `eventToStatements`. The core is pure and returns `{kept, archived,
   event}` — the adapter owns the two-graph write and must handle partial failure explicitly.
2. **Settings-page display** — show the archive graph beside its parent in `/kb`.
3. **F97.3 restore-on-reference** — wire `findArchivedReferences` into the ingest path. This is a
   REQUIREMENT: without it every archive sweep seeds the next round of duplicates.
4. **F97.7 archive search**, **F97.5 time-travel**, **F97.4 recurrence** (reuse `recurrence.ts`).

`detectChurn` (F97.6) already routes into `analysis-advisor.ts` via `churningEntities` — the
advisor just needs the archive journal passed to it at the call site.

## ⚠ ALSO OPEN, NOT FIXED (2026-07-18)

- **Multi-tab sync — 3 CONFIRMED defects.** `tests/e2e/multi-session.test.ts` proves them; they are
  marked `test.fail()` so the suite is green. Root cause is ONE gap: no `storage` listener, no
  `BroadcastChannel`, no Dexie `liveQuery` anywhere in `src/`. A control test passes, so persistence
  is fine — it is purely live sync. Fixing it means deleting the `test.fail()` lines as each goes green.
- **`static/kbs/` — 18 untracked duplicate TTL dirs, all drifted, shipped into `build/`.** Triple-level
  diff done: 13 are safe supersets (extra content is regenerable `prov:wasDerivedFrom` /
  `dcterms:created` provenance). **5 need REAL merges — do not blind-delete:** `reckons-roadmap`
  (2976 copy-only / 1104 root-only), `docs-all` (copy is STALE: 931 root-only), `docs-architecture`
  (466 copy-only incl. real concepts), `default-graph` (324 triples, no root counterpart),
  `default-kb` (parses to 0 triples — empty/broken).
- **PWA precaches ~90MB**, ~67MB of it ONNX wasm (`vite.config.ts:33-34`, `globPatterns` includes
  `wasm`, 50MB cap). Matt chose: runtime-cache it + a **settings toggle** to pre-download for
  offline use. Needs a roadmap entry before building. Not started.
- **`reckons` MCP server is NOT configured** in this checkout (no `.mcp.json`; `claude mcp list`
  shows only claude.ai remotes) — CLAUDE.md's claim that it is configured is an overclaim. Also
  `node mcp-server/dist/index.js` dies with a raw `ENOENT ./knowledge.ttl` from `kb-reader.js:184`
  instead of a diagnostic, which is plausibly why nobody wired it up.
- **Playwright browsers were missing** after the `3c3c2ba` dep upgrade (`chromium_headless_shell-1228`);
  the whole e2e/visual suite could not run until `npx playwright install chromium`. Worth a CI guard.
- **81 a11y warnings** (0 errors), concentrated in `settings/turtle/+page.svelte` (14 unassociated
  `<label>`s) and `(app)/+page.svelte` (autofocus).

## ▶ AGREED BUT NOT STARTED (2026-07-18)

- **Analysis benchmark**: fixture-replay across the 5 `AnalysisType`s (`enrich`/`merge`/
  `entity-types`/`delete`/`align`), real Claude API but capped to cents per run, recording tokens/
  cost/latency/accept-rate. Intended as a per-PR regression gate, not a one-off study.
- **Instrumented task races** for real-world time savings: ~6 workflows run with Reckons.AI vs a
  scripted manual baseline under Playwright, measuring wall-clock, clicks and steps-to-answer.
  Per `kb:honest-status`, losses get recorded as loudly as wins.

## 🚀 PRODUCTION DEPLOYED (2026-07-17)

Matt pushed all changes to prod. The full pipeline ran: **#101 feat→dev**, **#106 dev→staging**,
**#107 staging→main** (all base-verified before merge). `main` HEAD carries this session's work;
**Cloudflare Pages deploy = success**, **CodeQL on main = green** (the in-branch security fixes
closed the alerts once they landed — as predicted; the PR-level red was a large-PR mis-attribution).
Reckons.AI is live. Matt has NOT done a full launch announcement (only a LinkedIn comment link).

**Post-deploy verified:** `align` green, offline script-tier 11/11 clean.

**⚠ Two workflows RED on main — PRE-EXISTING (failing the last 4 main runs, NOT caused by this
deploy), now recorded so they are not rediscovered:**
- **Extension Build & Sign** — fails at the `Build extension` / sign step in CI, though
  `npm run build:extension` succeeds LOCALLY (1.4s, sidepanel.js included). Likely a CI-env / AMO
  signing-secret issue (Matt's action if a secret). Not a code regression.
- **Safety Attestation** — fails at `Commit attestation` on main only (passes on staging). Git-push
  plumbing: the workflow commits the updated safety-log back to main and the commit/push step exits 1
  (probably unhandled "nothing to commit" or a token/permission issue). A small workflow-YAML fix.
  Do these on a fresh branch off dev.

## ✓ LANDED (2026-07-16): batch — footer, shelly mobile, source-validation, captures — commits `3c5f1c3`…`884ab50`

- **GitHub link** in the settings support footer. **Shelly chat header on mobile**: 3 tabs flex-split
  evenly between icon + close (was cramped). **F98 prune analysis** (`npm run prune`, applied: −17 dupes).
- **F100 source-validation** (`src/lib/rdf/source-validation.ts`, scaffolded): check a fact against the
  open web — corroborate + flag CONFLICT (verdict 'mixed' = the contradiction the graph can't self-see),
  surfaced for review never auto-resolved. Harness + 9 tests; live wiring (tavily+LLM→pending, setting +
  Pod mode) is remaining. **Captures:** kb:graph-db-connectors (F84.3, one SPARQL-GSP adapter → many
  stores), kb:personal-assistant (F99, "priority today" reckoning + ring/glasses profiles), kb:fiftyone
  (reference, multimodal thread). `npm run check` 0 errors.

## ✓ LANDED (2026-07-16): F84.1 roles + F80 p6 triage/backlog — commits `307b166`, `28c3ffd`

**Roles (F84.1, functional):** `src/lib/rdf/roles.ts` — descriptive identity metadata, customizable
like entity types (custom roles = RDF statements `rdf:type ktype:Role`). NOT RBAC — that's gated on
`kb:backend-services` (F84.2, speculative, paid tier, business model UNCERTAIN). Seeded `kb:matthew-roe`
(Owner Operator + Technical Solutions Architect). 6 tests. Optional node-panel UI deferred (Matt: "not
really affecting core experience currently").

**Triage/backlog (F80 p6, functional):** `scripts/agent/triage.ts` is the shared classifier
(rederivable/remediable/judgment) both the desk and orchestrator now use. The desk (`npm run interview`)
filters to `isDeskQuestion` at read time → **83 → 28, no data deleted**. `npm run backlog` ranks judgment
items by blocking then age. Emitters fixed (code-review + competitor-scan emit `suggestion`, not `question`).
**DECISION PENDING FOR MATT:** an explicit prune of the 28 pre-existing mis-typed `type:question` entries
(competitor-scan/code-review) — an agent must not auto-delete the shared queue; backup at
`$CLAUDE_JOB_DIR/tmp/pending.backup.jsonl` this session. The read-time filter already hides them, so the
prune is hygiene, not urgent.

## ✓ LANDED (2026-07-16): F80 phase 5 — the question desk — commit `4244b78`

`npm run desk` opens a SECOND terminal (a Claude Code side-chat, or a scripted interview)
that asks Matt the open questions agents left, whenever he isn't answering them in the web
UI, and keeps nudging him to open the graph view of the fact. `scripts/agent/interview.ts`
is the deterministic core (openQuestions / recordAnswer — writes the SAME knowledge.answers.jsonl
the UI writes); `scripts/agent/desk.sh` is the launcher. 9 tests pass; recorded as `kb:async-desk`
(functional). **Note: the queue currently has 83 open questions — mostly stale sweep findings
from 2026-07-12 (parse errors, urn:kabase typos); they want draining/triage, not just answering.**
Remaining on this: an entity-focus `?review=<iri>` deep-link — only `?kb=<graph>` exists in the
UI today (verified), so the desk links to the graph's Review tab and names the subject to find.
Also on F80: `kpred:landscape` records the Reckons.AI-vs-MAF/Strands framework analysis (graph-native
+ local-first + LLM-distrustful vs their LLM-driven/cloud-tied bet).

## ✓ LANDED (2026-07-16): F81 cadence right-size + parallel-GPU model — commit `31ac315`

Local-agent job cadence bumped to a few times/day (8h); F81 records opportunistic scheduling +
the two-3090Ti PARALLEL local-agent runner as its next build (`kpred:remaining`).

If you are a fresh session (local, cloud, resumed, or scheduled) and Matt says "continue",
this is where you continue from. Do not re-derive it; do not re-audit what is already audited.

## ✓ LANDED (2026-07-15): F91 phase-2 completion — commit `284a532`

The question-router throw-and-forget loop is COMMITTED and VERIFIED. Do not redo it. Approved
plan was `~/.claude/plans/glittery-singing-pine.md`. Decisions (Matt, 2026-07-15), now recorded
as `kpred:decided` on `kb:qr-throw-forget`: transport = reuse n8n + pub-sub (later); reach =
subscribed + opt-in; answers = pending + provenance, always reviewed; RBAC = finish local loop
first, F84 later.

Verified before commit: `npm run check` 0 errors, `npx vitest run` 956 pass (31 router/reach/
verifiability), `npm run align` green, `graph-lint` 0 errors (the dead-link check correctly
flagged the two NEW files until they were staged — it is git-aware). Roadmap updated in the same
commit: `kb:qr-throw-forget` scaffolded → **functional**, `kb:question-router` planned →
**in-progress**, both with honest-notes scoping the claim to the LOCAL loop.

**Still TODO (NOT done — genuinely remaining, honest scope):**
- **The "ask another graph" review-UI entry** (plan task #17). Phase-1 `remaining` also names
  this ("expose in review/reckoning UI as 'ask another graph'"). No UI yet exposes routing OR
  the opt-in consent marker — the marker is honoured but there is no way to SET it in-app.
- **Real cross-boundary transport.** Today one process's pending queue stands in for two graphs.
  n8n + pub-sub is the decided direction (later).
- **Phase 3 RBAC daisy-chain** (`kb:qr-rbac-chain`) — gated on F84.

Branch is **PR #101 → dev**. Push the commit; do not merge to `main`.

## AWAKEN OPUS TO ORCHESTRATE (Matt asked, session-limit)

On resume (unsnooze fires on limit-reset), after committing the above and draining the free
queue: **run `npm run orchestrate`** — triage the pending queue (re-derivable / remediable /
judgment), promote worthwhile drafts into `tasks.ttl`, and work the judgment residue. That is the
Opus-tier orchestration Matt wants resumed. The 13 standing offline jobs drain for free via the
runner before you spend a token.

## Recently landed (do not redo)

- **Dichotomy detection** (`src/lib/rdf/dichotomy.ts`) — one entity, two truths; CONFLICT
  (single-valued, one is wrong) vs natural DICHOTOMY (multi-valued, preserve). Filter beside
  hubs/islands, conflict count ⚠ on the chip. The stranded batch from the Bash outage is committed.
- **F91 question router phase 1** (`src/lib/rdf/question-router.ts`) — ranks which graph could
  answer a question by relatedness (knows-the-subject > predicate > neighbourhood overlap);
  `addressees()` thresholds so it routes, not broadcasts. Phases 2 (throw-and-forget across the
  F80 answer loop) and 3 (RBAC daisy-chain, per-hop provenance, gated on F84) are `planned`.
- **13 standing offline jobs** in `reckons-workspace/tasks.ttl` (evidence, safety, tests,
  reconcile, orchestrate, tokens, competitor discovery, deep visual testing). They drain via the
  `drain-queue` schedule → runner. NOTE the runner has slow tasks (test suites, build+serve smoke)
  so a full `npm run agent:run` can take minutes — fine for the autonomous runner, run with a
  generous timeout interactively or `--once`.
- **Ideas graph** (`reckons-workspace/ideas.ttl`) holds Matt's idea waves: meta-graph flows
  (feedback graph → roadmap, user-defined graph-to-graph flows, subscriber graphs, live-nodes
  auto-e2e), gamified full-screen review (dichotomy + Blender), story-mode-in-review. **These
  want to become roadmap FEATURES — promoting them is a user-authority act; ask Matt or leave staged.**

## Do this now — SPEND NO TOKENS BEFORE YOU HAVE TO

1. `git fetch && git checkout feat/work-tiering-ci` (open as **PR #101 → `dev`**)
2. **`npm run agent:run`** — drains the script-tier task queue (`reckons-workspace/tasks.ttl`).
   Deterministic, **zero tokens**. It writes its outcomes INTO the graph, so read
   `reckons-workspace/tasks.state.ttl` to see what it actually did. A task reported as
   `WAITING` is asking Matt something — leave it; it resumes by itself when he answers.
3. `npm run offline:script-tier` — the free checks (~40s, zero tokens).
4. `npm run align` — must be green. It **blocks CI**.
5. Only now start reasoning. Work the **Next up** list below, in order.

Everything under **Done** is committed and pushed. Do not redo it.

## The whole point of this session, in one line

**Route every task to the cheapest tier that can do it correctly** (script → local agent →
Opus). If you catch yourself doing what a script could do, stop and write the script — that
IS the work. And if you meet an ambiguity: **ASK** (`scripts/agent/ask.ts`), never guess. A
guess silently entered into a knowledge graph is worse than a stalled task — it is a lie the
graph will repeat in Matt's name.

## Read the mission first: `kb:mission` + `kb:thesis` in the roadmap graph

It is never about the tool. The knowledge needed to DECIDE is usually a few team members
away — a DISTANCE problem, not an information problem. A document records conclusions, not
the structure that produced them; two documents cannot be diffed for reasoning, two graphs
can.

**The thesis:** *an unverifiable claim, made by the party it benefits, is not evidence.*
Arrived at three separate times from three unrelated directions (a stated purpose does not
unlock a gate; a weak similarity does not justify a link; a source you control yourself is
not a source), which is why it is the thesis and not a rule.

**The invention is not what the graph stores — it is that the graph can hold the SHAPE OF
WHAT IS MISSING.** A partial fact (subject + predicate known, object `?`, plus what it
blocks) is the most useful node in the graph. You cannot ask a question you have not
discovered you have. This is why F80 (agents ask the graph, not the human) matters more
than it looks: it is the mission, not a workflow convenience.

## The theme of this session

**Token discipline (F74.3 work tiering).** Route every recurring task to the cheapest tier
that can do it correctly: script → local agent → Opus. Opus is for orchestration, hard
judgment, and code that lands. If you catch yourself doing what a script could do, stop and
write the script — that IS the work.

## Done (committed AND pushed — PR #101 → dev). Do not redo.

**The orchestration loop now closes end to end.** That is the headline; everything else served it.
The whole pipeline is: `npm run schedule` (reads schedules from TTL) → `reconcile` (drop resolved
findings) → `runner` (drain tasks, script + local-agent) → `orchestrate` (triage the residue for
Opus). Every stage reads and writes the graph; none of it costs a cloud token except the Opus
triage at the very end.

- **The task queue is a graph.** `src/lib/rdf/agent-task.ts` + `scripts/agent/runner.ts`.
  `npm run agent:run` drains `reckons-workspace/tasks.ttl`: claim (a LEASE, not a lock) →
  execute → **verify INDEPENDENTLY** → write the outcome back. A task with no `done-when` is
  REFUSED ("a wish, not a task"). Handles `script` AND `local-agent` tiers; a local-agent task
  with Ollama down WAITS (not fails). A recurring task (`kpred:every "7d"`) is never *done*, it
  is *due again*. An expired lease with no outcome is detected and requeued.
- **Schedules live in the graph** (`scripts/agent/schedule.ts`, `reckons-workspace/schedules.ttl`).
  `npm run schedule` reports what is due and runs it; the trigger (cron/systemd/unsnooze/human)
  reads the graph, not a crontab. Intervals, not cron — drain, do not schedule.
- **The orchestrator** (`npm run orchestrate`) splits the pending queue into RE-DERIVABLE (a
  script regenerates it — fix the source), REMEDIABLE (draft one task for the cluster), and
  JUDGMENT (Opus/Matt). Drafts are proposals, never auto-queued. Opus is the judgment tier and
  cannot be a script — this is the harness it runs inside.
- **`npm run reconcile`** drops queued findings whose deterministic check no longer fires. The
  queue was 18% ghosts (resolved graph-lint findings lingering); now 139 and every item is open.
- **A task can ASK instead of guessing.** It emits a partial fact naming what it needs and
  what it blocks, exits `42`, and the runner marks it **WAITING** — not done, not failed. It
  resumes by itself when Matt answers, in the review queue *or* via Shelly (both resolve the
  same fact). `MAX_ATTEMPTS` bounds it: patience is not infinite retry of a broken thing.
- **`kb_merge` MCP tool** — an orchestrator can now merge a sub-agent's graph. Proposals only;
  CONFLICTS sort first. Found 23 real ones on its first run (the roadmap thinks the MCP server
  has 10 tools; production says 20).
- **F88 verifiability axis** — `verifiable-by` (code|test|source|user|unknown) decides WHO may
  approve a fact. Code/tests never reach Matt. **Authority overrides verifiability**: roadmap
  and principles are his however checkable they are. Unclassified fails toward the human.
- **Review queue routes by gate**, ranked by TRANSITIVE blast radius. Defaults to "yours".
- **`npm run align` BLOCKS in CI** — the graph→site generators all had `--check` modes and none
  gated anything. `landing-features.ts` was HARD BROKEN (it could not regenerate at all).
- **Script tier BLOCKS in CI** (`--ci`). Docs generated from the graph (`docs-coding-workflow`).
  `claim-audit` sweeps hand-written copy for claims the graph denies. SRI on the Sveltia bundle.
  Both dependabot alerts closed. Filters ghost instead of deleting. CUDA repaired; Ollama 100% GPU.

## Next up (in priority order)

The orchestration loop is BUILT (schedule → reconcile → runner → orchestrate). What remains is
using it and extending it.

1. **Triage RAN (2026-07-15).** `npm run orchestrate` on a 186-item queue: **14 re-derivable**
   (all `graph-lint/predicate-economy` — a standing design nudge that fires every run; reconcile
   will NOT clear it, only naming real relations in the TTL or accepting it will), **0 remediable**,
   **172 judgment**. The judgment residue is dominated by MATT-authority / route-to-a-human
   clusters, not Opus grind: 54 branch-align/suggestion, 24 history-lessons/fix-without-test (a
   test-writing backlog — judgment which to write), 16 branch-align/status-update, 16
   claude-code/observation, 14 competitor-scan/candidate (his rule: the *judgment* stays human),
   12 alignment-sweep/question, plus smaller question clusters agents threw (runner/1,
   code-review/2, button-crawl/2, claude-code/8). **Not grinding these autonomously was deliberate:**
   a wrong answer written to the graph is a lie it repeats in Matt's name, and most of this queue
   is explicitly his. Next Opus pass: pick the small QUESTION clusters you can answer with
   certainty (they feed the F91 answer-loop), and propose graph edits for the predicate-economy 14.
   Also landed this session: `fix(runner)` Ollama-URL propagation (3893f05), competitor-scan
   honest-status declaration (aae682b).
   **The small QUESTION clusters are now RESOLVED (2026-07-15, commits ac3bdaa + 72f5a33):**
   answered the code-verified ones (runner = node process; `g` = source/provenance), rejected 3
   verified-false findings (2 local code-review false positives + the button-crawl "bookmarked(0)"
   which is correctly disabled at 0), and recorded Matt's design calls in the graph — a single
   MERGE BAND (auto >=0.90 / suggest 0.50-0.90 / below 0.50 nothing) now governs entity merge,
   predicate-sameness AND linking (superseded the 2026-07-13 ~0.80 link floor — conflict surfaced,
   not overwritten); PWA orientation portrait->any (+F34 must test both orientations); TTL/TriG
   split by USE (private export = TTL no publisher; publishing = TriG + owner/publisher REQUIRED).
   All `planned`/spec, marked not-yet-wired. What remains is the BIG judgment clusters
   (history-lessons 31, competitor-scan 18, graph-lint 14, alignment-sweep 12) — mostly Matt's.

   **AUTONOMOUS STRETCH (2026-07-15, "work unblocked roadmap by priority") — 4 features advanced,
   all with tested pure cores + honest status, forming one coherent REVIEW-AT-SCALE system:**
   - **F80.1 auto-merge** planned→scaffolded (3ee1cc6, 371b3f1): `merge-band.ts` (the one
     executable copy of the 0.9/0.5 band) + `pending-dedup.ts` (fold exact-dupe pending facts;
     semantic suggest tier injected) + wired into `drainAndImportPending` (within-batch, complete
     facts only — partials left alone so blocks/question isn't dropped).
   - **F52 control-model** planned→scaffolded (e977314): `agent-edit-boundary.ts` — the wall.
     `gateFactWrite` downgrades any agent attempt to settle a fact to a proposal; enforced via
     `addStatements({origin:'agent'})` on the drain path. Composes with F88.
   - **F53 review-attention** planned→scaffolded (5f3513a): `review-attention.ts` —
     `spotlightUserQueue` splits the F88 user lane into a capped spotlight (conflicts + decisions)
     and a quiet flow; over-cap contested items HELD BACK, never quieted.
   - **F83 graph-legibility** (in-progress, 156a17a): `entity-review.ts` — `groupPendingByEntity`
     condenses 1888 triple-rows to ~233 entity cards, each carrying its strongest F88 gate.
   These four COMPOSE, and now have a single FRONT DOOR: `review-pipeline.ts` `buildReviewPlan()`
   (dd25471) runs dedup → route (F88) → spotlight (F53) → entity cards (F83) and returns the whole
   plan; `reviewPlanSummary()` is the honest headline. Integration-tested end to end.
   `dedupeCompletePending()` is the ONE shared "exclude partials, fold dupes" rule (drain + pipeline
   both call it). A DRIFT GUARD (7d5e8bb) makes `merge-band.ts` fail if its constants diverge from
   the graph's decided thresholds. DOGFOODED: `npm run review:plan` (2227deb) runs the pipeline on
   the real 186-item queue → 57 entity cards, 7 decisions spotlighted; confirmed all 186 correctly
   route to the user lane (F88 fails unclassified toward the human — these are questions/observations
   with no code/test predicate). ~1005 tests; align green; all on PR #101.
   **NEXT SESSION, highest leverage: WIRE `buildReviewPlan` into the Review UI and watch it render**
   (moves F53/F83 scaffolded→functional with real evidence — needs a browser, which the headless
   autonomous env can't give). The plumbing is done and tested; only the render + observation remain.

   **STRETCH CONTINUED (still 2026-07-15) — 2 more features + the suggest tier made real:**
   - **F51 review-anchored-generation** planned→scaffolded (dd25c0b): `generation-grounding.ts`
     `validateGeneration()` — the MOAT, the grounding constraint: every generated sentence must
     cite >=1 statement and >=1 must be CONFIRMED; catches uncited/dangling/unconfirmed. The
     generation-side analog of `grounding.ts` (ingest passage-grounding). Enforcer built; the
     grounded GENERATOR (prose with per-sentence citations) + render-path wiring remain.
   - **F80.1 suggest tier now works OFFLINE** (1f2b18f): `lexical-similarity.ts` (token Jaccard,
     subject & object compared separately then min — so an identical subject can't inflate a
     different-object pair) gives the suggest tier a free similarity source; `buildReviewPlan` gained
     an optional `similarity` fn; `npm run review:plan` wires it and surfaces real near-dupes on the
     186-item queue. DOGFOODING CAUGHT A REAL BUG (subject-inflation), now fixed + regression-tested
     — the honest-verification discipline working.
   Running tally: **~1024 tests** (from 956 at session start), align green, ~20 commits on PR #101.
   The review-at-scale subsystem is COMPLETE and internally consistent; remaining is UI wiring.

   **UI WIRING DONE + BROWSER-VERIFIED (68357d5) — F53 scaffolded→FUNCTIONAL.** `buildReviewPlan`
   now drives `/review`'s incoming tab: honest headline + SPOTLIGHT strip (contested few) + pending
   facts grouped into per-entity CARDS (F83) with a by-entity/flat toggle; per-fact confirm/reject
   unchanged (SwipeCard extracted to a snippet). Proven end to end: the review e2e seeds a real
   ingest, opens /review, asserts entity-cards + headline + toggle + confirm reachable — **6/6
   review e2e pass** (`tests/e2e/review.test.ts`), 1030 unit tests, align green. The e2e harness
   works in this env (`npx playwright test tests/e2e/review.test.ts --project=desktop-chrome`), so
   UI can now be verified here after all. F49 also has a `functional` UI seam untouched; F51/F52
   remain logic-only. Remaining on F53: tenure-drift signal + surfacing the merge-suggest tier in
   this UI. F83 stays in-progress (canvas-side predicate/time filters still need UI).

   **2026-07-15 CONTINUED (a long live-driving + brainstorm session). MORE BUILT + VERIFIED:**
   - **F81 model-batching** (6f8d9af): tasks declare `kpred:model`; `orderForModelBatching` runs
     same-model local-agent tasks consecutively so Ollama stops reload-thrashing. 5 tests.
   - **Ground-first agents** (8df8ee2): `scripts/offline/lib/graph-grounding.ts` — agents QUERY the
     graph (reverse has-file/tested-by → owning feature + purpose) before judging; wired into
     `code-review.ts`, verified with a live qwen3-coder run. 7 tests.
   - **4 review-graph bugs fixed** (3950892, 61fe7cb): overlay node-details (overlay-aware
     `panelDetails`), one 2D/3D toggle per mode, 3D labels (were a no-op `onlabelsmove`), and
     `wasDerivedFrom` UUID nodes (PROV-O now `isMetaPredicate` → suppressed from 2D/3D).
   - **F92 GraphLabels** (2a9f641): first shared piece — one label overlay both `/` and `/review`
     mount (main's asset thumbnail + leap badge passed as snippets). Drift killed.
   - **Automated visual verification** (a60baa9): `tests/visual/user-stories/graph-labels.test.ts`
     — seeds a graph, screenshots, DOM-asserts the GraphLabels overlays (reliable gate: 27 labels,
     alex/jordan/lake george) + OCRs the screenshot (proves the pixel pipeline; tiny-label OCR is
     flaky → logged not gated). **This removes the "can't verify UI headlessly" excuse — the e2e AND
     the visual/OCR harness both work in this env.** ~1042 tests.

   **BIG IDEA BACKLOG captured this session (Matt streaming; all in the roadmap, NONE built yet):**
   F92 (one canvas, adaptive LOD, progressive/ghost render + flicker-vs-LOD risk; review is a MODE
   with own panels+Shelly settings), F93 (video frame-sampling + local video models + auto-cut/
   MoviePy), F94 (**MCP/CLI follow leaps — cross-graph query with bounded leap-depth + per-hop
   provenance**), F95 (Shelly+MCP relation-matrix builder, confirm-before-create), F96 (Shelly as
   graph-control persona + quick graph settings All/Sets/Default/Settings). Matt picks the build
   target; the graph holds the plan. Next F92 shared piece = the node-details panel (bigger: main's
   is rich/editable, review's read-only+chat).
2. **F90 Blender** (planned) — headless Blender over MCP. The trap is in the roadmap:
   **Blender renders a black frame and exits 0.** First domain where `done-when` cannot be a
   passing test — exactly what F88's `verifiable-by` exists for (deterministic image check →
   VLM proposal → user, in that order).
3. **Wire the review queue's gate routing to F88's authority rules end-to-end** — the routing
   is built (`review-routing.ts`) and defaults to "yours"; confirm the UI honours it against a
   real pending queue (I unit-tested it but did not watch it render loaded).
4. **F27 / F34 / F79 / F83** — still `in-progress`/`scaffolded`. `npm run brief` reads their real
   status from the graph.

## The pattern that ran through this whole session (read before you trust a check)

Nearly every bug this session was a CHECK THAT WAS CONFIDENTLY WRONG — and I made the mistake
myself repeatedly, hours apart: `published-graph-guard` banned the product's own vocabulary;
`graph-lint` counted errors it refused to print, missed conflicting statuses, and asked "is this
on my disk" instead of "is this in the repo"; the digest generator was non-deterministic; the
reconciler read the wrong JSON key and nearly deleted live findings. **Determinism buys "the rule
fired", never "the rule was right."** Test the checker against a known-bad input before trusting
it — every one of these was caught only by doing that, and shipped only when I didn't.

## Decisions that are MATT'S, not yours

- **`kb:adopt-user-owned-sync`** — the biggest finding of the competitive scan. SiYuan (45k
  stars) ships **self-hosted** sync and stays privacy-first; RxDB (Apache-2.0) replicates to
  a backend the *user* supplies. We wrote "no sync" when we meant "no sync **through us**".
  `kb:avoid-hosted-sync` now scopes itself to the OPERATOR. Whether to build user-owned sync
  is Matt's call. Do not decide it for him.
- **`kb:adopt-sonnet-bucket`** — F74.3 treats "Opus" as one rung when it is three. Anthropic's
  own benchmarks put an orchestrator + Sonnet workers at 96% of quality for 46% of cost, and
  subscriptions carry an *additional* Sonnet-only weekly bucket. Our ladder has no account of
  cloud-to-cloud tiering. Whether to restructure it is Matt's call.
- **Third-party plug-in boundary.** Matt's rule (2026-07-14): sideload separate projects where
  complexity is high and the license allows; **never for core-critical features**; the user
  must confirm they understand the code is not controlled by Reckons.AI. Sveltia is the
  existing precedent (below). Not yet written into the roadmap TTL — do that before building.

## Known-bad, already recorded — do not "discover" this again

- **RESOLVED — and it was never true.** An earlier entry here said the published graph
  (`static/knowledge.ttl`) carried "166 test-harness terms". **That finding was false.**
  `published-graph-guard` banned `urn:reckons:story/`, which is the PRODUCT'S OWN guided-story
  vocabulary (`src/lib/rdf/story.ts`; used by the landing page and TurtleChatPanel; declared in
  `reckons-production.ttl`). The real harness namespace is `urn:reckons:test/` and it appears
  **zero** times. The graph was clean all along. The guard is fixed, the stale header count was
  a real finding and is fixed (1032 → 3096), and **the CI script tier is now BLOCKING** (`--ci`).
  Do not "rediscover" the debris — there is none.
- **The force simulation never converges.** Nodes drift continuously — a control run with no
  filter touched showed 234/336 nodes moving >12px in 2.5s. Do NOT write position-invariance
  tests; they measure noise and will fail whether or not the code is right. See the comment
  in `tests/visual/user-stories/filter-ghosting.test.ts`.
- **111 pending facts** are queued in `reckons-workspace/knowledge.pending.jsonl` awaiting
  triage in the Review tab. Triaging that queue is Opus tier-3 work — filling it is what the
  other two tiers are for.

## How third-party code is plugged in (the Sveltia precedent)

Matt asked "how is this done anyway?" — the answer, for whoever extends it:

`static/admin/index.html` is a **standalone HTML document** served at `/admin`, *outside* the
SvelteKit app shell. It loads `@sveltia/cms` from a **version-pinned CDN URL with an SRI
hash**, is **not an npm dependency**, and is **not vendored or forked**. The app never
imports a line of its code.

The integration contract is **a file format** — markdown + frontmatter in `content/` — **not
a code API**. That is what makes it safe to plug in: if `/admin` vanishes, the app is
unaffected, because the graph is the source of truth and Sveltia is only an optional editor
over generated markdown.

Rules for the next one:
- License must allow it (`kpred:copy-permitted`; `competitor-scan.ts` enforces this).
- **Never for core-critical features.**
- The user confirms they understand the code is not controlled by Reckons.AI.
- Pin the version AND an SRI hash computed from the **npm tarball**, never from the CDN
  alone — hashing whatever the CDN hands you faithfully pins an attacker's bytes.

## unsnooze (auto-resume) — ARMED as of 2026-07-14

`saaranshM/unsnooze` (MIT, license verified) auto-resumes a session that stopped on a usage
limit. It is installed and the revival path is live:

- unsnooze 1.10.0, global npm install
- `StopFailure` hook in `~/.claude/settings.json` (backup: `settings.json.unsnooze-bak`)
- shell wrappers for `claude`/`codex` in `~/.bashrc`
- daemon running; `tmux 3.4` present, so there is a pane to revive INTO
- `resumeMessages.claude` points a woken session at **this file**, then
  `npm run offline:script-tier`, then the Next-up list, and restates the CLAUDE.md rules
  (graphs are the plan; PRs target `dev`, never `main`; cheapest tier first)

**The one thing NOT verified:** whether the hook applies to a session that was ALREADY
RUNNING when the hook was installed. It was installed mid-session on 2026-07-14, and Claude
Code may only read hooks at session start. Sessions started afterwards are definitely
covered. Do not assume the auto-resume caught a session — check `unsnooze status`.

**This file remains the real continuation mechanism.** It needs no daemon, no hook, and no
multiplexer, and it works when unsnooze does not.

### Environment note — the CUDA repair (2026-07-14)

`apt` was wedged and could install nothing (tmux included). Cause: NVIDIA's CUDA 13.1 debs
changed `/usr/local/cuda-13.1/lib64` and `/include` from real DIRECTORIES into SYMLINKS
(`-> targets/x86_64-linux/…`), and dpkg refuses to let one package replace a directory another
package claims with a symlink. A packaging-transition bug, not local corruption.

Fixed with `sudo apt -o Dpkg::Options::="--force-overwrite" --fix-broken install -y`, which is
safe here because every conflicting package belongs to the same CUDA toolkit and the conflict
was only in dpkg's ownership database. Toolkit restored (`nvcc` works, symlinks in place), zero
packages left in `iU`. The GPU driver was never involved — both RTX 3090s and Ollama stayed up
throughout. If `apt` wedges this way again, this is the fix.
