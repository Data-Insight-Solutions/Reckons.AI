# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-07-14.** Branch: **`feat/work-tiering-ci`** (branched off
`fix/production-claim-evidence`, which is open as **PR #100 → `dev`**).

If you are a fresh session (local, cloud, resumed, or scheduled) and Matt says "continue",
this is where you continue from. Do not re-derive it; do not re-audit what is already audited.

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

**The orchestration loop now closes.** That is the headline; everything else served it.

- **The task queue is a graph.** `src/lib/rdf/agent-task.ts` + `scripts/agent/runner.ts`.
  `npm run agent:run` drains `reckons-workspace/tasks.ttl`: claim (a LEASE, not a lock) →
  execute → **verify INDEPENDENTLY** → write the outcome back. A task with no `done-when` is
  REFUSED ("a wish, not a task"). A recurring task (`kpred:every "7d"`) is never *done*, it is
  *due again*. An expired lease with no outcome is detected and requeued — the "fired on
  schedule, produced nothing, still showed a future run time" failure, made queryable.
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

Everything on the previous list is DONE (brief, gallery, graph-first digest, local-agent tier).
**CI on PR #101 is fully green** — all four jobs, including the blocking script tier.

1. **The Opus orchestrator (F89)** — the last missing piece of the loop. A scheduled Opus
   session that ASSIGNS rather than executes: triage the pending queue, write `AgentTask`
   entities into `reckons-workspace/tasks.ttl` (with a `done-when`, or the runner refuses
   them), and let the free runner drain them. Everything it needs now exists — tasks, leases,
   outcomes, blast-radius ranking, gates, `kb_merge`, and a runner that asks instead of guessing.
2. **Triage the queue.** `npm run brief` reports **156 pending facts, 35 drift-warnings, 37 open
   questions**. That backlog is what the other two tiers exist to fill and Opus exists to judge.
   Route it with F88: most of it is not Matt's to decide.
3. **F90 Blender** (planned) — headless Blender over MCP. The trap is written into the roadmap:
   **Blender will render a black frame and exit 0.** Content is the first domain where
   `done-when` cannot be a passing test, which is precisely what F88 exists for.
4. **Graph previews in the gallery** — deliberately not built. A thumbnail needs each graph's
   statements loaded out of IndexedDB, which is a real cost across many graphs and deserves its
   own decision (cache a thumbnail on save? render on hover?).
5. **F27 / F34 / F79 / F83** are all still `in-progress` or `scaffolded` — see `npm run brief`,
   which reads them from the graph rather than from anyone's memory.

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
