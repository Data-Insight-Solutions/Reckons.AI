# Handoff archive — sessions 2026-07-16 to 2026-08-15

Split out of `HANDOFF.md` on 2026-08-21 because that file had grown to 2,377 lines
(~33k tokens) and CLAUDE.md orders every session to read it first — so a month of
closed sessions was being paid for on every single startup.

**Nothing was deleted.** Everything below is verbatim. Grep it when you need the
history (`grep -n 'F97' HANDOFF-ARCHIVE.md`), or query the graph, which is the
durable home for anything that was actually decided (kb:context-engine, F135).

---

## PREVIOUS SESSION (2026-08-15) — the extraction problem, measured properly at last

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

### 🚧 COMMITTED (`5f33879`) — F136 selector/benchmark scaffold (production wiring and measurement incomplete)

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

1. Active query of the graph while extracting → F136 selector/benchmark scaffold committed;
   production wiring and measurement remain pending.
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
  `scrape_url`. **There is no action that can change a setting.**

### ▶ DIRECTION SET (Matt, 2026-08-15): "Shelly needs CLI actions then."

**This supersedes the narrow `set_preview_mode` suggestion above, and it is the better shape.**
Rather than minting a bespoke `KBAction` per capability — one for preview mode, then one for the
next thing, then the next — Shelly gets **one action that dispatches to the `reckons` CLI's already
named, already bounded command surface**. The vocabulary problem is solved by reusing a vocabulary,
which is the same lesson F136 just learned about predicates.

**It unifies three separate asks into one piece of work:** the preview-mode beats, ambient
capture, and Shelly-as-front-end-to-Claude-Code all become "Shelly can invoke a named command",
executed by the same local sidecar. That makes the sidecar the single highest-leverage thing
outstanding — but note it is still gated on the billing question below.

**What exists today** (`cli/src/` — `index.ts`, `kb.ts`, `llm.ts`, `audio.ts`):
`ask` · `entity` · `ingest` · `kbs` · `list`/`ls` · `search` · `stats` · `use`

**⚠ THE GAP THAT STOPS THIS BEING A WIRING JOB — do not assume the CLI already covers the preview
ask.** Every command above is read-only except `ingest`. **None of them writes a setting**, so
`preview mode` is not reachable through the CLI today. "Shelly needs CLI actions" therefore lands
as TWO pieces of work, in this order: (1) give the CLI the commands the stories actually need —
a settings writer among them — then (2) let Shelly dispatch to them. Building (2) first produces a
front end onto a surface that cannot do the thing that motivated it.

**Design constraint, carried over and now sharper.** A dispatch to *named, allowlisted* commands is
a dedicated-tool surface: gateable, auditable, and each command can carry its own accept-gate. A
free-form shell string would be a bash surface — total breadth, nothing to hook. Take the former.
Every existing `KBAction` either navigates or proposes a fact a human accepts; a command that
changes state is the first that does not, so keep the accept-gate rather than applying silently
mid-tour. **`ingest` in particular is not a read** and should never fire un-gated from a chat turn.
- `EXPLORE_SYSTEM_PROMPT` (`turtle-chat.ts:105`) is the getting-started/tour prompt that would use it.
- **Honest note for whoever builds it:** every existing `KBAction` either navigates or proposes a
  fact a human accepts. A setting-writer is the first action that changes app state with no review
  step, so it should follow the same accept-gate the destructive ones use rather than applying
  silently mid-tour.

### ▶ NEW ASK (Matt, 2026-08-15), NOT STARTED — tie triple-fact REVIEW into Claude Code skills, via MCP and/or CLI

The direct consequence of parking the sidecar: if Claude Code is the agent Matt actually works in,
the review loop has to be reachable from there. **This is arguably the highest-value item in the
whole cluster**, because the motivation was already visible — the pending queue was reported as
**583 deep** in that session. The 2026-08-16 audit finds **421 current rows** and prior reconciliation
from 904 to 409; it has been pruned, but not drained through a working human settlement flow. That is
the triage-cost trap F74.3 warns about, observed on our own dogfood. Proposals are cheap to generate
and expensive to settle, and nothing has made settling cheaper.

**What exists (do not rebuild):**
- `kb_pending(kb?)` — Claude Code can already READ the queue.
- `kb_add_note(...)` — it can already PROPOSE into it.
- **`npm run desk` / `scripts/agent/interview.ts`** (`openQuestions` / `recordAnswer`) — the working
  precedent, and the model to copy: a terminal side-chat that asks Matt open questions and writes
  the **same `knowledge.answers.jsonl` the UI writes**, so the build session's agents resume without
  knowing which channel replied.

**The gap: nothing can SETTLE.** There is no `kb_confirm` / `kb_reject` / `kb_supersede` — the
review statuses (`pending`, `pending-removal`, `confirmed`, `refined`, `rejected`, `superseded`)
are reachable only through the Review tab in the app. So Claude Code can fill the queue and read it
and never drain it, which is precisely the asymmetry that produced 583.

**⚠ THE LINE THAT MUST NOT BE BLURRED, AND IT IS STRUCTURAL, NOT ADVISORY.** F52 is *agents propose,
humans settle*, and it is the product's core thesis, not a policy setting. **Matt settling THROUGH
Claude Code is still a human settling** — that is what `desk.sh` already does and it is fine. **An
agent confirming its own proposal is not**, and a `kb_confirm` tool available to the model makes
the two indistinguishable at the point of the write. Design so the distinction survives:
- The settling tool should carry the human's decision, not the model's judgement — the model's job
  is to PRESENT the fact well and record what Matt said, exactly as `recordAnswer` does today.
