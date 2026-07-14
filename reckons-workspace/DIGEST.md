

## Pre-announcement sweep — untested production features — 2026-07-13 02:23

### ❌ The '60-70% token reduction' claim was false — measured ~18%

`claim-falsified` · **kb:context-compression** · 2026-07-13T02:23:34.835Z · _claude-code_

First test ever written for kb_compress falsified its headline claim. The format saves ~18% vs grouped Turtle (what a real .ttl looks like), ~29% vs flat. The 60-70% figure conflated the ENCODING with SUBGRAPH SELECTION, which is where the real saving lives. Corrected in the roadmap, the architecture graph, and the PUBLISHED docs.

### 🐛 Confirming a fact made its source LESS trusted

`bug-found` · **kb:trust-system** · 2026-07-13T02:23:36.526Z · _claude-code_

getTrustScore discarded the baseline the moment any event existed. A trusted source collapsed 0.8 -> 0.05 on its first confirmation; 16 confirmations to recover. Using the review workflow correctly degraded your trust scores. Fixed: score = baseline + sum(delta * decay).

### 🐛 Citations were never verified — a fabricated quote shipped as provenance

`bug-found` · **kb:passage-grounding** · 2026-07-13T02:23:38.292Z · _claude-code_

The prompt says 'copy it exactly, do not paraphrase'. Nothing ever checked. triplesToStatements did not even RECEIVE the source text, so it structurally could not. Small models paraphrase constantly. For an app selling provenance, the user checks the receipt, it looks right, and it is a forgery. Now verified; a forged excerpt is DROPPED, not shown.

### 🐛 Rename destroyed standard vocabulary; merge doubled the graph

`bug-found` · **kb:predicate-manager** · 2026-07-13T02:23:40.002Z · _claude-code_

Three defects. Renaming rdfs:label or skos:broader rewrote them into urn:kbase:predicate/ — an interoperable term silently became a private one. Renaming onto an existing predicate silently MERGED. Merging created duplicate triples.

### 🚢 F66 publish gate built — publishing was ungated

`shipped` · **kb:publish-safety-gate** · 2026-07-13T02:23:41.716Z · _claude-code_

Markdown pages were built from UNFILTERED statements, and blocked content was SILENTLY DROPPED rather than refused. Now refuses and explains, on the mediated path only. Export stays a right.

### 🔶 What confidence should auto-merge at, without review?

`decision-needed` · **kb:auto-merge** · 2026-07-13T02:23:43.392Z · _claude-code_

Queued as a partial fact in the Review tab — answer it there, in Shelly, or by editing the triple. It blocks F80.1 only; everything else continues.

### 🐛 The cloud cron fired on time and produced nothing — silently

`bug-found` · **kb:local-orchestration** · 2026-07-13T02:25:45.335Z · _claude-code_

last_fired_at 2026-07-12T20:40:18Z, exactly on schedule. Zero commits, no error surfaced. Afterwards next_run_at still displayed a future time while enabled was false, so it LOOKED armed while being dead. A scheduler you cannot observe is not a scheduler. This is why orchestration comes home (F81).

### 🐛 PWA manifest locks orientation to portrait — on a graph app

`bug-found` · **kb:mobile-ui** · 2026-07-13T02:34:21.054Z · _claude-code_

vite.config.ts sets orientation:'portrait'. On a tablet this ruins the force-directed graph, which is the core surface. Raised as a question rather than changed unilaterally; it may be deliberate for phone onboarding.

### · Correction: the cron did not fail — the runner and the reporting did

`note` · **kb:local-orchestration** · 2026-07-13T02:35:54.509Z · _claude-code_

The cron fired at exactly 20:40:18Z as scheduled. The cloud AGENT produced no commits, and nothing surfaced that. Calling it 'the cron failed' would send us to fix the wrong component. Design conclusion: the QUEUE is the contract and the RUNNER is pluggable — in-app Web Worker for reach (every device), an optional desktop process driven by cron/launchd/Task Scheduler for wake-when-closed, MCP server when an agent is already connected. No single runner is load-bearing, so none can silently stop the system.

### 🐛 The graph view drew literals as nodes — 1234 nodes for a 233-entity graph

`bug-found` · **kb:graph-legibility** · 2026-07-13T02:51:48.077Z · _claude-code_

Not a perf problem: a modelling mistake in the view. 96% of distinct literal values in the roadmap appear exactly ONCE — leaves that connect nothing. A literal earns a node by being SHARED. Fixed: 1234 nodes -> 271 (78% fewer); 985 walls of text moved to the node panel.

### 🔶 TriG: what does the 4th element MEAN? (source vs KB — it cannot be both)

`decision-needed` · **kb:rdf-dataset-migration** · 2026-07-13T02:55:37.538Z · _claude-code_

Measured: 18 of 19 repo .ttl files declare 0-1 sources, so a named graph carries ZERO information for them — they stay .ttl forever. TriG earns its place at EXPORT: toTurtle() currently DROPS g, so after ingesting 5 PDFs and exporting, 'where did this fact come from?' is unanswerable. Its prov block is orphaned decoration. That is the real bug TriG fixes.

