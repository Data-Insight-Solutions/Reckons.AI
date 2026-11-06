# Handoff — read this first if you are picking up mid-stream

Everything before 2026-10-28 is in `HANDOFF-ARCHIVE.md`, verbatim (top section). Grep it for history;
the graph holds what was decided.

## 2026-11-06 — F93.1 frame sampling, delegated (local deputy, qwen3.8-160k — PROPOSAL, not yet reviewed)

**Worktree `.claude/worktrees/f275-libs`, branch `agent/local-f93-frames` (based on feat/f275-demo-videos).**
This is the F93.1 deputy job the 2026-11-06 entry says retries itself — it ran and finished 2026-11-06
(2026-11-06 by local time). Committed on the branch, **not pushed**; the commit is a PROPOSAL for the
Sonnet overseer + Opus triage, per the ladder.

**Done (all four done-tests green on this branch):**
- New `tests/visual/vision-frames.ts` — the shared sampler: `probeDurationMs`, `cadence`,
  `sampleFrames` (one `-ss` seek per time, 96-wide grey rawvideo by default, exact `width`/`height`
  when asked, optional full-size PNG per time), and the frame rules `isBlank`, `uniformMargins`,
  `hasMargins`, `meanAbsDiff`. A seek past the last frame re-seeks with a DOUBLING step, which provably
  lands on the last frame for any frame rate (a fixed 100 ms step failed on a 5 fps clip — that was the
  one test that fought me).
- `tests/visual/vision-frames.test.ts` — 19 tests, all the F93.1 done-tests: frames at the asked times
  within one frame, padded video has margins / unpadded doesn't, black is blank, and asset-checks'
  motion rebuilt on the sampler gives the SAME numbers on the committed clips
  (carved-turtle 0.2061, lighthouse-island 0.0543).
- `scripts/content/asset-checks.ts` — `checkVideo` now reads first/last frame via
  `sampleFrames` + `meanAbsDiff` (64x64); its private ffmpeg read is gone; `judgeVideo` and its
  thresholds are untouched; results identical (pinned by the test above).
- `static/reckons-roadmap.ttl` — `kb:video-frame-sampling` → `scaffolded` (NOT `functional` — the brief
  says Opus verifies the promotion), plus `kpred:has-file` and `kpred:tested-by`.

**Done-test output (2026-11-06, on this branch):**
- `npx vitest run tests/visual/vision-frames.test.ts scripts/content` → 14 files, **238 passed**.
- `npx svelte-check --threshold error` → **0 errors**, 4462 files.
- `npx tsx scripts/offline/graph-lint.ts` → **0 errors**, 15 warnings (all pre-existing: prefix-drift,
  reinvented-term, predicate-economy, 3 missing descriptions — none on kb:video-frame-sampling).
- `npx tsx scripts/offline/run-all.ts --blocking --ci` → **9/9 clean** (published-graph-guard,
  commit-trailers, version-align, test-workflow-check, release-review-space, codebase-coverage,
  branch-ancestry, term-ratchet, ui-terms).

**Unverified / for the reviewer:**
- Status is `scaffolded`, not `functional` — deliberately, per the brief.
- `checkVideo` import direction is script → `tests/visual/`: the brief put the shared sampler in
  tests/ and required asset-checks to use it; flag if you want the sampler moved to `src/lib/` or
  `scripts/content/` instead.
- The clamp re-seek costs extra ffmpeg calls only when the asked time is in the gap after the last
  frame (≤ log₂(duration/100 ms) attempts); never on a normal seek.
- I did not run the full e2e suite or a demo render — that is outside the brief's non-goals.
- Scratch dir `.f93-tmp/` was removed; nothing else was touched (git status: the 4 files above only).

