# Handoff — read this first if you are picking up mid-stream

Everything before 2026-10-28 is in `HANDOFF-ARCHIVE.md`, verbatim (top section). Grep it for history;
the graph holds what was decided.

## 2026-10-28 (end of day) — START HERE. Everything for dev is merged (Claude Code, Opus)

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
  address (decided on kb:triple-check). Not run live against SearXNG/Ollama yet, and feat/triple-check
  had 2 graph-lint errors of its own. Review #544, then #537.
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
