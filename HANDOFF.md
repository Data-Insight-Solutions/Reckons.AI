# Handoff — read this first if you are picking up mid-stream

Everything before 2026-10-28 is in `HANDOFF-ARCHIVE.md`, verbatim (top section). Grep it for history;
the graph holds what was decided.

## 2026-11-13 (overnight, final) — START HERE: v0.2.8 is green on #624; MATT merges it

**Release v0.2.8 — ready.** PR #624 (staging -> main) is green and clean (28 checks, 2026-11-13): the docs
gate passes after #627 (nine plain-language pages covering the 32 undocumented features) was promoted
through #628. One E2E test flaked and passed on re-run: generated-assets-story.test.ts:220 'Shelly queues a
chain as ONE approval' — third failure in three days, timeouts were raised without a diagnosed cause; filed
high-priority in the review queue. MATT merges #624 (production deploys from main).

**Then the DIS site:** Matt pushes `content/site-pages` in DataInsightSolutions-website (local commits: company
voice 6edd5f7, ring link 6032fbe, blog covers 02756b1, business card a8af730 — the back WITHOUT the phone,
checked as text and by eye) and merges his DIS PR #3; its GitHub workflow builds and deploys.

**Merged into dev overnight (v0.2.9):** #623 runner connect popup + on-demand generation services (the
agent watcher serves ~/Documents/reckons-assets plus folders listed once in
~/.config/reckons/generation-folders.json; starts a service on request, 'needs install' when missing, idle
stop after 600 s; services are plugin-shaped records in src/lib/generation/services.ts; per-service installer
NOT built, planned F58.9.21; no real request has gone through the watcher to the GPU yet); #622 the DIS
business card in the DIS space (design versions, print sheets v1-v3 derived from them, the regenerate
rule, story step 3) + `npm run print:sheet` with a receipt and --check + F294.8 and F295 (Canva) plans;
#625 F296 plugin library planned for v0.2.9 (two open questions for Matt on the entity); #626 this handoff.

**Dev regression found and fixed overnight:** after #623, generated-assets-story.test.ts:179 failed 3/3 on dev (staging and #624 do not contain #623, so v0.2.8 is unaffected). Cause: a race in GenerationStory.svelte — the Reconnect button stayed until the next 2 s poll after the folder was linked; fixed in #630 (connect as soon as the workspace reports connected; no connect buttons while connecting) with a test that the button goes within 1.5 s. Still open: 'Shelly queues a chain as ONE approval' (story file ~line 236) fails locally on dev before and after the fix and intermittently in CI — filed high-priority; likely a test-order race, unconfirmed.

**Local jobs (05:33-05:36 UTC):** burndown 23 of 36 v0.2.8 parts functional; claim-audit 6 findings, all
pre-existing in SAFETY.md / COUNSEL-BRIEF.md (absolute statements without a pinning test — Matt's legal
wording, left for him); describe-entities 3 drafts already awaiting review.

**Open for Matt:** merge #624; push the DIS branch and merge DIS #3; the F296 questions (what stays core;
whether entity types and Triple Check fold in); try Shelly generation with the real folder picker and a
real local model (F166.1 stays in progress until then); his browser serves stale builds after deploys (PWA
cache) — the app should offer 'a new version is ready, reload' (offered, not planned yet).

## 2026-11-12 (night) — START HERE: what ran overnight while Matt slept (Claude Code, Opus 5.5, with Sonnet agents)

Matt went to bed about 00:40 CST after answering four questions (recorded as `kpred:decided` on the entities):
story mode is an IN-APP GUIDED WALK first; a CONTEXT PACKAGE is the shareable form of a space (F107.3.1);
'expired cert check' meant CREDENTIALS ON THE ABOUT PAGE (F293); and for the ring, "keyframes should be manually
review[ed] to get the most crisp, not blurry image frames of differing angles."

