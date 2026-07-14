# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-07-14.** Branch: **`feat/work-tiering-ci`** (branched off
`fix/production-claim-evidence`, which is open as **PR #100 → `dev`**).

If you are a fresh session (local, cloud, resumed, or scheduled) and Matt says "continue",
this is where you continue from. Do not re-derive it; do not re-audit what is already audited.

## Do this now

1. `git fetch && git checkout feat/work-tiering-ci`
2. `npm run offline:script-tier` — free, deterministic, ~40s. It tells you the current state
   without spending a token.
3. Pick up the **Next up** list below. Everything in **Done this session** is committed.

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

## Done this session (committed, do not redo)

- **`44445ce` — the free tier ran nowhere, so it displaced nothing.** `kb:tier-script`
  claimed it "runs in CI and fails loudly"; only safety-attestation was ever wired. Now
  `ci.yml` has a `script-tier` job on every push/PR. `published-graph-guard` and
  `button-crawl` existed with npm scripts but sat in NO registry — `offline:all` had never
  once run them. Registered. `run-all.ts` gained a `blocking` flag + `--ci` mode.
- **`e331145` / `3f366f7` — a filter is a lens, not a deletion.** Filters used to splice
  statements out before `buildGraphView`, so filtered nodes never reached the force sim and
  the layout re-solved under the user. Now every node stays in the simulation and unmatched
  ones render at `GHOST_ALPHA`. Verified in a browser: a filter matching 0 of 2027
  statements leaves 383 nodes present, 383/383 ghosted, and the marketing landing page does
  NOT replace the graph (it used to).
- **`af6166a` — competitive research graph (F86).** `static/reckons-competitive.ttl`, 13
  projects, plus `scripts/offline/competitor-scan.ts` (script tier, zero tokens) which
  verifies every LICENSE against the GitHub API and flags copyleft (we are MIT).
- **`ad2bbb3` — SRI on the Sveltia CDN bundle.** `/admin` holds a GitHub token that can
  reach production; the script tag had no integrity hash.

## Next up (in priority order)

1. **Push this branch and open a PR → `dev`** (NOT `main`; verify with
   `gh pr view <n> --json baseRefName`). Nothing here has been pushed yet.
2. **KB gallery (Matt asked for it).** A filterable gallery of graphs with metadata (last
   edit, statement count) and previews if feasible, replacing the current graph-selection
   experience. Not started.
3. **`npm run brief`** — a script-tier session-start context dump (branch, open PRs, pending
   count, script-tier status, what is unblocked). Replaces the few-thousand-token
   re-derivation Opus does at every session start. Not started.
4. **Digest → graph-generated.** `reckons-workspace/DIGEST.md` is hand-appended and is a
   second source of truth. F80 phase 3 (`kb:async-digest`) specified a `kb:digest` ENTITY
   rendered through the WebPage/publish machinery. That entity does not exist. Close the gap.
5. **Agent-tier code review first.** `scripts/offline/code-review.ts` (qwen3-coder) exists;
   Opus still reviews diffs by hand. Run it first; triage its output.

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

- **The published graph has test debris in it.** `static/knowledge.ttl` IS the public graph
  (served at `/knowledge.ttl`). It carries 166 terms in the `urn:reckons:story/` test-harness
  namespace, **committed on `dev`**, and its header claims 1032 statements against a body
  that parses to 3096. `published-graph-guard` is `blocking: true` in `jobs.json`, but CI
  runs the script tier **advisory** (`|| true`) precisely because this is red on arrival.
  **Fix the graph, then swap `|| true` for `--ci` in `ci.yml`.**
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

## unsnooze (auto-resume) — NOT INSTALLED, and this is why

Matt asked to wire in `saaranshM/unsnooze` (MIT, verified) so a limit-stopped session
auto-resumes. **It is not installed, because its prerequisite is absent:** unsnooze resumes
sessions *into tmux or Zellij*, and this machine has **neither**, and Claude Code here is not
running inside a multiplexer.

Installing it as-is would register a `StopFailure` hook, record the stop, and then have
nothing to wake into — it would *look* armed while being dead. That is the exact failure
already recorded against `kb:local-orchestration` ("a scheduler you cannot observe is not a
scheduler"). Repeating it knowingly would be worse than not having it.

To actually enable it:
1. `sudo apt install tmux` — needs Matt (sudo).
2. `npm install -g unsnooze && unsnooze setup` — interactive wizard.
3. Start Claude Code **inside tmux**, so there is a pane to resume into.

Until steps 1 and 3 are done, **this file is the continuation mechanism.** It needs no daemon,
no hook, and no multiplexer.
