# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-08-15.** Working branch: `plan/content-operations`
(**1 commit landed this session — `59e2e54` — plus UNCOMMITTED F136 work, see below. Not pushed, no PR.**)

## ▶ LATEST (2026-08-15) — the extraction problem, measured properly at last

### ✅ COMMITTED (`59e2e54`) — "0.88 was never measured, and nine antonym pairs never once fired"

Continues the previous commit's finding that extraction is a VOCABULARY problem, not a capability
problem. The obvious next question was whether the thing that already fixes vocabulary drift —
`normalize-entities.ts`, which rewrites an incoming predicate onto an existing one at cosine ≥ 0.88
— actually does. **It had never been measured**: its test mocks a vector table and asserts branching
given assumed cosines, so it proves the logic and says nothing about the threshold. That constant
gates a WRITE into a user's graph.

**`npm run bench:predicates`** (new: `tests/bench/run-predicate-vocab-bench.ts` + fixture
`predicate-pairs.json`, 12 synonym pairs vs 12 lexically-similar-but-DISTINCT pairs, embedded
exactly as production embeds them):

| model | merge recall | **false merges** | separation | safe threshold |
|---|---|---|---|---|
| bge-small (SHIPPED) | 16.7% | 0% | −0.256 | 0.84 |
| all-MiniLM-L6-v2 | 8.3% | 0% | −0.311 | 0.78 |
| nomic-embed-text | 16.7% | 0% | −0.208 | 0.85 |
| gte-small | 66.7% | 58.3% | −0.100 | 0.94 |
| e5-small-v2 | 83.3% | **75.0%** | −0.117 | 0.95 |

**0.88 is SAFE and nearly INERT.** It misses the case that motivated it
(`has-heart-count`/`has-number-of-hearts`, 0.803) and CANNOT be lowered to catch it:
`is-found-in`/`is-located-in` scores **0.8341**, above the synonym. **Every model has NEGATIVE
separation** — cosine alone cannot separate "another word for the same relation" from "a different
relation that looks similar". Recorded as `kb:predicate-threshold-limit`; decision **keep 0.88**.

⚠️ **Read the false-merge column before ever changing the embedding model.** The existing embed
bench ranks models on entity similarity in coarse bands (0.7/0.4); a model chosen on that basis
(gte-small, e5-small-v2) would silently collapse `has-predator`→`has-prey` (0.9322) and
`has-min-weight`→`has-max-weight` (0.9330).

**TWO REAL DEFECTS FOUND AND FIXED:**
1. **Nine antonym pairs were dead code.** `semantic-diff.ts` stored them hyphenated (`is-true`/
   `is-false`) while every caller passes a label from `labelFromIRI`, which has ALREADY turned
   hyphens into spaces. `"is true".includes("is-true")` is false — so `is-true`/`is-false`, the most
   consequential contradiction a graph can hold, **had never matched anything**. Now whole-word
   matching on both sides (which also stops `"min"` being read out of `"determiner"`).
2. **The antonym guard protected the advisory path, not the write path.** `isAntonymPredicate` was
   module-private to `semantic-diff` (which only LABELS a diff). `normalize-entities`, which
   silently REWRITES, had none. Now vetoed **while ranking** — applied after, a high-scoring antonym
   would suppress a legitimate synonym below it. **Defence in depth, not a retroactive fix:**
   bge-small reaches no opposed pair at 0.88, so nothing existing was corrupted.

Also: **ingest scoring now reports `factRecall` beside `vocabularyAgreement`, never combined**
(`tests/bench/scoring.ts`). On a real qwen3.6 run, strict F1 26.3% decomposes to **44.4% fact recall
at 62.5% vocabulary agreement**. Blind spot pinned: an inverted relation still matches at fact level,
so factRecall is an UPPER bound and is never reported alone.

Verified: 1969 unit tests, 0 type errors, graph-lint 0 errors, align green. Every new test
**mutation-checked**; one was decorative and was rewritten after a mutation failed to kill it.

### 🚧 UNCOMMITTED — F136 vocabulary grounding (built, tested, MEASUREMENT INCOMPLETE)

**Matt's steer this session:** "active query of current graph while extracting… extraction is a
large % of the battle." Confirmed in code: `buildExtractionUserPrompt(text, sourceTitle)` took the
source text and a title — **the extractor never saw the graph it was writing into.**