**Local `dev` (ahead of origin/dev; PR #610 carries it, unmerged on GitHub) now also holds:** the site generator
work (animated inline mark, guided-scroll control, card diagrams, employer logos with a notice, version stamps on
scripts and styles, the `sections` template for About and Services); F293 facts that expire (site:build refuses a
page stating an expired fact; `scripts/offline/fact-expiry.ts`); F292.1 the generated 'How this website was made'
story in the Data Insight Solutions space; F292.2 the guided-walk player (step links, lighting without moving,
a slim bar on phones, arrow keys; e2e 3/3 in Chrome only); the scan's new curated-frames input (F58.9.6.1);
PR #604 (safety attestation now 6/6, circuit reset); a lossless fix for statement ids containing '|' that broke
generated-assets.ttl (the existing workspace file stays broken until the app rewrites it).

**Website preview** https://launch-preview.data-insight-solutions.pages.dev (noindex) was redeployed after each pass.
The site repository branch `content/site-pages` has local commits only (never pushed): the About edits, the
mark, diagrams, logos, softer contact wording, and the AWS credential marked `valid-until: 2027-12-01` (the page
says "valid to December 2027"; the earliest day of that month is used). Its EARLIER local commit 7824b24 contains
the n8n webhook address: rewrite it out before that branch is ever pushed. The n8n contact workflow is PUBLISHED
and tested (one test email sent); preview origins were added to its allowed list.

**Ring:** 189 of 373 candidate frames kept after a frame-by-frame review (`~/.local/state/reckons/ring-scan/frame-review.md`);
two scans queued on GPU 1 (variant 2 = full-resolution square crops, because at the pipeline's 900x1600 the ring is
~200 px wide). Nothing goes on the website until Matt has looked. Check the agent's result in the private notes.

**Hume:** 23 narration clips banked in the demo cache plus 10 Kokoro versions and a blind A/B page at
`~/.local/share/reckons/private-workspace/2026-11-12-voices/listen.html`. The '13 Nov shutdown of TTS and EVI'
comes only from search summaries; Hume's current changelog does not mention it and the API still worked.

**Deputy sizes (F289):** qwen3.8, the current deputy, is 27.3B, above Matt's 24B line. Candidates within it that can
run the harness: devstral-small-2, mistral-small3.2:24b, lfm2.5, llama3.2:3b. Review and plan in
`~/.local/share/reckons/private-workspace/2026-11-12-reports/`.

**Open for Matt:** the three article drafts (`workspace/drafts/blog/` in the site repository); the shortened posts;
which address the site lives at; whether the walk may show per-post claim lists; the producer-states thresholds
(branch held); running the deputy benchmark.

## 2026-11-11 (evening, wrap-up) — QUEUE MANAGED + RING TASK GROUNDED, not executed — for the next Claude/Opus session

Matt asked the deputy (qwen3.8-160k) to "manage job queue this evening, claude is back after midnight," then gave the ring task, DIS feedback, and called the wrap. **Nothing here is a decision by Matt beyond what is quoted.**

**Queue (live, ~/.local/state/reckons/jobs/):** worker pid 2860949 healthy, was at 131/140 running `deputy-f74-14-request-validation` at wrap.
- **DROPPED 4 stale garden jobs** (44c0f170 image-overview; 0ebf89dd/ed155755/a7f00635 scan slots) — all pointed at
  `tripleNotes-examples`, which is now on `fix/site-landing-mark` and has **neither** `scripts/review-spaces/` **nor**
  `reckons-workspace/` (the garden space TTL was not found anywhere under /home/matt/Github). They would all have
  failed. The `feat/review-story-garden` branch still has the scripts; the space data is gone — decide whether to rebuild the
  garden demo or let the ring/DIS story replace it.
- **HOLDS (unchanged, do not ignore):** docs-review 55 and docs-expand 62 unreviewed proposals (limit 50) — release by
  reviewing; safety-attestation circuit OPEN (3 strikes) — **do NOT reset before it passes 6/6** (fix the classification
  of the unclassified path first, per the 2026-11-11 midday entry).
- A local-work-reviewer batch (≤10) was dispatched before the wrap to cut the docs-review/docs-expand counts —
  **outcome NOT confirmed by the deputy at wrap** (subagent had not reported back).
- `deputy-f287-4-default-arrange-order` failed 01:16 with a transient gateway 500 (U+FFFF XML error from
  localhost:11434); worker retries on backoff — **not re-confirmed at wrap**.

**Ring task (Matt: "Make a space and try to generate the ring") — GROUNDED ONLY, no space built, no job queued:**
- Video: `/home/matt/Downloads/IMG_1257.MOV` (also `/home/matt/Videos/IMG_1257.MOV`) — 4K HEVC, 53 s, 120 fps,
  filmed on a **checkerboard/ArUco-style scan board** (deliberate photogrammetry setup). Ring: silver championship-style,
  faceted diamond crown, red gem center, black panels engraved "ROE". Frames: `~/.local/state/reckons/ring-frames/` (f5–f48).
- Paths available: (a) generative prompt→image(zimage)→splat(TripoSplat) — wrapper on branch `feat/review-story-garden`
  (`scripts/review-spaces/generate-assets.ts`, pattern: `--slot=… --stages=image,splat --workspace=…`, image before splat,
  GPU1); (b) reconstruction — `scripts/content/scan_colmap.py` + `scan-attach.ts` from real frames (the checkerboard
  suggests Matt intends this one); F58.9.19 multi-scan fusion decided but NOT built.
- **HONESTY REQUIREMENT (honest-status):** an asset made from a text prompt is NOT his ring — label origin "generated"
  and make the story say exactly which pipeline produced it. Story goal (Matt): "how did I make this ring digital asset
  from a real object"; if it looks really good → DIS About page, linked to the space.

**Matt's decisions/feedback this evening — ALL recorded in the review queue as kb_add_note (agent local-deputy:qwen3.8-160k):**
(1) "Built with Reckons.AI" must be a kickass experience INSIDE Reckons.AI: story mode of the site-generation process,
why it made the info clear/organized/referenced, cross-page instant editing, staleness detection ("expired cert check?"),
tie DIS to Reckons.AI as the tool for publishing great web content. (2) Ring → DIS About page + linked space + story.
(3) Landing: "very clear by language that this is a 1 person company. It may not be forever, so landing should be less
blunt" (roadmap precedent: the SOLO wording becomes false if the team expands — scope-decision ~line 1367).
(4) About + Services pages "very bland at the moment" — need better layouts. (5) Harness warning: auto mode not working,
harness may be acting up; keep deputy work on the plain tool path.

**Unverified / still open at wrap:** reviewer-batch outcome; f287-4 retry; the TTL parse failure at
`reckons-workspace/kbs/generated-assets/generated-assets.ttl:1128` (sched:offer-tasks skipped 4 notes because of it —
the failing block is structurally identical to its neighbours; root cause not found, deputy's n3 repro attempt failed).

## 2026-11-11 (midday) — Data Insight Solutions site: build diagnosed, launch path ready — for Fable (local deputy qwen3.8, Matt asked for Fable handoff)

**The right repo is `/home/matt/Github/DataInsightSolutions-website`** (github.com/Data-Insight-Solutions/DataInsightSolutions-website),
NOT `data-insight-solutions.com` (the old Netlify site, still in DNS). Matt: old one first, then the redesign —
**deploy the redesign on Cloudflare, over the existing Pages project `data-insight-solutions`
(preview `data-insight-solutions.pages.dev`), noindex until Matt cuts DNS over.** Launch date **2026-11-14
(AI Reality Check talk) confirmed by Matt this session.** Scope: brand + landing + reviewed blog +
pre-built HTML; NO engine package. Blog pipeline approved: Triple Check (facts settled) → shorten all 8
posts, every change a review-queue proposal (claims format already exists in
`workspace/drafts/reckons-ai.claims.md`, 0 ungrounded as of 2026-11-10).

**BUILD "GAPS" — all three explained, none is a bug (diagnosed this session, Fable to use as-is):**
- `2024-ai-video-editing` is NOT dropped — it IS the current `index.html`. All 4 core pages
  (index/services/about/contact) are `status: draft`; `publishablePages` (src/lib/rdf/page.ts:194) keeps
  only published|unlisted, so the 8 published blog posts are the whole site and `pickHome`
  (src/lib/publish/site-generator.ts:107) fell back to lowest-order root page → that post became home.
- services/about/contact missing = **correct by design** (AGENTS.md: "A page is public only after the
  owner approves and publishes it"). The launch blocker is simply: Matt publishes the 4 core pages
  (flip `status: draft` → `published` in their frontmatter) — then index.md (template: landing) becomes
  the real home and displaces the post.
- Output has **no noindex/robots.txt** — expected; add it at deploy time (write `robots.txt`
  `User-agent: * / Disallow: /` into the output dir after `site:build`, before `wrangler pages deploy`).

**Verified working this session:** `npm run site:build -- --site=/home/matt/Github/DataInsightSolutions-website
--out=…` → 8 pages, 31 files, 19 assets, clean import (12 files / 182 statements / 0 warnings), output at
`~/.local/state/reckons/site-builds/data-insight-solutions`. Wrangler auth via `CLOUDFLARE_API_TOKEN` (never
print it). Two small fixes for the final build: pass `--title="Data Insight Solutions"` (default
"Reckons.AI site" leaked into the post-home's <title>), and the robots.txt above.

**Not done (Fable's, or Opus's, call to make — deputy has no push/deploy authority anyway):** publish the
4 core pages, rebuild with title + noindex, `wrangler pages deploy` over `data-insight-solutions`, verify
the pages.dev preview, queue the blog Triple-Check+shorten. Unverified: that Matt wants ALL 4 core pages
public at 11-14 (he approved the deploy, but per AGENTS.md the status flip is the owner's act).

## 2026-11-11 (early) — STATUS CHECK for Opus/Fable (flagged by local deputy qwen3.8; Matt asked "did the deputy crash?")

**Answer: NO, the local deputy did not crash.** The job that just ended, `deputy-local-f89-4-5-sampler`,
finished clean: `queue.done.jsonl` shows `outcome: passed, exitCode 0`; the worker log says "Sampler script
implemented, 6/6 tests pass, committed to `agent/local-f89-4-5-sampler`"; head moved `cf657102 → d88659e9`.
The worker then advanced to `deputy-local-f89-4-4-run-tree` (alive); ollama is up with `qwen3.8:latest`
answering in ~5s; no OOM in `dmesg`, no zombies. **Do not chase a phantom crash.**

**What likely looked alarming:** the worker *self-pauses on GPU heat* — `queue-worker: paused — GPU 0 at
91 C >= 83 C; N queued` — then resumes. That is expected thermal throttling (GPU at 91°C ≥ 83°C threshold),
not a fault. If jobs feel slow, that is the reason.

**RESOLVED during this session (Matt chose, deputy did):**
- **`dev:test` server on `localhost:5174`** — was DOWN (visual gate blind: *"dev server connection refused at
  localhost:5174, 0 gates evaluated"*). **Now RESTORED:** `npm run dev:test` running, serving **HTTP 200**
  (verified 127.0.0.1:5174, ~232 KB, ~0.13 s) → the Space visual gate (`sched:visual-tests`) now has a target.
  **Caveat:** it runs as a background process in *this* deputy session — if this session ends first, restart with
  `npm run dev:test` (port 5174) before running the visual gate.
- **`deputy-local-f74-15-receipt-check`** — Matt chose "drop it." Clarification for the record: it was a
  **one-shot deputy draft, not recurring** (not in `static/reckons-jobs.ttl`) and was **already out of the active
  queue** — no entry in `queue.jsonl`, only a single failed record in `queue.done.jsonl` (exit 143 / SIGTERM,
  2026-11-10T23:30Z). It sits in a 30-min retry backoff but will **not auto re-fire** (nothing schedules it). So
  there was nothing in the live queue to drop; if the F74.15 receipt-check draft is still wanted, re-brief it.

**STILL OPEN (needs a triage decision — not a crash):**
- **Review queue is over limit and holding jobs** (`worker.json` → `held`):
  - `docs-review`: 53 unreviewed proposals (limit 50)
  - `docs-expand`: 62 unreviewed proposals (limit 50)
  - `safety-attestation`: **circuit OPEN** (3×). Root cause found (ran the attestation inline — 5/6 controls
    pass): the one failing control is the unclassified generative path `src/lib/integrations/llm/triple-check.ts`
    (F100.1, deliberately local-only). Most likely a classification-REGISTRATION gap (that path is a local-only,
    structured-output prompt that per `kb:tenet-private` does not carry the preamble), **not** a real safety hole —
    but Opus to confirm. **Do NOT reset the circuit before it passes**: fix the classification, re-run
    `npx tsx scripts/offline/safety-attestation.ts` (want 6/6), then
    `npx tsx scripts/agent/job-watch.ts --name=sched:safety-attestation --reset`.
  - `visual-tests`: **RAM guard** (not a bug) — it loads the VLM (~16 GB) on top of the deputy's resident qwen3.8
    (23 GB); the ~39 GB spill tripped the guard and self-paused. Needs the VLM to fit (fewer co-resident models)
    or a deliberate guard-limit decision.
  Triage decisions for Opus/Matt: review some proposals down under 50 to release `docs-review`/`docs-expand`;
  confirm + fix the safety classification before resetting its circuit.

**Unverified / awaiting a decision (not done):** the pending deputy memory change
`~/.config/reckons/local-claude/memory-written/20261111T004402Z/changes.patch` is **not merged** — review and
merge or reject it (it is a proposal, per the deputy contract).

**What Matt decided (this session):** (a) **start 5174** — done, serving HTTP 200; (b) **drop f74‑15** — done,
it was already out of the active queue (one-shot, not recurring). **Still open for Opus/Fable:** the over-limit
review queue (docs-review / docs-expand) and the safety-attestation circuit reset, plus the unmerged memory patch
below.

## 2026-11-10 (night) — START HERE: build wave merged into LOCAL dev; one batch PR open (Fable 5.2 + Sonnet overseers)

**Local `dev` is AHEAD of `origin/dev`.** It equals branch `integration/2026-11-10` (PR #610, base dev, NOT merged
on GitHub; it contains the commits of #608 and #609). Matt, 2026-11-10: dev integrates through local git; GitHub
gets one batched PR. How it was done: each stream pushed a branch with no PR, one integrator merged them into
`integration/2026-11-10`, ran the checks on the COMBINED tree, then fast-forwarded local dev.

**Local deputy first drafts queued 2026-11-10 (evening), for sub-agents to pick up:** seven unchained jobs, each
on its own local branch `agent/local-*` cut from local dev (not pushed), each told to commit (a subject starting
`WIP:` means a check failed): F74.15 receipt check, F89.4.5 sampler, F89.4.4 run tree, F58.9.19.2 similarity fit,
F58.9.19.1 capture links, F269.2 device leap helpers, F286.7 self-settlement check. `git branch --list 'agent/local-f*'`
and `npx tsx scripts/agent/queue.ts list` show them. Judge each by its diff against its entity's done-test, never by
the queue's "passed". The queue worker was restarted from the main checkout the same evening: it had been running
from a worktree that was removed, and scheduled jobs failed for about two hours.

**In the batch (statuses are on the entities; read their dated honest-notes):** F58.9.20 scan auto-attach
(scaffolded: attach-only mode, backfill of a missing splat file on poll, explicit link flags, a question when no
link is given); the architecture plan and Matt's decisions (#608); F286.1/.3/.6 trust checks (built, wired into
nothing yet); F269.1 device job records (scaffolded; the device space itself does not exist); F89.4.3 lanes and
F89.4.1 row contract (hand runs mint `hand:<job>:<time>`; contract date 2026-11-11); F223.9/.10 standing drawn,
F223.11 filters partly built (no link from a Reckoning option, no 3D exact filtering).

**Checked on the combined tree 2026-11-10:** svelte-check 0 errors; scoped vitest (scripts, rdf, stores, storage,
3d, mcp-server, cli) 3,924 passed; graph-lint 0 errors; blocking script tier 9 of 9; md-align aligned. NOT run:
the full unit suite, the e2e suite, the build.

**HELD, do not merge without Matt:** `feat/f89-4-6-producer-state` (F89.4.6). Merged, the worker would skip 15
producers' schedules on thresholds that are only proposed (yield 0.3, decidability 0.5).

**Not done:** the queue worker still runs the code it started with; restart it from the main checkout to pick up
the job-watch and worker changes. A finished job records its space as a folder name, so a run's leap to its space
cannot be made yet (record the space's stable id too). The local deputy queue blocks a job chained `--after` a
job that ends without a commit; queue deputy drafts unchained.

**Rules learned today:** never `git stash` in a worktree (the stash is shared; one stream took another's work);
never raise a ratchet baseline to pass (reword prose, or stop and report); ratchets do not compose, so re-run
`term-usage --check` on the combined tree.

## 2026-11-10 (later) — architecture pass: review overhaul, asset goal, job channel, fusion, trust contract, release (Fable 5.2)

**This PR (branch `chore/architecture-pass-2026-11-10`, roadmap only, NOTHING BUILT):** plans written into
`static/reckons-roadmap.ttl` as `planned` entities with done-tests. Recommendations are `kpred:proposed`;
what only Matt can decide is a `kpred:open-question` starting `FOR MATT`. Query by id:
- **Review overhaul** `kb:loop-job-grouping` (now F89.4), phases F89.4.1–.7 in build order: row contract
  (space + run + lane), one ledger per workspace, lanes (findings leave the person's queue), run as a set,
  sample gate, producer states by yield and decidability, inline answers.
- **Asset goal** `kb:asset-run-review-loop` (the loop and the build order), F284.0 data model, F285.0 free
  layout. F284, F285, F223.5/.6/.8 were copied to dev from `agent/local-v028-jobs`.
- **Job-to-space channel** F74.14 and the run receipt F74.15 (F58.9.20, F74.12, F74.13 now depend on them).
- **Fusion** F58.9.19.1–.5. **Offline trust contract** F286 (.1–.9). **Release** notes on 0.2.7 and 0.2.8.
- **Proposals and questions drawn apart** F223.9–.11 (Matt, 2026-11-10): a statement's standing, the canvas drawing by it, and filters exact to the statement with a focus on one proposal's option.
- **Jobs in This device** F269.1–.2 (Matt, 2026-11-10): every job detailed in the device space; the space a job runs for holds its definition with a leap that names no device.

**When `agent/local-v028-jobs` is rebased:** (1) drop its own copies of `kb:guided-asset-refine` and its four
phases, `kb:interactive-space` and its three phases, `kb:proposal-outcome-assets`, `kb:reckon-an-asset`,
`kb:reckoning-outcome-review`; dev's are the same text. Then restore the two links this PR left out because
their targets live only on that branch (`guided-how-to-generate → generation-catalog`,
`proposal-outcome-assets → demo-composite-asset`). (2) Renumber its two entities that claim F58.9.19 and
F58.9.20 (`showcase-assets-refresh`, `one-prompt-every-asset`): dev gave those ids to multi-scan
reconstruction and scan auto-attach; graph-lint's duplicate-id will fail otherwise. (3) Its 0.2.8 re-cut
(the `has-part` moves) is still the only place the decided 0.2.8 scope exists as edges; until it lands,
`release:burndown` for 0.2.8 measures the replaced list (0 of 14 on 2026-11-10).

**Decided by Matt 2026-11-10 (each recorded as `kpred:decided` on the entity named):** findings leave Review
(`kb:review-lanes`); run grouping now, in the current Review page, as the default (`kb:loop-job-grouping`);
hold 0.2.8 for its headline, no end date yet (`kb:release-0-2-8`); walk the scanned place first
(`kb:asset-run-review-loop`); a gap closes by measure, with a recorded waiver (`kb:asset-data-model`); the
plan's first rendering is a top-down drawing (`kb:landscaping-plan-space`). **Still only proposed:** where the
four unfinished 0.2.7 parts go, F286 as a part of 0.2.9, and the yield and decidability thresholds.

**Checked 2026-11-10 in the branch's worktree:** graph-lint 0 errors; blocking script tier 9 of 9 after
regenerating `static/review-0.2.7.ttl` (the new F89.4 id changed one generated name); md-align aligned; the
8 unit files that read the roadmap pass (84 tests). NOT run: the full unit suite, e2e, build. Failing on dev
before this branch and unchanged by it: repo-hygiene, naming-ratchet, taxonomy-current, safety-attestation
(#604 is its fix), perf-crawl.

## 2026-11-10 — GPU pin and chain fix landed; scan-fusion approach decided (Claude Code, Opus + Sonnet overseer)

**This PR (branch `agent/local-gpu-pin`):** (1) the deputy env sanitizer drops a `GIT_CONFIG_*` group whole;
(2) F74.7 GPU pin: `queue.ts add --gpu=<n>` runs a job on one card and the gate judges only that card;
(3) chain fix in `afterChain`: a predecessor that is currently queued is WAITING even if an older run of it
is blocked in the done log (re-queueing it is the user re-running it). After merge, restart the queue worker
from the main checkout. Details of the private multi-capture scan trial live in the private workspace
HANDOFF (outside git), not here.

**Decisions Matt made today in chat:** (a) the deputy's 6 attach rows for one finished scan named no space and
were deleted (Matt approved); Matt drag-drops finished splats through the scan-import UI until automatic
attach is built. (b) Fusion approach: one COLMAP layout over pooled frames with cross-session matching, then
a fused splat for preview and a mesh from depth maps for Blender (not built; plan in the graph first).
(c) The GPU-contention question is answered by the pin. (d) "Auto mode not working" is in the local deputy
(`npm run claude:local`), under investigation.

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