### 🔶 TTL/TriG is not a format choice — it is two products

`decision-needed` · **kb:ttl-trig-split** · 2026-07-13T03:16:07.647Z · _claude-code_

PROVENANCE IS AN ACCOUNTABILITY RELATION, NOT A FIELD. A source the user controls and can rewrite is self-attestation, not evidence — 'the user is a failure and a fool at times' is a THREAT MODEL, not an insult. A private graph therefore has NO provenance and needs none: it makes no claim on anybody. Publishing is the moment a graph acquires an OWNER and therefore acquires provenance — official publication, not manual file-sharing, which transfers no accountability. TTL = private, offline, full user power. TriG = published, attributed, governed; RBAC + 3Ps overlay (F84). Separate market, separate marketing angle. NOTE: this is the third time the same principle has surfaced — an unverifiable claim, made by the party it benefits, is not evidence (cf. F66.1 attestation, F82 forced links).

### 🚢 The thesis is on the landing page — generated from the graph, not hand-written

`shipped` · **kb:thesis** · 2026-07-13T03:20:22.932Z · _claude-code_

6 tenets, each marked 'enforced in code' or 'what we believe', and the distinction is RENDERED rather than hidden. A belief dressed as a feature is a lie with good manners — and the landing page has already drifted once (it claimed 16 MCP tools when the graph said 20). CI fails if the copy goes stale.

### 🐛 Shelly could not request a timeline layout at all

`bug-found` · **kb:view-suggestions** · 2026-07-13T03:26:51.988Z · _claude-code_

ViewAdjust.layout omitted 'timeline' and 'hierarchy' while KnowledgeGraph supported them. So the single most obvious thing to offer someone staring at dated facts was not expressible in the view-control API. A view-control API that cannot express the view is not an API. Found while building F85.

### 🐛 The feature the mission rests on had no tests — and was dropping the field that makes it work

`bug-found` · **kb:partial-facts** · 2026-07-13T04:02:52.661Z · _claude-code_

Partial facts: 'blocks' was discarded on import, so the graph knew it had a hole but not what the hole COST — the difference between a to-do and a priority, and the entire 'answer this one question and four things unblock' value. The landing page was already claiming it worked (I shipped that tenet the same evening). 'askedBy' was also dropped, so answers came back unattributable. Both fixed; 16 tests.

### 🐛 History Mode could not show you anything you had deleted

`bug-found` · **kb:history-mode** · 2026-07-13T15:25:44.034Z

The past was rebuilt by FILTERING the current statement set, but deletion is a hard db.statements.delete(id) — a fact deleted since T is not in that set, so it could never be filtered back IN. Scrubbing to a time when a fact plainly existed showed a graph without it, and the 'was it deleted before T?' branch was unreachable dead code. The one thing a history feature exists to do — show you what you lost — was the one thing it could not do. Now replays the changelog and revives deleted facts from their tombstones.

### 🐛 The trust fix did not reach the second copy of the trust maths

`bug-found` · **kb:history-mode** · 2026-07-13T15:25:45.720Z

History Mode carried its own inline scorer — score = SUM(delta * decay), no baseline. That is the IDENTICAL bug fixed in trust.ts on 2026-07-12; it survived because the logic was DUPLICATED rather than imported, so every source in History Mode scored near zero. A fix only propagates as far as the code that shares the function. Now calls computeTrustScore: one implementation of trust, not two.

### 🐛 The published graph has test debris in it — on dev, committed

`bug-found` · **kb:graph-publishing** · 2026-07-14T14:53:57.083Z · _claude-code_

static/knowledge.ttl IS the public graph (served at /knowledge.ttl, PUBLISHED_TTL_PATH in site-export.ts). It currently carries 166 terms in the urn:reckons:story/ test-harness namespace, and the debris is COMMITTED on origin/dev, not working-tree churn. Its header also claims 1032 statements while the body parses to 3096, so the file misdescribes itself. Found by published-graph-guard.ts on its first run in the job registry — the script existed but was registered nowhere, so nothing had ever run it. A derived artifact with no guard is a derived artifact nobody is watching.

### 🐛 The e2e smoke test has been failing on dev — and nothing was watching

`bug-found` · **kb:deep-testing** · 2026-07-14T16:13:25.256Z · _claude-code_

tests/e2e/graph-render.test.ts ('documentation graph renders nodes without a WebGL/renderer crash') fails with 'Failed to fetch dynamically imported module: http://localhost:4174/@vite/client'. Verified PRE-EXISTING: it fails identically on the untouched baseline dependency tree, so it is not fallout from the uuid/cookie security overrides. A smoke test is the one test whose whole job is to be trusted when it is green; this one is red and the signal was going nowhere. CI runs test:e2e — so either CI is red on dev and being ignored, or the smoke job is not gating what we think it gates. Find out which, because both answers are bad.