Built (all green, 22 unit tests, 5/5 mutations caught, 1115 tests pass across affected suites):
- **`src/lib/rdf/vocabulary-context.ts`** — `selectVocabulary()` + `buildVocabularySection()`.
  **SCRIPT TIER by construction**: frequency + lexical overlap, deterministic, zero tokens, no
  embedding call, works offline. Drops generic predicates (`relates-to` etc.), drops predicates used
  once (graph-lint's 24%-are-one-offs finding), drops standard vocabularies, stable ordering so the
  prompt prefix stays cacheable.
- **`buildExtractionUserPrompt(text, title, vocabularySection = '')`** — third param OPTIONAL and
  appended last, so every existing caller keeps its exact prompt bytes and an empty graph costs nothing.
- **THE LOAD-BEARING PROPERTY, tested:** the section is a PREFERENCE, not a cage. It explicitly
  permits minting a new predicate and forbids forcing a fact into a listed one. A closed list would
  suppress genuinely new relations, and a well-formed absence is the point (`kb:thesis`).
- `tests/bench/fixtures/golden/existing-graph.json` — an existing graph that shares the VOCABULARY
  but **none of the facts** (cuttlefish/squid/nautilus, never the octopus). Seeding the golden
  triples would be circular. Read its `$comment` for what the measurement does and does not prove.
- `--ground` flag on `run-ollama-bench.ts` (baseline mode only; it throws loudly on
  `--mode structured`, which composes its own prompt inside `extractWithOllama`).

**▶ NEXT STEP, START HERE:** the A/B was **launched but not finished** — baseline run was still going
when the session ended. Run both and compare `factRecall` / `vocabularyAgreement`:
```
OLLAMA_BASE_URL=http://localhost:11434 npx tsx tests/bench/run-ollama-bench.ts \
  --model qwen3.6:latest --tasks ingest --mode baseline --timeout-ms 900000
# then the same command with --ground appended
```
⚠️ **COMPARE LIKE WITH LIKE — the two numbers floating around are from different modes.**
`--mode structured` ungrounded measured **44.4% fact recall / 62.5% vocabulary agreement**
(disagreements: `is-found-in`→"has-habitat" ×2, `has-heart-count`→"has-number-of-hearts").
`--mode baseline` ungrounded measured **16.7% / 33.3%** — much worse, because structured decoding
helps a lot on its own. `--ground` is wired for **baseline mode only**, so the A/B is
**16.7% / 33.3% ungrounded vs grounded**, NOT against the structured figure. Grounding structured
mode means threading the section through `extractWithOllama`, which is unbuilt.

**THE GROUNDED RUN WAS ATTEMPTED AND PRODUCED NO SCORE — RE-RUN IT.** It exited 0 and printed only
`Grounding: offering 16 predicates (8 matched to the source text), 24 entities, +1200 prompt chars`,
then no report. So the selection half is confirmed working (16 predicates survive the filters, half
of them matched to the source text, 1200 chars of prompt) and the *effect* half is **unmeasured**.
Suspect the model produced nothing scoreable within the window; re-run without the grep so the
failure is visible, and check `finish_reason` — the reasoning-budget trap from `b2341e3` bites here
too, and the grounding section adds 1200 chars to an already long prompt.

**Do not claim F136 works until the baseline-vs-grounded pair moves.** Then commit, and
update `kb:vocabulary-grounding` (currently `planned`) with the measured result — honestly, including
if it does nothing.

### ▶ MATT'S ASKS THIS SESSION — three of four are still unbuilt

1. ~~Active query of the graph while extracting~~ → F136, built above, measurement pending.
2. **Active "listening"/extraction from Shelly chat AND Claude Code** — unbuilt.
3. **Ambient gathering of app usage → suggested triples** — unbuilt.
4. **Shelly as a front end to a Claude Code terminal** — unbuilt; answered as a design question.

**The architecture answer, grounded:** most of the bridge already exists. The MCP server lets Claude
Code read the graphs; `knowledge.pending.jsonl`/`knowledge.answers.jsonl` is already the shared
channel; and **`scripts/agent/desk.sh` already spawns a `claude` side-chat whose answers land in the
same file the UI writes** — the precedent, pointed the other way. **ONE THING BLOCKS THE LOOP:** the
app can only reach those files via `showDirectoryPicker` (`workspace.svelte.ts:164`) — a
Chromium-only manual folder pick. The fix is a **localhost sidecar**, same shape as Ollama (opt-in,
per-user, `settings.*`, no general backend) wrapping the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk` — Claude Code packaged as a library, honours the same credential
resolution as the CLI: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` OAuth
profile). It dissolves the folder-pick problem as a side effect, which is why it unblocks asks 2 and
3 as well as 4 — highest blast radius of anything outstanding.

### ▶ NEW ASK (Matt, 2026-08-15), NOT STARTED — Shelly should set "preview all" during getting-started

"Have Shelly set the all previews setting during the getting started story."

Groundwork already read, so don't re-derive it:
- The setting is **one** `PreviewMode` (`'manual' | 'auto' | 'all'`) in `src/lib/storage/preview-mode.ts`
  — F133 collapsed two booleans that could disagree. `'all'` = every node shows its preview and the
  layout spreads to fit; `'auto'` = the selected node's asset opens large, and its own hint already
  says it is **"built for story/explore walkthroughs"**.
- **DECIDED (Matt, 2026-08-15) — it is BOTH, in sequence, and the sequence is the point:**
  **`auto` immediately at the start of the story**, then **switch to `all` towards the end as the
  reveal.** So this is not one setting write, it is two at different beats, and the second is a
  deliberate show-off moment — the graph opening out from a guided one-node-at-a-time walk into the
  whole picture at once. Build it as two beats, not a single toggle, and do not "simplify" it to one
  mode later: the contrast between them IS the demo.
- That also settles the mutual-exclusivity problem — they were never meant to be simultaneous, they
  are the before and after of the same story.
- Shelly's action vocabulary is `KBAction` in `src/lib/types/turtle-chat.ts:19` — currently
  `adjust_view` / `add_triple` / `remove_triple` / `set_type` / `merge_entities` / `query_kb` /
  `scrape_url`. **There is no action that can change a setting**, so this needs a new one (e.g.
  `set_preview_mode`, or a general `set_setting` — prefer the narrow one; a general setting-writer
  hands the model a much larger blast radius than this task needs).
- `EXPLORE_SYSTEM_PROMPT` (`turtle-chat.ts:105`) is the getting-started/tour prompt that would use it.
- **Honest note for whoever builds it:** every existing `KBAction` either navigates or proposes a
  fact a human accepts. A setting-writer is the first action that changes app state with no review
  step, so it should follow the same accept-gate the destructive ones use rather than applying
  silently mid-tour.