**Decisions (none were Matt's to make here):** the brief was fully specified; the only judgment call I
took was the doubling-step clamp (any alternative — probing fps, stepping by a guessed frame interval —
was strictly more fragile). If you disagree, it is one function to change.

## 2026-11-06 — START HERE: v0.2.7.1 shipped; v0.2.8 re-cut as the assets and demos release (Claude Code, Opus)

**Shipped.** v0.2.7.1 reached production 2026-11-06 03:15 UTC (#597 → staging, #599 docs gate, #598
staging → main, merged by Matt). It carries only F58.9.17: the asset generation setup-and-test page per
operating system (reckons.ai/docs/features/generation-setup, checked live), gen-setup.sh for Apple
Silicon (Metal sd.cpp and Brush, SHA-256 pinned; no TripoSplat), and the runner fix that would have held
every job on a Mac for want of nvidia-smi. **Nothing has run on a Mac**; Matt's friend is the first tester.
The same changes reached dev through #595 (merged).

**Matt decided (2026-11-06):** v0.2.8 is re-cut as THE ASSETS AND DEMOS RELEASE; the 14 unstarted
0.2.8 features moved to v0.2.9. The job plan is in the roadmap (planning PR): F275.8.1 bank Hume lines
before 2026-11-13 (Hume TTS/EVI end that day), F275.8.2 local TTS bench (Qwen3-TTS VoiceDesign,
Chatterbox, VibeVoice), F275.11-.20 (LinkedIn cut, subject zoom, cut loading screens, demo scripts,
fast-forward badge, music bed, loudness, thumbnail, Matt's voice, two blocking app bugs), F58.9.19-.20
(showcase assets, "one prompt, every asset" example), F223.6-.8 (reckon an asset, a composite at its
cheapest layer, review of the new version). F275.21 asks Hume Audio Decisions for measured voice naturalness (Matt shared its coding-agent page; it says
nothing about the TTS/EVI shutdown, so check it continues). Also planned earlier the same day: F275.9 composite asset,
F275.10 demo QA, F93.1 frame sampling, F223.5 proposal outcome assets, F283 Open in (ArtCraft), F117.1-.4
service suggestions, F58.9.18 better video.

**Demo pipeline (F275, #592):** `npm run demo:render -- --workflow=generated-assets` renders a narrated
1920x1080 MP4 with title and end cards (Hume credit on screen), captions inside the MP4, a drawn cursor
that scrolls and glides to each click, lead-in questions (Matt: "propose thought provoking questions
right before a decent delay"), each line held on its subject, silences over 5 s fast-forwarded (listed in
the receipt). Output goes to ~/Videos/reckons-demos/ (snap VLC cannot read hidden folders). Latest:
~/Videos/reckons-demos/generated-assets/2026-11-06T01-59-14-255Z/ (128 s), sent to the tester.

**Next actions, in order:**
1. Merged into dev 2026-11-06: #593 (F283 plan), #594 (v0.2.7 production), #595 (Mac setup), #600 (RAM guard).
   #592 (F275 demos + this 0.2.8 plan) waits on CI; its E2E can fail on the flaky Shelly chain test (F275.20); re-run, then merge.
2. **Before 2026-11-13:** write and get Matt's approval for every 0.2.8 demo line, then
   `--narrate-only` to bank them in the Hume cache (F275.8.1).
3. The queue worker is Matt's `npm run agent:watch` terminal (started 2026-11-05 ~21:50 CST, old RAM guard).
   Matt restarts it; then `queue.ts resume`. The failed F93.1 deputy job retries by itself (brief in the planning PR; worktree .claude/worktrees/f275-libs,
   branch agent/local-f93-frames). A Sonnet overseer reviews every deputy branch (Matt, 2026-11-05).
4. Deputy-ready jobs with full job specs (`npm run brief -- --entity=kb:<slug>`): kb:demo-fast-forward-badge,
   kb:demo-loudness, kb:video-frame-sampling.

**Found today, not fixed:**
- Search re-navigation loop at a 1920x1080 viewport (F275.20; filed as a known issue on search-bar).
- The RAM guard stopped a healthy load (mmap disabled under host memory pressure); fixed in #600 (merged),
  not yet verified live: it needs the worker restarted.
- Ollama's CUDA discovery can time out at service start and fall back to Vulkan (2026-11-05 12:47 CST);
  restart and check `library=CUDA` in the journal.
- The naming ratchet is over baseline on dev (interfaces +41 from the #587 batch); filed for Matt
  (interface vs type is undecided).

## 2026-11-04 (evening) — START HERE: everything open merged; asset QA loop in (Claude Code, Opus)

**Merged into dev today (verified as one tree, #587, CI 16/16 green at 4ce0a5f7, dev a1a46707):** #585 queue
RAM guard; then #486, #533, #534, #501, #513, #536, #527, #586 (F281 asset QA loop), #473, #375, #413, #539 (jobs graph
is the source; jobs.json deleted). Closed: #532 (stale handoff), #538 (superseded). Cross-PR conflicts and how
they were resolved are in #587's description.

**The 12:39 CST crash was Ollama, not Chrome**: llama-server started without CUDA and loaded ~17 GB into RAM
(evidence on `kb:queue-ram-guard`, F74.11). The queue is RESUMED and guarded.

- **Done:** the systemd-oomd / MemoryMax drop-in for ollama.service, applied by Matt and verified 2026-11-04 evening (details on `kb:queue-ram-guard`).
- **Matt, numbering:** collisions renumbered — taxonomy-current F263->F280, bench review F183.3->F183.5,
  local-overseer-model F268->F282.
- **#527 removed the session-heartbeat gate** (Matt, 2026-10-23): the queue worker now runs jobs without an active
  Claude session. Expect jobs to start whenever the worker is up.
- **F281 asset QA loop:** checks (image, video, splat, PDF, SVG), qwen2.5vl review as advice, reseed-and-keep-best
  in the generation runner, `npm run asset:qa -- <file>`. NEXT: a bench of the vision reviewer on labelled
  generated assets (it rejected a bad page with the wrong defect names, and missed a style mismatch), then F281.4
  page remedies once the F277 layout engine exists, and F281.5 (QA verdict in review).
- **Local-only e2e failure:** `generated-assets-story.test.ts:220` (Shelly queues a chain) fails on this machine,
  also on #527's own branch, and passes in CI. Not chased.
- **Still open:** #502 (vitest 5, mcp-server) and #583 (22 dev deps) — major bumps failing CI; #562 waits on
  Dependabot's transformers exclusion.

## 2026-11-04 (early) — START HERE: overnight queue triaged and merged (Claude Code, Opus)

**Done (each checked as stated, 2026-11-04 ~07:00 UTC).** #556 (v0.2.7) reached staging 01:59 UTC,
which unfroze dev. Merged into dev: the held PRs #565 (MCP serves the main checkout's build from
worktrees, the cause of every deputy's CONNECTION_CLOSED), #566, #554, #564, #567, #559, #561; and
six overnight deputy branches, each reviewed by a Sonnet overseer against its brief's done-tests:
#568 ollama-default, #569 import-mixed, #570 typing-undeclared, #571 typing-llm-custom,
#572 ratchet-paths, #573 dead-weight-alias. #574 fixed the term ratchet (below).

**What went wrong, so it is not repeated:**
- Two deputy reports said "run-all 9/9" when codebase-coverage was failing (new test file unlinked:
  #569, #571). The overseer caught both. Read deputy "all green" lines as unverified.
- #569 broke e2e `sync-preservation`: the new unrecorded-triple import turned the sync layer's
  `urn:kbase:asset/*` reference lines into pending facts. Fixed (b88588d5) by excluding that
  namespace; legacy icon2d/glbModel predicates still import as statements.
- Merging #568-#573 back to back, each green alone, put dev over the "graph" term ratchet
  (3281 vs 3279) and turned dev's script tier red. #574 reworded six uses; no baseline raised.
  When landing several PRs, re-run term-usage on the combined tree between merges.

**Still open:**
- **Matt:** v0.2.7 is on staging; no staging → main PR exists yet. Claude can open one for him.
- **Matt:** #568 now replaces a chosen Ollama model that is not installed with the best installed
  one, as its brief asked; only the ingest ledger shows the swap. Two-line change if he wants an
  explicit choice to fail loudly instead.
- #537 Triple Check: dev merged in (6ca52752); still not reviewed (4.3k lines). The merge moved
  `settings/device` onto SettingsHeader — needs a visual check. Two `dependency-overrides` test
  failures seen locally are probably that worktree's stale node_modules; CI decides.
- Queue: night-queue-chains running (started 06:08 UTC, on a worktree fast-forwarded to include
  #565), then night-job-plan-space, then the two gpt-oss benches. Triage both deputy branches the
  same way when they finish.
- Review queue: one batch of 5 dead-weight sweep questions, all deferred to Matt (no claim to
  check). Suggestion filed on job-dead-weight: drop symbols that no longer exist before asking.
  docs-expand is held by the backlog limit (62 unreviewed > 50), by design.

## 2026-11-03 (evening) — review the overnight deputy queue (Claude Code, Opus) — DONE 2026-11-04, see above

**Your first job is triage, not new work.** Eight local deputy jobs (qwen3.8) were queued 2026-11-03
about 20:00 CST to run overnight, one at a time, each on its own `agent/local-*` branch in its own
worktree under `.claude/worktrees/`. None is pushed. For each: read the job log
(`~/.local/state/reckons/jobs/night-*.log`), check the branch head (a job can exit 0 with nothing
committed; the queue records exit 0 as "passed"), run its done-tests yourself, then push and open a
PR to dev, or reject it out loud. A Sonnet overseer only for the importer job (core code).

| Priority | Branch | Fixes | Graph note |
|---|---|---|---|
| 10 | `agent/local-ollama-default` | default Ollama model is bare `llama3.2` (fails without `:3b`); resolve installed tags and pick the best installed model by this machine's benches (mistral-small3.2:24b: 0 invented facts) | Matt, 2026-11-03 |
| 9 | `agent/local-import-mixed` | import-ttl drops plain triples in annotated files; parseAssetRefs matches only full-IRI lines | drift-warning on workspace-sync |
| 8 | `agent/local-typing-undeclared` | surveyTypes counts undeclared rdf:type as typed; "a audience" | drift-warning on entity-typing |
| 7 | `agent/local-typing-llm-custom` | LLM entity-types prompt ignores a space's custom types | same note |
| 6 | `agent/local-ratchet-paths` | term-usage path exemption too loose | suggestion on term-ratchet |
| 5 | `agent/local-dead-weight-alias` | dead-weight.ts misses `$lib` imports | drift-warning on job-dead-weight |
| 4 | `agent/local-queue-chains` | `queue.ts add --after=<job>` chains; a deputy job whose branch head did not move is recorded `no-commit`, not `passed` | Matt, 2026-11-03: "craft local job chains" |
| 3 | `agent/local-job-plan-space` | the queue written as a real, annotated `job-plan` space in the app's workspace every 10 min, so the plan is visible with no Claude tokens | Matt, 2026-11-03 |
| -1, -2 | gpt-oss:120b benches | orchestrator, and overseer at 32k context x3; need 24 GB free RAM, give up after 4 h | compare with the 2026-10-28 table |

**Dev is frozen** until Matt merges #556 (dev to staging, v0.2.7; CI green). Held PRs, all base dev,
merge only after #556: #559 (v0.2.9 plan), #561 (deputy env secrets), #564 (F274.4.1, stacked on
#554), #565 (MCP from worktrees), #566 (F277 asset matrix and F278 hub assets plan), and this one.
Merged into dev today: #558 (v0.2.7 closeout), #560 (glob/minimatch advisories). Triple Check #537
has its e2e fix and href/redirect hardening pushed; CI not re-checked since.

**Asset-generation demo.** The first real use of F277 is a private community-program space kept
outside this repository, with its own repo and its own `HANDOFF.md` (path in Matt's private notes,
not here). Two app bugs found there are the top two overnight jobs. Nothing from it belongs here.

**Matt decides:** F277.5 logo source (form upload recommended, or web search); F278 on by default or
opt-in per space; and the open questions recorded on F277 and F278 in the roadmap.

## 2026-11-01 — v0.2.7 closeout and demo research (Codex, reviewed by Claude Code 2026-11-03)

Branch: `fix/v027-release-closeout`, based on `origin/dev` aa4bd10b. The existing
local deputy commit 210d7d9d supplied five docs entities; reviewed and reused here.

Live GitHub checked 2026-11-01: v0.2.6 reached main through #528 on 2026-10-23.
Main and staging still declare 0.2.6. #556 is the open dev-to-staging 0.2.7
promotion. Its two observed failures are addressed on this branch: GitHub squash
provenance is retained inside the message and now validated section by section;
the starter asset smoke test searches and centers each entity before clicking.
The commit-msg hook stays strict. No release was promoted or merged.

Local verification on 2026-11-01: 33 trailer/hook tests, svelte-check zero errors
and warnings, production build, and three repeated asset smoke runs without
retries passed. Generated documentation and graph checks are run before commit;
CI status must be checked on the PR, not inferred from this paragraph.

Research used Reckons MCP plus qwen3.8 panels: 26 recent stars (78 votes), then
11 primary READMEs (33 votes). Exact-quote validation rejected four of 33 quotes;
unanimous opinions also misclassified optional tools, so do not trust consensus
for this task. Reviewed proposals are pending on demo-videos, local-panel and
competitive:ref-hyperframes. Next demo proposal: real synthetic-space capture,
cached Hume narration and seekable captions/title motion; OpenDesign/HyperFrames
for production, Construct for semantic 3D presentation, StableGen for one optional
asset-quality trial. No renderer or new service was installed.

## 2026-10-28 (end of day) — Everything for dev is merged (Claude Code, Opus)

The session ran long; start a fresh one from here. Matt's decisions from today are in the graph,
each quoted verbatim under kpred:decided on the entities named below.

**Merged into dev, all with CI green including E2E:**
- #535: local deputy, missing-model handling, `models:check`, parsed bench, audit gate at moderate,
  `npm-symlink-guard.sh`.
- #541: review links grouped by producer run, with `kb=`; /review shows reconnect, loading and
  unlinked states.
- #542: `queue:check`, locked queue appends, term-senses with one subject per site, the quarantine
  file git-ignored.
- #545: the npm guard matches commands only and skips heredocs.
- #546 (squash, so a personal path in one bench answer never reached dev): gpt-oss:120b vs Sonnet as
  overseer. Sonnet 4/4 in 101 s; gpt-oss 2/4 in 2,422 s (one over-stop, one 20-minute timeout).
  Decision so far: qwen3.8 stays the chat deputy, Sonnet the overseer, and gpt-oss is a by-hand second
  reader. n=4, one run each. On kb:loop-local-deputy.
- #543: **F273 phases 0 and A** (kb:procedure-over-prose, in-progress).
  `npm run brief -- --entity=<kb:slug>` refuses a job without a done-test. Tracked git hooks in
  .githooks/: commit-msg (trailers), pre-commit (generated files, five generators' --check),
  pre-push (blocking script tier, about 10 s). `npm prepare` turns them on. The main checkout has
  them on since 2026-10-28; `--no-verify` skips them. Phases B (procedures as code: land-pr,
  merge-order) and C (runs recorded in the space) are next.

**Still open:**
- #537 (Codex, `feat/triple-check`) with #544 on top of it: Triple Check runs on-device only. Search
  is a GET to SearXNG, the model is Ollama, wasm or chrome-ai, and LAN hosts are opt-in by literal
  address (decided on kb:triple-check). Not run live against SearXNG/Ollama yet.
  **#544 reviewed (later, 2026-10-28):** two commits added (IPv6 allowlist entries match without
  brackets; one term-ratchet "source" removed), review comment on the PR. Auto mode refused the merge
  ("merge without review"), so **Matt merges #544 into feat/triple-check** — the next action.
  **dev merged into feat/triple-check** (223139a6): clears #537's Dependencies failure (undici/fast-uri);
  conflicts resolved toward dev's F273 hook; on the merge 4,405 unit tests, svelte-check 0, blocking
  9/9, graph-lint 0 errors. #537 itself (4.3k lines) is not yet reviewed; wait for its CI first.
- About 40 old agent worktrees under .claude/worktrees/, most with a symlinked node_modules. Matt
  decides what to prune; the npm guard keeps them from emptying the main checkout.

**Queue state (2026-10-28):**
- **Removed:** about 210 trash rows rejected by verdict (code-review, a dead path, the four classes
  Matt approved), 110 duplicates collapsed, 15 tail-fragment lines quarantined, and 151 term-senses
  rows superseded by 99 per-site rows.
- **Unfixed:** the browser drain (`writeToWorkspace`) still takes no host lock; it is the suspected
  source of the fragments.

**VRAM, measured:** gpt-oss at 131k is 67.1 GB, with 43.8 GB on the GPUs and about 23 GB in a 31 GB
system RAM, so no other local model fits beside it. qwen3.8-160k uses about 30 GB and leaves about
18 GB for workers. The recommendation to Matt was qwen3.8 as the always-on deputy and gpt-oss loaded
per batch for decisions, pending the comparison.

**Rules learned today (all in memory):**
- Never write npm ci in a brief.
- Never hand-edit a generated file.
- Ask Matt directly (AskUserQuestion) until review links work end to end.
- Delegate long waits; Opus ends its turn instead.

## 2026-10-28 (earlier) — PR #535 unblocked; missing local models fixed (Claude Code, Opus)

The "Waiting on Matt" items below were all answered later the same day; see the entry above.

**Branch:** `feat/local-main-agent` → PR #535, merged 2026-10-28.

### Done this session (each verified as stated, 2026-10-28)

- **CI on #535:** commit e0db7f3's trailer block was split by a blank line (reworded as 3299cd4,
  force-pushed with lease, content unchanged); `space-visual-gate.ts` linked in the codebase graph;
  `reckons-jobs.ttl` regenerated; undici override → `^7.30.1` (GHSA-xjj6-f33q-929c, high).
- **Stale "336+ tests"** in `static/docs-testing.ttl` → "4,285 tests in 317 files (counted 2026-10-27)".
  `content/project/contributing.md` STILL says 336+: `docs:compose` refuses because five composed
  pages collide with docs-kb pages — the documented two-generator overlap that F187.5 retires, not a
  regression. Do not hand-edit the page.
- **Missing local models (the real cause of "agent jobs broken"):** qwen3.6 and qwen3:32b were removed
  by hand 2026-10-26; seven scripts still defaulted to them. Now one `DEFAULT_REASONING_MODEL`
  (qwen3.8:latest, `RECKONS_LOCAL_MODEL` overrides), Ollama's 404 becomes a `MissingModelError` naming
  the model and the fix, and `npm run models:check` (script tier; jobs.json + first-pass schedule)
  checks every tagged default against `/api/tags`. The deputy's "unknown tool type" regression had no
  evidence and is closed. On this machine `qwen3.8:latest` was recreated from the 160k alias's weights
  (num_ctx 32768, no download).
- **Disabled agent jobs:** the deputy's claim was wrong (`describe-entities` is enabled; every disabled
  job states its reason). The real contradiction: `layer-classify` and `distill-decisions` were disabled
  in jobs.json for reasons that apply to any unattended run, yet scheduled weekly. Both schedules now
  `enabled "false"`, reasons cited.
- **Orchestrator bench:** scoring rewritten — answers are parsed (N3 for Turtle, JSON, `FINDING` lines)
  and each expectation is a predicate over the parse; a reference answer scores 6/6 per task and a
  keyword-stuffed one ≤1 (tests/bench/__tests__/orchestration-scoring.test.ts). Prompt fixes: T3 stated
  the ladder backwards; T2 named the retired code review. Capacity bench: three crash bugs fixed, and the
  held-producer list now comes from proposal-tally (11 producers ≥50 open, not the 4 hardcoded).
  Results: see the table below.
- **HANDOFF.md** split: 2,914 lines → archive.

### Bench results (2026-10-28, temperature 0, ctx 16384, new scorer)

Per-task columns are t1 decompose-jobs, t2 write-schedule-ttl, t3 route-batch, t4 task-file, t5 batch-triage, t6 edit-space (each /6). Wall time is the sum of the six calls.

| model | score /36 | t1 t2 t3 t4 t5 t6 | tokens | wall time |
|---|---|---|---|---|
| qwen3-coder | 30 | 4 6 3 6 6 5 | 1,631 | 32 s |
| gpt-oss:120b (65 GB, partly CPU-offloaded) | 30 | 5 6 4 4 6 5 | 5,546 | 310 s (slowest task 149 s) |
| mistral-small3.2:24b | 29 | 3 6 4 6 5 5 | 1,627 | 44 s |
| qwen3.8 | 27 | 5 0 5 6 6 5 | 12,064 | 227 s |
| gemma3:27b | 21 | 4 0 1 5 6 5 | 1,999 | 81 s |

What this shows: all five can do the structured tasks (t4, t5) and most can write a valid schedule entity;
the spread is in routing (t3) and decomposition (t1), where no model got both right. gpt-oss:120b is
usable as a local overseer on this hardware: no task came near the 10-minute stop limit.

What it does not show: it is six tasks, one shot each, temperature 0. One run is not a distribution.
Differences of 1-3 points are inside run-to-run noise: qwen3.8 scored 6/6 on t2 in the 2026-10-26 and
2026-10-27 runs (older scorer, not comparable) and 0/6 here. The 0/6 is a genuine model failure, not a
scorer bug: its answer declared `@prefix rdf: <http://www.w3.org/1999-02-22-rdf-syntax-ns#>`, a
hallucinated namespace, so `rdf:type` is not the real `rdf:type` and the entity is not a ktype:Schedule
(re-run alone 2026-10-28, raw answer saved by `--save`). gemma3:27b's t2 0/6 was an undefined `rdf:`
prefix, also a real parse failure. The scores say nothing about code writing, long contexts, or tool use.

### Waiting on Matt

1. **The review surface (kb:loop-job-grouping, no status yet).** Not started in code, on purpose —
   it is product shape and you wanted to do it with Opus. What the queue actually holds (2026-10-28):
   1,621 rows, 661 question-only (the review procedure cannot ACCEPT those, only reject/defer);
   by producer code-review 304, term-senses 151, branch-align 144, history-lessons 134, stars-scan 122,
   docs-review 105, docs-expand 103. The app already has per-entity cards, a spotlight, gates, an
   `?agent=` filter and same-source cascade clusters (fact-aggregation.ts); what is missing is the
   PROVENANCE axis: group by producer (then subject/predicate), outliers shown before accept-all,
   accept-all scoped to the filtered group with its count stated. Questions in the closing message.
2. **304 code-review rows** come from a producer retired 2026-10-13 (0 true of 49). Proposal: reject
   them as a batch with that reason. Count-before-bulk-delete: not done without your yes.
3. **15 unparseable lines** in `reckons-workspace/knowledge.pending.jsonl` (first: line 66, a record
   split mid-line, 2026-08-27). Tallies skip them silently. A script-tier integrity check is the fix.

### Still open, not Matt's call

- `kb:loop-local-deputy` `kpred:remaining` should be updated once the deputy bench is trusted.
- Queue back-pressure: 11 producers over the limit; the `local-work-reviewer` batch on 2026-10-27
  settled 4 (2 accepted docs-review, 2 deferred layer-classify).