- An agent must never be able to confirm a fact **it proposed** in the same session. That is the
  self-verification failure the whole thesis exists to prevent: *an unverifiable claim, made by the
  party it benefits, is not evidence.*
- Provenance on every settle: which channel, which actor, when. A settled fact whose settler is
  unknown is worse than an unsettled one, because it looks reviewed.

**MCP or CLI?** Both are listed in the ask. The CLI is the better first home — it already has the
`reckons` command surface, the desk precedent lives there, and a terminal review flow is a HUMAN
sitting at a keyboard by construction, which makes the line above easy to hold. An MCP `kb_settle`
hands the same power to any model with the server configured, which is where it gets dangerous.
**Build the CLI path first; treat MCP settling as a separate decision with its own gate.**

### ▶ NEW ASK (Matt, 2026-08-15), NOT STARTED — "some sort of 'export to local agent' action/skill"

**The inverse direction of the CLI actions above, and — importantly — the one thing in this whole
cluster that is NOT gated on the sidecar or the billing question.** CLI actions are Shelly reaching
out to *do* things; this is the graph's context going *out* to something else to work on. An export
can be a file, a clipboard payload, or a written bundle. None of that needs a running local process,
so **this is the piece that can ship while the sidecar question is still open.** Start here if the
billing answer is slow.

**Most of the machinery already exists — on the MCP side only.** Do not rebuild it:
- `kb_compress(query, budget?, hops?, kb?)` — the compressed-context builder, the exact thing an
  export payload should be. Returns a relevant SLICE rather than the whole ~116k-token graph.
- `kb_entity_markdown(entity, kb?)` — **deterministic, no LLM**, renders one entity from its
  triples. Script tier; the obvious default for an export that must not hallucinate.
- `kb_local_extract` / `kb_local_summarize` / `kb_generate_page` — already route to a LOCAL Ollama
  model, opt-in via `OLLAMA_BASE_URL`, and already emit **proposals only, never writes**.

**So the gap is not capability, it is REACH:** every one of those is an MCP tool, so today the graph
can only be exported to an agent that speaks MCP and has the server configured. A user sitting in
Shelly has no way to say "hand this to my local agent". The ask is the in-app action for it.

**Two design notes worth settling before building:**
- **What is the payload?** `kb_compress` output (LLM-shaped, lossy, cheap) and `kb_entity_markdown`
  (deterministic, faithful, larger) answer different questions. Probably both, chosen by intent —
  but pick deliberately, because a lossy export that looks authoritative is the failure mode.
- **Which direction does the result come back?** If the local agent produces facts, they belong in
  `knowledge.pending.jsonl` like every other agent proposal (F52 — agents propose, humans settle),
  NOT written straight into the graph. An export path that quietly becomes an import path is how the
  review gate gets bypassed without anyone deciding to bypass it.

### ✅ DECIDED (Matt, 2026-08-15) — the sidecar is PARKED, and the billing question is no longer blocking

"I will just have to interface with Claude Code directly for now."

**So stop treating the subscription/API-billing question as a blocker — it is deprioritised, not
answered.** (For whenever it returns: the Agent SDK honours the same credential resolution as the
CLI, and `ant auth login` conflicts with Claude Code's own `/login` — you keep one.) Matt drives
Claude Code in the terminal; the app does not front-end it.

**The real dependency he named, and it is the right one:** *"core Shelly usage would need to be a
great local model, to execute and orchestrate all the skills correctly."* Shelly-as-orchestrator is
gated on **local tool-calling and orchestration quality**, not on transport. Building the sidecar
first would have delivered a pipe to a model that cannot reliably drive what is on the other end.

**What this re-sequences:**
- **`export to local agent` SURVIVES UNCHANGED** and is now clearly the next thing to build — it
  never needed the sidecar, and it is useful precisely because Matt is in Claude Code directly.
- **CLI actions are still worth building** for the app's own sake (the preview beats need them), but
  the *orchestration* layer on top waits on model capability.
- **F136 is unaffected** — extraction quality was always the separate, independent thread.

**⚠ THE CAPABILITY CLAIM IS UNMEASURED, AND IT IS NOW THE LOAD-BEARING ONE.** "A great local model"
is currently a judgement, not a number, and this project's whole doctrine is that an unverifiable
claim is not evidence. What IS known from this session's model survey: only some local models here
advertise tool-calling at all — `qwen3.6` (36B, tools+thinking), `qwen3-coder` (30.5B),
`devstral-small-2` (24B), `lfm2.5` (8.5B), `granite3.2-vision`, `llama3.2:3b` — while `gemma3:27b`
and `qwen2.5vl:7b` do **not**. `qwen3.6` is the strongest general local model on the box.
**Nothing has benchmarked any of them on multi-step tool orchestration.** `npm run bench:agentic`
(`tests/bench/run-agentic-bench.ts` + `agentic-tasks.ts`) exists and I did NOT run it, so I cannot
say what it covers — read it first rather than assuming it answers this. Turning "is a local model
good enough to orchestrate Shelly's skills?" into a measurement is the piece of work that unparks
everything above it.

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
way to say "I retested this and the earlier finding was false". **This section recorded the queue as
583 deep; the 2026-08-16 audit finds 421 current rows.** It has been reconciled/pruned before, but
not drained through a working human settlement flow, which is the triage-cost trap F74.3 warns about
on our own dogfood.
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

---

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