**⚠ BLOCKED ON MATT, AND IT IS THE WHOLE PREMISE:** does his Claude Code subscription cover driving
the Agent SDK programmatically from an app, or does that path resolve to API billing? If the latter,
**the sidecar does not solve the cost problem he is building it to solve.** Confirm before building.
(Also note: `ant auth login` and Claude Code's own `/login` conflict — you keep one.)

### Environment notes (unchanged, still true)
- `npm` is not on PATH in a fresh shell: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- Script tier this session: **19/20**, the one failure being `status-evidence` (pre-existing) plus the
  known kernel-reboot finding (Matt's call — n8n host still on 6.8.0-110 with -117 installed).
- Ollama is up with 11 models; `qwen3.6:latest` (36B) is the strongest local extractor.

---

## OLDER CONTEXT (2026-07-31) — working branch `fix/indico-browser-reachability`
(cut from `plan/structured-data-source-watching`; **4 commits, local only, NOT pushed, no PR**).

## ▶ SERVERS ARE NOW MANAGED FROM HERE (2026-07-31)

`ssh indico` (72.60.70.188, Debian 12) and `ssh n8n` (194.163.44.66, Ubuntu 24.04) — keys at
`~/.ssh/indico_ed25519` / `~/.ssh/n8n_ed25519`. **The n8n host publishes AAAA first and this
machine has no IPv6 egress**, so the ssh config pins `AddressFamily inet`; without that it fails
as "Network is unreachable" and looks like the server is down.

- **Indico upgraded 3.3.8 → 3.3.12**, CORS granted, **F55 round trip CLOSED** — 8 live events →
  90 facts in the browser. Two things only a populated server revealed: the root category export
  **does not recurse** (so `indicoCategoryId` is REQUIRED — `.env` now sets `=1`), and Indico
  renders times in the **CATEGORY's** timezone, which the mapper was discarding (every event two
  hours off). Both fixed and tested.
- **n8n: weekly backup installed** (`/usr/local/bin/n8n-backup.sh`, cron Sun 04:17, keeps 8).
  There was NONE before. Uses SQLite `VACUUM INTO` because the DB is in WAL mode and a plain tar
  can capture a torn database. Captures the **encryption key** (56-byte `config`, the ONLY copy —
  without it credentials are permanently undecryptable) and ships a `RESTORE.md`. Verified by
  extracting and querying the archive, not by trusting the exit code.
- **`npm run offline` job `server-health`** + two `tasks.ttl` entries now watch both hosts.
  Public checks (incl. the CORS grant) run anywhere; ssh checks SKIP without keys, so CI is safe.

**⚠ OPEN, MATT'S CALL:** the n8n host runs kernel **6.8.0-110 with 6.8.0-117 installed** —
unattended-upgrades applies kernel security fixes and nothing ever reboots, so they are inert.
Needs a reboot window; it briefly drops the **live client workflow** (`Safe Haven Accounting`).
Also still open: `VITE_FEEDBACK_WEBHOOK_URL` in Cloudflare Pages (the workflow is now ACTIVE, but
the live site falls back to mailto until that build-time var is set).

**NEXT UP:** starter-graph timeline force still looks bad (Matt, 2026-07-31) — fix that next.
Then multi-integration scenarios (Shelly → schedule + Currents summary). **Note before planning
those: the Indico integration is READ-ONLY** — `client.ts` has fetch/search/get and no create, so
"schedule an appointment" is an unbuilt capability, not a wiring job.

## ▶ LATEST (2026-07-31) — F55 INDICO: the app could never reach a real Indico server

**The previous session ended mid-diagnosis and left a half-fix that made things worse:**
`src/app.html` had gained a `%RECKONS_EXTRA_CONNECT_SRC%` placeholder inside the live
`connect-src` directive, referencing a `cspConnectSrc` plugin in `vite.config.ts` **that was never
written**. So an invalid source expression was sitting in the middle of the security policy. It
also left an untracked live probe (`tests/tmp-indico/`, `pw-indico.tmp.config.ts`) whose captured
failure showed `Missing required parameter client_id` — which is a **Google OAuth** error, not an
Indico one, and which sent the diagnosis down the wrong path.

**TWO STACKED BLOCKERS, both invisible, both now measured:**
1. **CSP** — a per-user self-hosted origin can never be in a literal `<meta>` policy, and a meta
   CSP cannot be widened at runtime. The request was refused before being sent.
2. **CORS** — `indico.data-insight.website` returns **no `Access-Control-Allow-Origin` header at
   all**. Proven independently of CSP by fetching from a CSP-free local origin: still refused.

Identical requests return **HTTP 200 from curl/Node** and fail in Chromium. That is exactly why
`indico-verify.ts` was **6/6 green** while the product did not work — *the harness tested a layer
that enforces neither policy*. `kpred:has-status "functional"` was true of the API and false of
the product. **That is the lesson: match the claim to the LAYER it was tested at.**

**BUILT THIS SESSION (all green: 1635 unit tests, 0 type errors, graph-lint 0 errors, 3 new e2e):**
- `src/hooks.server.ts` + `scripts/offline/csp-connect-src.ts` — substitutes configured
  self-hosted origins into the CSP. **NOT a Vite plugin**: `app.html` is SvelteKit's template, so
  `transformIndexHtml` never runs on it — the plugin computed the right answer and applied
  nothing. Substitutes **origins only, never paths** (`VITE_FEEDBACK_WEBHOOK_URL` carries a
  secret-ish path and the CSP ships publicly).
- `src/lib/integrations/indico/reachability.ts` — turns `TypeError: Failed to fetch` into a
  message naming the layer that refused and the fix **that layer** needs (different machines!).
  A `securitypolicyviolation` listener *proves* CSP rather than guessing.
- The three calendar sub-tabs shared **one `error` variable**, so a Google failure rendered under
  the Indico panel. Indico now has its own.

**VERIFIED END TO END:** against a CORS-enabled stand-in the real UI imports
**"Imported 1 events (12 facts)"** with the review badge at 12 — pointed at `127.0.0.1`, which
`http://localhost:*` deliberately does NOT cover, so the substitution itself is exercised. Both
production builds checked: origins present when configured, **no placeholder in the empty case**
(which is what reckons.ai actually ships).

**⚠ BLOCKED ON MATT — I cannot do this, it is a server change:**
Add `Access-Control-Allow-Origin` at `indico.data-insight.website` (or its reverse proxy) for the
app origin. Until then the live import stays blocked *by the browser, by design* — but now says so
legibly instead of failing as a mystery. **Deliberately NOT done:** routing through
`r.jina.ai`/`corsproxy.io`, which would hand a personal Indico token to a third party.

**Still unproven (do NOT upgrade):** category sync beyond root (the server reports no categories
from the root listing) and background/periodic sync.

**Leftovers:** `tests/tmp-indico/cors-proxy.mjs` (the CORS stand-in — reusable, untracked) and the
previous session's `indico-live.test.ts` / `pw-indico.tmp.config.ts`. All untracked scratch,
disposable. Durable coverage now lives in `tests/e2e/indico-diagnostic.test.ts`.

---

## ▶ PREVIOUS (2026-07-30) — working branch `feat/archive-gallery-grouping`
(**PR #170 → `dev`**, base verified).

## ▶ LATEST (2026-07-30) — F97 HAS AN ENTRY POINT. The gap named on 2026-07-29 is closed.

`/kb` now carries an **"archive old events"** control on the current graph: set a day threshold,
read a plan, confirm, and aged-out events move to `<parent> (archives)` and appear in the gallery.
`src/lib/rdf/archive-sweep.ts` is the pure planner (19 tests, **mutation-checked five ways**);
`sweepArchiveByAge` reuses `runArchive`'s ordering guarantee. **F97.1 scaffolded → functional**,
**F97 planned → in-progress**. 1441 unit tests, 0 type errors, script tier 12/12, align green.

**Three conservatisms, each REPORTED to the user rather than hidden:** an UNDATED entity is never
swept (falling back to ingest time would silently become "archive what I imported a while ago");
an entity is judged by its **newest** date; an entity carrying **unreviewed** facts is held back,
because archiving by subject-or-object would carry pending facts out of the review queue.

**STILL UNBUILT — do not read "in-progress" as "auto-archive works":** no schedule, no threshold
trigger, no proactive nudge; the sweep is current-graph-only; and the production **delete, merge
and prune** paths still bypass the archive entirely. Only age-drop is wired.

**THE LESSON LANDED AGAIN, THIRD TIME RUNNING.** The first live sweep threw **DataCloneError** —
Dexie stores structured clones and a Svelte 5 `$state` array hands out Proxies that
`structuredClone` refuses. **Every unit suite was green**, because a mocked Dexie clones nothing,
and the gap had never fired because nothing in `src/` had ever called `runArchive` with live store
state. Found by **looking at the failure screenshot**. Fixed inside `runArchive` (not the call
site — a forgetful caller throws between the archive write and the working-graph delete) and
pinned with a test that runs `structuredClone` over what was written. A second look at the phone
screenshot showed the destructive button rendering as borderless coral text that read as a
hyperlink; `button.danger` is borderless by design for dense "remove" links. Affordance restored
and asserted. **Every other write path in the app already JSON round-trips before Dexie** — the
archive was the one that did not, and it was the one nothing called.

**Visual coverage expanded:** `tests/visual/user-stories/archive-sweep.test.ts` screenshots the
panel at desktop and 412px and asserts the two properties the gallery bugs broke (spanning /
stranding, horizontal overflow) plus the 44px touch minimum.

**MATT ASKED: why do agents use markdown and jsonl instead of Reckons.AI?** Answered with
measurements, not opinion — see the three entries queued to `knowledge.pending.jsonl` on
2026-07-30 (`agent-write-path`, `pending-triage-debt`, `work-session-entity`). Short version:
**jsonl is deliberate** (F52 — agents propose, humans settle) and the mechanical half of a handoff
is **already graph-native and good** (`npm run brief`). Two things are genuinely missing: the
drain terminates in a **Chromium-only manual folder pick** (`showDirectoryPicker`), and the graphs
model the **product** (187 features) but nothing models the **work** — no session entity, and no
way to say "I retested this and the earlier finding was false". **The queue is 583 deep and has
never been cleared**, which is the triage-cost trap F74.3 warns about, measured on our own dogfood.
Everything below the "SESSION 2026-07-23" block is the older F97 context and is still live
(PR #119 is still open) — read it after the current standing.

## ▶ LATEST (2026-07-29) — F97.1 gallery display, and the gap it exposed

**PR #170 → `dev`.** Build-order step 2 from this file ("show the archive graph beside its
parent in `/kb`") was still unbuilt — `archiveOf` existed in storage and appeared **nowhere in
the UI**. It does now: an archive renders nested under its parent, badged, with its fact count.
`src/lib/storage/archive-gallery.ts` is the pure half (no sorting of its own, so the gallery's
recent/name/size order still wins). It adopts **legacy archives linked by parent NAME**, keeps an
**orphaned archive visible and labelled**, and never nests an archive under another archive.

**🚨 THE REAL FINDING — F97 HAS NO ENTRY POINT.** Nothing in the app calls `runArchive` or
`ensureArchiveKb`; grepping `src/` finds no caller outside `archive-store.ts` and its tests. No
"archive now" action, no age threshold, **no sweep**. So the storage layer, restore-on-reference,
retention and now the gallery display all exist and **no user action reaches any of them** —
F97's own headline ("auto-archive of events older than a configurable threshold") is unbuilt.
F97.1 therefore **STAYS `scaffolded`**; the display is proven against SEEDED data only, which is a
smaller claim than "the feature works". Recorded as F97.1 `kpred:remaining`.
**This is the next highest-leverage F97 step** — until it lands, every phase below F97.1 is a
component of a feature nobody can start.

**LESSON, again, the same one:** two bugs were found by **LOOKING at a screenshot**, and both
test suites passed on both. The orphan badge used `var(--warn, var(--accent))` and **there is no
`--warn` in the palette**, so a caution rendered as a brand-teal chip identical to `current`; and
the archive's `open` button reused `.kb-switch-action`, which the mobile block gives
`grid-column: 1 / -1`, so it spanned full width and stranded `open tab` alone at 412px. Also
worth keeping: the 13 unit tests were **mutation-checked** (break the logic three ways, watch the
suite fail) before being trusted.

**LOCAL REVIEW HIT RATE, measured again:** `qwen3-coder` queued **14 findings, 0 actionable** on
this branch. Eleven were verified-false (it claimed `groupRows` was not imported — line 42; it
claimed the archive's tab link should point at the PARENT, which would be the bug). Three were it
re-deriving the missing-entry-point gap from the TTL, i.e. the honest-note working. Consistent
with the recorded ~1-in-26 rate: **run it, never merge it wholesale.**

**TWO ENVIRONMENT TRAPS HIT AGAIN — not code regressions:**
- **Playwright browsers were missing** (`chromium_headless_shell-1228`). `npx playwright install
  chromium`. This is the third time it is recorded; it still wants a CI/dev guard.
- **3 unit tests failed on a STALE `node_modules`**, not a real break:
  `scripts/offline/__tests__/dependency-overrides.test.ts` — `package.json` overrides `adm-zip`
  to `0.6.0` (#159) while the installed tree had `0.5.18`, and `brace-expansion` 5.0.7 vs 5.0.8.
  **`npm ci` fixed it; the full suite is 1415/1415 green (109 files).** The test was correctly
  detecting an install that did not carry the security overrides — believe it, run `npm ci`.
- **`npm` is not on `PATH` in a fresh shell here.** Use
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.

**Confirms the 2026-07-28 correction:** the old "four store suites flake together" entry did NOT
reproduce. One full run, 1415/1415. Do not carry it forward as current state.

## ▶ VERIFIED CORRECTIONS (2026-07-28)

- **First-run ingest hang: FIXED 2026-07-18.** Parallel consent requests previously shared one
  `_pending` slot, so the second caller replaced the first caller's resolver and orphaned its
  promise. The consent store now queues callers; the regression explanation and guard are in
  `tests/e2e/first-run-model.test.ts`.
- **Full unit run: GREEN.** The reported four-suite store flake did not reproduce: 100/100 files,
  1317/1317 tests passed in one full run. Do not carry the old failure forward as current state
  without reproducing it again.
- **The July dev/main divergence was reconciled by #145 and #148.** Commit-count divergence after
  that promotion is merge-ancestry noise; the real maintenance delta on 2026-07-28 was four files:
  `package.json`, `package-lock.json`, `.github/workflows/safety-attestation.yml`, and
  `static/reckons-safety-log.ttl`. This branch merges those production changes back into `dev`
  with zero conflicts so a later promotion cannot revert the dependency/workflow updates.
- **Extension Build & Sign fails before signing.** All observed runs die at `Build extension`;
  a local extension build succeeds. The unguarded
  `readdirSync(node_modules/@huggingface/transformers/dist)` in `vite.extension.config.ts` is a
  hypothesis, not a diagnosis, because the expired CI log cannot confirm the thrown error.
- **Dependabot currently reports three high alerts** (`sharp`, `adm-zip`, `brace-expansion`).
  They are transitive and absent from the browser bundle, but remain real exposure for people
  installing/running the repository and still require documented reachability and remediation.
- **Script tier: 12/12 clean** on 2026-07-28, including 1317/1317 unit tests, zero type errors,
  graph-lint with zero errors, and a 6/6 safety attestation.

## ▶ SHIPPED TO PRODUCTION (2026-07-23, post-announcement)

**dev → main promotion MERGED (#148). `dev` is 0 commits behind `main`.** Production verified
live: reckons.ai/starter-everyday.ttl is 17 KB, carries the event nodes, and contains ZERO
`data:image` blobs — the unlicensed portraits are off the public site.

Merged to dev then promoted, all CI-green (E2E, CodeQL, deploy gate, script tier, align):
- **#149** fix(indico): personal tokens need `Authorization: Bearer`, not `?ak=` — the legacy
  param returns `400 Malformed API key` on Indico 3.x. Verified against the live server.
- **#150** fix(timeline): nodes land on the date they name (`src/lib/rdf/parse-date.ts`).
- **#151** feat(starter): nine event nodes with dateTime starts, nine CC0/PD photographs each
  carrying creator + licence + source page IN the graph, entity-type presentation predicates
  made meta (no more "tetrahedron"/"#e0a13c" literal nodes), portraits removed.

**F55 INDICO IS NOW VERIFIED — the task earlier recorded as blocked is DONE.** #149 supplied the
server URL that was missing. Run it again any time:
`npx tsx scripts/offline/indico-verify.ts --server=https://indico.data-insight.website`
It is **6/6 green** and repeatable, and it independently reproduced the `400 Malformed API key`
on a deliberately bad token. STILL UNPROVEN — recorded as such, do NOT upgrade the status:
category sync beyond root (the server reports NO categories from the root listing), and error
surfacing in the INGEST UI — the client throws legibly, whether the UI shows it is a separate
claim that nothing tests.

**Two main workflows, honestly:** Safety Attestation is now GREEN (it was one of the two
long-standing reds). **Extension Build & Sign still FAILS** — pre-existing, unrelated to this
work, at the `Build extension` step before any signing step.

**Open on main, NOT touched this session:** 3 high Dependabot alerts (sharp, adm-zip,
brace-expansion). See the 2026-07-28 correction above for reachability.

**STILL MATT'S CALL:** `kpred:portrait-image-rights` — the removed portraits. If their provenance
was fine they can return, but they must carry credit like every other image now does.

**OLDER FLAKE REPORT — NOT REPRODUCED 2026-07-28:** the four reported store-suite failures did
not recur in a full 1317/1317 run. Treat this as historical evidence, not a current failure.

**LESSON WORTH KEEPING:** the licence check passed on THREE images that were still wrong — a
Second Life screenshot for "campfire", an Arizona signboard for a Sierra campsite, and a
Wikimedia "Lake George" whose own Credit field said *Lake Mamie*. Only LOOKING at them caught it.
Determinism buys "the rule fired", never "the rule was right". Wikimedia Commons searched
DIRECTLY beats Openverse keyword search for place-specific photos — Commons indexes by place.

---

## ▶ LATEST (2026-07-23, post-announcement) — PR #151, starter graph

**Matt has ANNOUNCED.** `feat/starter-graph-events` → **PR #151 → `dev`** (base verified).

**Shipped in #151:** nine EVENT nodes on the getting-started graph with `xsd:dateTime` starts
(so the time layout reads hour-by-hour), each option's cost expressed as the events it deletes
(`p:ruled-out-by`); nine CC0/public-domain photographs vendored by
`scripts/offline/fetch-starter-images.ts` with creator + licence + source page recorded IN the
graph; entity-type presentation predicates (`icon`/`color`/…) made meta so `"tetrahedron"` and
`"#e0a13c"` stop rendering as literal nodes; "Trip Leg" → "Drive".
Verified: 1332 unit tests, graph-lint 0 errors, align green, check 0 errors.

**⚠ REMOVED, and Matt must decide the replacement:** Alex's and Jordan's portraits were base64
photographs of REAL, IDENTIFIABLE PEOPLE with no creator, licence or source — on the graph the
public landing page serves. Replaced with emoji; file went 83 KB → 16 KB. Queued as a partial
fact `kpred:portrait-image-rights`. **If their provenance was fine, they can go back — but they
must carry provenance like every other image now does.**

**LESSON WORTH KEEPING:** the licence check passed on THREE images that were still wrong — a
Second Life screenshot for "campfire", an Arizona signboard for a Sierra campsite, and a
Wikimedia "Lake George" file whose own Credit field said *Lake Mamie*. Only LOOKING at them
caught it. Determinism buys "the rule fired", never "the rule was right".
Wikimedia Commons searched DIRECTLY (Matt's tip) beat Openverse keyword search for
place-specific photos — Commons indexes by place.

**F55 INDICO — PAUSED MID-TASK at Matt's request. Resume here:**
- DONE: `VITE_INDICO_SERVER_URL` / `_API_TOKEN` / `_CATEGORY_ID` now seed `DEFAULT_SETTINGS`
  (`db.ts`). They previously reached NOTHING — db.ts seeded ~15 other credentials from
  `import.meta.env` and skipped the Indico pair, so the token in `.env` was dead. Documented in
  `.env.example`. 20 offline tests pin the client contract.
- **NOT DONE:** `scripts/offline/indico-verify.ts` is written but **NEVER RUN**. It is BLOCKED on
  a server URL — `.env` carries only the token, and `indicoServerUrl` is an in-app setting.
  Resume with: `npx tsx scripts/offline/indico-verify.ts --server=https://<your-indico>`
  `kb:int-indico` records the integration as UNVERIFIED against a live server. Do not upgrade
  its status until that harness has actually run green.
- Note `vite-secret-guard` already matches `VITE_*TOKEN`, so a PUBLIC build with the token set is
  correctly BLOCKED. The env var is a local-dev/self-host convenience only.

**HISTORICAL — RESOLVED:** the dev→main promotion concern below was resolved by #145 and #148.
The later full run on 2026-07-28 passed 1317/1317 tests; do not use the old branch counts or
store-suite failure as current evidence.

---

## ▶ CURRENT STANDING (2026-07-23) — pre-announcement push

Goal: comfortable announcement by end of week. Seven PRs landed on `dev` this session; two
things now block a fully-working announcement and BOTH are Matt's to do (not code):

**Merged to `dev` today:**
- #138 Blender GLB export + `checkGlb` emptiness guard (F90 scaffolded→ GLB done; still not an
  MCP tool, still can't be spawned from the browser — needs an agent/sidecar path).
- #139 Landing "what we believe": 7 tenets → 3 + "Show 4 more".
- #140 F58.4 roadmap decision: Reckoning output-type selector + target-node picker; asset
  outputs land as PENDING (Matt's call), needs a review-queue preview affordance that doesn't exist.
- #141 gitignore `tests/visual/results/button-crawl_*.json` — 577MB was untracked+unignored.
- #142 + #144 FEEDBACK: in-app form → n8n webhook → email, reachable from every page (nav ✎),
  opens in place, captures coarse source route (privacy: first path segment only).
- #143 stabilization sweep (F107.1 MCP trust boundary, F107.4/.5 sync, **F107.6 delegated Hume
  token** — was uncommitted, now in). CodeQL caught a real HIGH in this branch: a TOCTOU in
  `mcp-server/src/kb-reader.ts` (statSync+readFileSync → stale triples served forever); fixed
  with a single fd. Plus a shell-injection in `graph-economics.ts --since=`, fixed.

**BLOCKING the feedback announcement — Matt only, I cannot do these:**
1. **SMTP credential** on the n8n workflow. Workflow built + created (unpublished):
   https://n8n.srv814827.hstgr.cloud/workflow/93gfOyLx8pzcMoka — Send node wants an "Outlook SMTP"
   cred (smtp.office365.com:587, STARTTLS, mailbox login / app password). Then ACTIVATE it.
2. **`VITE_FEEDBACK_WEBHOOK_URL`** in Cloudflare Pages env = the webhook URL, then redeploy.
   Until set, the LIVE site's feedback still falls back to mailto — the endpoint is build-time
   product config, deliberately NOT the user's own `n8nBaseUrl` (routing that through the user's
   instance silently 404'd feedback from anyone running their own n8n — fixed in #144).
   Once both are done, ping me and I'll fire a test submission through the production webhook.

**Salvage — pushed, deliberately UNMERGED:** `salvage/codex-orphaned-tests` holds ~1200 lines of
Codex test/bench work that existed only inside two abandoned worktrees (now removed). The bench
suite is fixed (a hallucinated `EXTRACTION_SYSTEM_PROMPT_COMPACT` import — renamed to `_FEWSHOT`
2026-07-12 — meant a safety-preamble test had NEVER passed). The 4 VISUAL specs are UNRUN; the
`docs-testing.ttl` rewrite is unreviewed. Triage before merging. A `kb-seed.ts` regression (reverted
a rename-tolerant tab lookup) was dropped, not salvaged.

**MERGE LANDSCAPE (as of 2026-07-23, for the dev→main promotion question):**
- `dev` is 23 commits ahead of `main`; `main` is 11 AHEAD of dev (hotfixes applied directly:
  3D webgl toggle 7a74326, mobile 44px, /history hang, + recurring safety attestations). A
  dev→main promotion must reconcile those — and 7a74326 touches the SAME `+page.svelte` WebGL
  block a #143 conflict already resolved, so expect that file to need attention.
- Open PRs: #119 (F97 archive → dev, large, prior work — see below), #136 (filter panel → dev),
  #137 (wasm cleanup → dev), #131/#132/#133 (dependabot → **main**), #120 (council → a feature
  base, not dev/main).
- **NEVER merge to main without explicit production intent; verify resolved base first** (CLAUDE.md).

---

## OLDER CONTEXT (2026-07-18) — F97 archive, PR #119 still open

**Branch: `feat/archive-graph`** → **PR #119 open against `dev`** (base verified). Continue F97
on that branch, or branch fresh off `dev` if #119 has merged.

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
1. ~~**Store adapter**~~ — **DONE** (`src/lib/storage/archive-store.ts`, 11 tests). Ordering is the
   design: archive write FIRST (bulkPut, so a retried partial archive converges), working-graph
   delete SECOND. A crash between them duplicates facts (recoverable) instead of destroying them.
   A test pins that order — do not invert it. `KbEntry.archiveOf` links archive → parent.
   **It also exposed a real bug, now fixed:** `createKb` used `kbase_${Date.now()}`, so two graphs
   created in the same millisecond shared ONE Dexie database. Regression test creates 25 in a tick.
2. **Settings-page display** — show the archive graph beside its parent in `/kb`, using
   `KbEntry.archiveOf`. **NEXT UP — start here.**
3. **F97.3 restore-on-reference** — wire `findArchivedReferences` into the ingest path. This is a
   REQUIREMENT: without it every archive sweep seeds the next round of duplicates.
4. **F97.7 archive search**, **F97.5 time-travel**, **F97.4 recurrence** (reuse `recurrence.ts`).

`detectChurn` (F97.6) already routes into `analysis-advisor.ts` via `churningEntities` — the
advisor just needs the archive journal passed to it at the call site.

## 🔧 OFFLINE TIERS ARE NOW WIRED — USE THEM (2026-07-18)

CLAUDE.md now has a **RUN-THESE table** of literal commands. Use it. This session read the tiering
doctrine at startup and still did hours of work at Opus tier with Ollama idle — the fix was
commands, not more philosophy.

- `.mcp.json` is now committed, so the `reckons` MCP server connects on next start (6 graphs,
  3946 triples). `mcp-workspace/` is gitignored but `bash scripts/setup-reckons-workspace.sh`
  rebuilds it and **exits non-zero on a dangling link** — it had silently drifted to 3 graphs.
- `mcp-server` no longer dies on a missing `--kb` with a raw ENOENT; it prints the fix.

**MEASURED agent-tier hit rate (be realistic about triage cost):** across two local `code-review`
runs, **26 findings, 1 genuinely actionable** — but that one was a real graph-wipe path in
`restoreSnapshot` that Opus wrote and missed. The rest were rejections: misread intent, or checks
that already existed four lines away. So the tier IS worth running before a PR, and its output is
NOT worth accepting wholesale. Triage every finding out loud.

## 👆 VISUAL / CLICK-WALKTHROUGH GROUNDING (2026-07-18)

The visual suite had been **unrunnable locally** since the dep upgrade (missing Playwright
browsers), so its reported state was fiction. Now runnable and much healthier — but read the
numbers carefully.

**Fixed:** `tests/visual/eval-stable.ts` retries the SvelteKit navigation race
("Execution context was destroyed") that was killing 10 of 47 workflow tests AND 4 of 6 crawler
routes. `gotoStable()` retries the vite/service-worker `net::ERR_ABORTED` that
`tests/e2e/helpers.ts` already handled but the visual harness did not.
**Workflow suite: 37 passed/10 failed → 42 passed/5 failed.**

**✓ ALL 5 remaining failures FIXED — suite is 47/47 green** (verified on a full run, not per-file).
They were stale TESTS, not app bugs. The app was fine; the tests had drifted:

- **Four shared one cause**: `getByText(/graph package/i)`. That panel MOVED from the main graph
  view to the GRAPHS tab — `routes/(app)/+page.svelte:1942` says so, and `svelte-check` had been
  reporting `.pkg-disclosure > summary` as an unused selector ever since (markup left, dead CSS
  stayed). The two `context-gathering` tests were proving "facts appear in the graph" by looking
  for an unrelated panel's LABEL; they now assert `.node-label`. The two `graph-sync` tests now
  navigate to `/kb`, and the OPFS one had to be REORDERED — `__linkHandleForTest` holds the handle
  in memory, so navigating after linking silently dropped it.
- **The fifth was two bugs stacked**: the navigation race inside the test's own `page.evaluate`
  (evalStable only covered the harness), and behind it `.diff-entry` — a selector that could never
  match, since `DiffEntry.svelte`'s root is `.entry`.

**Lesson worth keeping:** a test that proves X by asserting Y breaks when Y moves, and tells you
nothing about X. Assert the behavior the step claims to prove.

**⚠ Dead CSS still to remove:** `.pkg-disclosure` rules at `routes/(app)/+page.svelte:2750-2766`
have no markup left. Part of the 81 `svelte-check` warnings.

**Button crawler (`scripts/offline/button-crawl.ts`, still `enabled:false` — needs a live server):**
- Coverage 2/6 → **6/6 routes**, 32 → 133 clicks. It used to skip failed routes and still print
  "crashes: 0"; it now reports COVERAGE FIRST and names every route it could not crawl.
- Silent no-ops **21 → 2** by learning what a working button looks like: downloads, native file
  pickers, already-active toggles, and — the big one — an active-control fingerprint, because
  bits-ui marks selection with `data-state="on"`/`aria-checked`, not `.active`, so every working
  toggle in the app read as dead. Verified against `/review` layout chips.
- Both survivors are explainable: `📁 link a folder` uses `showDirectoryPicker()` (not automatable
  headless) and `export subset` still wants a look.
- `--device=pixel|iphone|ipad|desktop` added. **The 44px rule is a TOUCH rule** — desktop counts
  are advisory and the report now says so via `touchTargetsMeaningful`.

**▶ REAL FINDING, NOT FIXED: 58 sub-44px touch targets at Pixel (412×915)** — `/ingest` 13,
`/about` 12, `/settings` 11, `/kb` 10, `/review` 9, `/` 3. Systemic: the chip/tab controls across
the app are under the touch minimum. This is an **F36 mobile blocker** and maps to the
`touch-targets` guideline in `kb:web-uiux-rubric`. Reproduce with:
`BASE_URL=http://localhost:5174 npx tsx scripts/offline/button-crawl.ts --device=pixel`

## ✅ FIRST-RUN BLOCKER — FIXED 2026-07-18

**Historical diagnosis; no longer open.** Found by the new
`tests/e2e/first-run-model.test.ts`. Measured on vite dev + chromium + mock extraction backend:

Accepting the 33 MB embedding-model download **succeeds at the network layer** — 44.4 MB arrives,
all HTTP 200:
- 34.0 MB `model_quantized.onnx` (huggingface xet CDN)
- 4.7 MB `ort-wasm-simd-threaded.asyncify.wasm` (**cdn.jsdelivr.net**)
- tokenizer.json / config.json / tokenizer_config.json

…and then **the ingest pipeline never proceeds.** Still on `/ingest` after 240 s: no error, no
console output, no progress indicator, no recovery. **Declining** the same prompt finishes in
seconds via the structural fallback — so the fault is specific to the ACCEPT path, *after* the
model is already downloaded.

For a first-time user this is the worst-shaped bug available: consent to a large download, pay for
it, get a frozen screen that never explains itself.

**Still NOT localized, and one hypothesis is now RULED OUT.** `embed.ts` had no load timeout
(wasm.ts has had a 90 s one for ages) — that gap is real and is now fixed, but it is **not this
bug**: the timeout does not fire, which proves the load RESOLVES (44.4 MB arrives, pipeline
builds) and the stall is downstream on the WASM execution provider.

Also ruled out: **WebGPU is not involved.** Verified with a software-GPU chromium
(`--enable-unsafe-swiftshader`) — `requestAdapter()` returns null there, so the run never touched
WebGPU. The `No available adapters.` console line is ORT bundle noise, not the fault.

**✓ REPRODUCED IN A REAL, VISIBLE BROWSER (2026-07-18).** Headed chromium on X11 (:1), machine has
two RTX 3090s, launched with `--enable-unsafe-webgpu` so `requestAdapter()` returns a genuine
adapter. Stalls identically past 240 s. **So this is NOT a headless artifact** — my earlier caveat
is resolved and the blocker is real.

Two things ruled out along the way:
- **Not the embed load.** `embed.ts` had no timeout (now added, 90 s, mirroring wasm.ts). It does
  NOT fire — proving the load resolves and the stall is downstream.
- **Not WebGPU.** Reproduces both with no adapter and with a working one.

**The sharpest clue: ZERO console output for 150 s after accepting.** No error, no warning, no
failed request, nothing. Combined with the UI returning to an EMPTY INGEST FORM rather than showing
a spinner, this looks like a silently-pending promise or a swallowed rejection, not a busy loop.
Whatever awaits never settles and nothing reports it.

**Still open**: embedding inference over the diff? semantic-diff? the awaited ingest pipeline?
Localizing needs source instrumentation (temporary logs through `ingest.svelte.ts` →
`semanticEnrichDiff` → `embedMany`), which is the obvious next step. Still **NOT reproduced against
a production build** — worth confirming, since dev-mode module loading differs.

**Also found, not acted on:** with `--enable-unsafe-webgpu` the adapter that appears is
**swiftshader (software)**, vendor "google", not the NVIDIA hardware. `device-select.ts` currently
accepts ANY adapter — and a software WebGPU adapter may well be SLOWER than WASM, which would make
selecting it a pessimization. Worth benchmarking and, if confirmed, preferring hardware adapters
(`adapter.info.architecture !== 'swiftshader'`) before shipping WebGPU as a default win.

Reproduce: `RECKONS_TEST_WASM=1 npx playwright test first-run-model --project=desktop-chrome`

**Related, queued as an observation:** transformers.js fetches the ONNX runtime from
**cdn.jsdelivr.net at runtime**, even though the PWA precaches ~67 MB of ort-wasm locally
(`vite.config.ts` globPatterns). If the precached copy is not the one being used, that precache is
dead weight AND offline-first WASM inference does not work offline. Check this before the
PWA-precache toggle work lands.

## ⚡ LOCAL-MODEL EXECUTION PROVIDER (2026-07-18)

**WASM is the ceiling, not the escape hatch.** ONNX Runtime is the engine; WASM/WebGPU/WebNN are
its execution providers. wasm32 linear memory is bounded by a 32-bit address space (browsers land
well below it; iOS tighter still). **WebGPU is how you run larger models** — weights live in GPU
buffers outside wasm linear memory.

The app was on neither optimal path until now: `numThreads = 1` (multi-threaded WASM needs
SharedArrayBuffer → COOP/COEP headers, **not set anywhere**), and no `device` was ever specified,
so both paths defaulted to WASM — while the build already shipped `ort.webgpu.bundle.min.mjs`.

`src/lib/integrations/llm/device-select.ts` (13 tests) now picks WebGPU **only when a real ADAPTER
exists** — not `'gpu' in navigator`, since WebGPU is routinely present-but-unusable — and wraps
construction too, because an adapter can appear and still fail at build time. It reports the device
that SUCCEEDED, never the intended one. Wired into `wasm-worker.ts` and `embed.ts`.

**Still on the table:** multi-threaded WASM via COOP/COEP. Big CPU win, no GPU needed, but the
headers break cross-origin embeds — and note the runtime currently fetches ort-wasm from
**cdn.jsdelivr.net**, which such an audit would have to cover.

## 👆 FIRST-RUN CONSENT GATE — now covered (2026-07-18)

`tests/e2e/first-run-model.test.ts` — 12 passing, no network. Previously **zero** coverage: every
other suite runs on mock backends AND `helpers.ts` installs a consent dismisser that clicks
"Not now" the instant a prompt appears, so the first thing a real user meets was the one thing the
tests stepped around.

Covers: the gate appears before anything downloads; it names the model and MB; declining and
Escape both resolve without wedging the awaited pipeline; the sideload hatch exists. Constrained
device (iOS UA): graceful Ollama / API-key / tiny-model offers instead of a ~500 MB load that can
OOM-crash the tab, the risky option honestly labelled "may crash", and the chat-only warning.

**Behavior worth knowing:** a keyless first run asks **twice** — Qwen2.5-0.5B (~500 MB) then
bge-small-en-v1.5 (~33 MB). Correct (separate models, separate consent), but tests must drain the
QUEUE. Two of mine assumed a single dialog, and one was *flaky rather than failing* because
resolving the first consent re-shows the shared `.consent-dialog` selector almost instantly. Assert
that the queue ADVANCED, not that the dialog vanished.

**DEFECT pinned (test.fail):** on the constrained path, "Try a tiny model" pushes guidance saying
the model switched and that a tiny model cannot reliably extract facts — then the next consent
modal immediately covers it. The user is told something important and cannot read it.

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
