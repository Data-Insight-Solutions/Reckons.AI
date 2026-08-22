# Reckons.AI — Engineering Brief for Counsel

**Prepared for:** Data Insight Solutions LLC
**Subject:** What the software actually does, sees, and controls — for drafting Terms & Conditions and assessing content-liability exposure.
**Date:** 2026-07-12; engineering accuracy update 2026-08-16
**Status:** Engineering description. **Not legal advice.** Written to make counsel's work fast and accurate.

---

## 1. Read this first: the three claims that drive everything

1. **Core graph use is local-first, but "we host nothing" is too broad.** Reckons.AI is a static web app. Graph data normally lives in the user's browser (IndexedDB) and on the user's own disk. However, the product has a build-time-configurable feedback endpoint: if enabled, a user who submits the feedback form sends their name, email, message, source, and submission time to the maintainer's endpoint. If it is not enabled, the form falls back to email. This voluntary communication path is separate from graph storage, but it is still a path by which content and PII can reach Data Insight Solutions LLC.
2. **Most of our "controls" are bypassable by design.** The app is open-source and local-first. A user can remove any client-side safety control in minutes. Controls are *good-faith defaults*, not enforcement.
3. **We have no product account or graph-activity identity system.** We do not retain a record of graph edits, prompts, or publishing activity. CDN request logs and voluntarily submitted feedback may nevertheless contain identifiers such as IP address, name, or email. They do not establish who authored or published a graph. See §6.

---

## 2. What the product is

A local-first personal knowledge-graph tool. The user ingests text (notes, URLs, documents, code repos), an LLM extracts subject–predicate–object facts ("triples"), and the user reviews, edits, and explores them as a graph. Data is stored as standard RDF/Turtle (`.ttl`) — a plain-text, non-proprietary format.

**Distribution:** static site (SvelteKit compiled to HTML/JS/CSS), served from a CDN. There is no graph/content application backend. A separately configured maintainer feedback webhook may receive voluntary contact submissions.

---

## 3. Data flows — what we see and don't see

| Path | Where data goes | Does DIS LLC see it? |
|---|---|---|
| Normal use (ingest, review, graph, chat) | Browser IndexedDB, on-device | **No** |
| Local LLM (Ollama / in-browser WASM) | Stays on the user's machine | **No** |
| Cloud LLM (Claude, OpenAI, Gemini, OpenRouter) | Third-party LLM provider, **under the user's own API key and the user's own account with that provider** | **No** |
| Export to file | User's own disk, plain-text `.ttl` | **No** |
| Optional integrations (Google Drive, n8n, GitHub, etc.) | The user's own accounts/instances, which the user connects | **No** |
| Publishing a graph to the web | The **user's own** hosting (their GitHub Pages, their Cloudflare, their domain) | **No** |
| Direct feedback form, if the maintainer endpoint is configured | Maintainer-configured webhook; payload contains name, email, message, source, and submission time | **Yes** |
| Feedback email fallback | User's email provider and the DIS recipient mailbox | **Yes** |

**Normal graph use does not send graph content to infrastructure operated by Data Insight Solutions LLC.** The exception is deliberate contact: `VITE_FEEDBACK_WEBHOOK_URL`, when set at build time, points to the product maintainer's endpoint, not to the user's own n8n setting. An unset endpoint produces a mailto fallback. A fork or self-hoster can configure its own recipient.

---

## 4. Safety controls — enforceable vs. best-effort

**This distinction matters more than any other in this document.** Overclaiming a control we cannot exercise is itself a liability.

| Control | What it does | Enforceable? |
|---|---|---|
| `ETHICS_PREAMBLE` | ~121-token instruction used according to prompt purpose and locality. Shared output always carries it; remote conversational prose carries it; local-only use omits it; structured extraction omits it because extracted statements pass through deterministic filtering. It refuses incitement to violence, mass-casualty weapons instructions, sexualization of minors, and promotion of slavery/trafficking, while permitting academic/historical discussion. | **No — best-effort.** Open-source client code. A user can delete it, or point the app at an uncensored local model. It constrains the default experience according to the documented policy; it is not present in every prompt. |
| Content classifier (`classifyText`) | Regex classification of ingested facts into `none` / `mature` / `blocked`. Blocked content is filtered before entering the graph. | **No — best-effort, and currently weak.** It matches *descriptions* of content (the literal phrases "sexually explicit", "pornographic"), not the content itself. Actual explicit prose is not detected. We should not represent this as a content filter. |
| Export advisory | Attaches a content-advisory header to exported files containing flagged material. | Best-effort. Warns; does not block. |
| Publish safety gate (**planned, not built** — roadmap F66) | Would classify a graph before publishing to the open web and refuse to publish blocked content. | **Only where we are in the delivery path.** If the user publishes with their own token to their own host, we are not in the loop and cannot gate anything. |

**Bottom line for the T&Cs:** we make a good-faith effort in the default configuration. We do not, and technically cannot, guarantee that the software prevents any particular use.

---

## 5. Proposed content policy (for T&C alignment)

The design goal is to **permit legitimate adult creative work (e.g. romance authors writing explicit fiction) while refusing to participate in distributing abuse material.** The line we draw is *not* explicitness. It is **whether the content targets a real, identifiable, non-consenting person.**

**Tier 1 — Never distributed. No stated purpose, attestation, or agreement unlocks these.**
- Any sexualization of minors
- Non-consensual intimate imagery/content of real people
- Sextortion / blackmail material (the structural signature: a real identifiable person + intimate material + a threat + a demand)
- Incitement to violence; mass-casualty weapons instructions

*Rationale, and we think this is defensible publicly and legally:* this is precisely the set where **the harm lands on a third party who did not consent.** Fiction between consenting adults has no victim. Content aimed at a real person does.

**Tier 2 — Adult. Not carried by us (decision: Option C, below).**
- Explicit fiction between adults; graphic violence in fiction
- **Reckons.AI provides no mediated distribution channel for this content.** The user may write it, keep it, and export it freely. If they wish to publish it, they self-host. The gate declines to carry it and says so plainly — no moral judgment, no accusation, no appeal, **and no questionnaire.**

**Tier 3 — Open.** Everything else; mediated distribution available.

**We gate only what we carry.** This is a refusal to *carry*, not a refusal to *let the user have*. The distinction is the entire policy.

**The decisive property of this design: there is no attestation to game.** We considered requiring a purpose declaration + T&C acceptance to unlock Tier 2 distribution. We rejected it. A stated purpose is an *attestation, not evidence* — a bad actor simply writes a plausible paragraph about their novel, and any gate that accepts context as input is a gate that anyone can talk their way past. **Under Option C we ask no question, so there is nothing to lie about.** This avoids accounts, identity records, and age-verification exposure for the graph/distribution path. Voluntary feedback remains a separate PII and retention surface.

**Over-blocking is cheap here, and that matters.** Our classifier is imperfect (§4). Under Option C a false positive costs the user one export and a self-host — not the loss of their work, and not a ban. That is what makes the policy workable *despite* an imperfect classifier, rather than dependent on a perfect one.

**Export is exempt from all of this.** Plain-text export of the user's own graph to their own disk is never blocked, whatever it contains. Withholding a user's own data from them would be data lock-in, and it would be futile regardless (the data is readable directly out of the browser's storage). Gates apply to **distribution** — where Reckons.AI is the intermediary handing content to someone else — not to **export**.

---

## 6. ⚠️ The contradiction counsel must resolve

We had assumed that a user who lies in a purpose declaration "could be traced to them." **As currently architected, this is false.**

- There are **no user accounts** (the product explicitly advertises "no accounts required").
- There is **no graph/content backend**, therefore no DIS record of graph edits, prompts, or publication attestations.
- A configured feedback endpoint can retain voluntary contact submissions, and the CDN can retain ordinary request metadata such as IP, path, and timestamp. Neither record proves who authored or published a graph.
- Publishing happens through the **user's own** hosting credentials, so even the published artifact carries no link to us.
- **Cloudflare Pages logs do not close this gap.** They are *request* logs (IP, path, timestamp) for loading the static app, with short retention. They contain no user content, and — decisively — **publishing never touches our CDN at all**, because it goes to the user's own host. They would show that someone loaded the app. Nothing more.

**The July 2026 draft said the product effectively had no users. That is not an engineering fact this repository can verify and should not be used as a current risk estimate.** The durable point is that a good-faith effort is more credible when its evidence is contemporaneous. See §9.

**An attestation we cannot retain is not evidence, and a term we cannot enforce may be worse than no term at all.**

Three options were considered:

- **Option A — Accept the limit.** Attestation is a click-through deterrent only; T&Cs disclaim heavily. Pure local-first, no accounts, and no graph-activity logs. Enforcement: none. *A click-through we cannot retain is not evidence.*
- **Option B — Identity for adult distribution.** Distributing adult content through a Reckons.AI-mediated path requires an account + a retained attestation record. The **only** option under which "we can trace the lie" is a true statement — but it introduces a server, PII, retention duties, and breaks local-first for that path.
- **Option C — Don't mediate adult distribution at all.** ✅ **DECIDED 2026-07-12.**

### The decision: Option C

**Reckons.AI provides no mediated distribution channel for adult content.** Users may author, store, and export it without impediment; if they wish to publish it, they self-host, on their own infrastructure, under their own name and their own host's terms.

This does not *solve* the traceability problem — **it dissolves it.** There is no attestation to retain because we ask for none; there is no lie to trace because we require no claim. We do not adjudicate the user's purpose, because we have removed the only reason we would ever need to know it.

Consequences, which we believe are all favourable to DIS LLC:

- No product accounts, graph-content backend, or identity record for the distribution decision
- Voluntary feedback is a separate PII path and needs an explicit recipient, access, retention, deletion, and privacy-notice policy
- No age-verification surface for adult-content distribution, because Reckons does not mediate that distribution
- No gameable purpose declaration
- Our imperfect classifier (§4) becomes tolerable: a false positive costs the user one export and a self-host, not their work and not a ban
- Fully consistent with the product's existing architecture and its stated principles

---

## 7. Questions for counsel

Option C removes most of what we were worried about. What remains:

1. **Are we a "provider" for reporting purposes?** We do not host user graphs or mediate graph publication, but DIS can receive deliberately submitted feedback. Does that limited contact path affect the analysis of obligations under 18 U.S.C. § 2258A (NCMEC reporting)? **This is the most important question in this brief** — it is the one thing Option C does not obviously dispose of.
2. **Open-source bypassability.** We ship safety controls a user can remove, and we say so plainly (§4). Does that candour strengthen or weaken our good-faith position?
3. **The user's own LLM keys.** When a user's content goes to Anthropic/OpenAI under the *user's* API key and *their* account, whose terms govern? Must we surface that in ours?
4. **Refusal to carry.** Is declining to distribute lawful adult content, while explicitly permitting the user to export and self-host it, a clean position? Any consumer-protection or common-carrier angle we are not seeing?
5. **The contemporaneous record** (§9) — is a dated, cryptographically chained log of verified safety controls, accruing from before we had users, of evidentiary value? Should we be doing anything differently to preserve it?
6. **Age verification.** Likely moot for the adult-content distribution path under Option C, since Reckons does not mediate that distribution — please confirm.
7. **Feedback privacy.** What notice, consent language, retention period, deletion process, access control, and processor terms are needed when the maintainer feedback endpoint is enabled and receives name, email, message, source, timestamp, and ordinary request metadata?

---

## 9. The contemporaneous record (what we do have, and it is the strong card)

Because we do not retain evidence about graph activity or publishing identity, we instead retain verified evidence about the *software*. The separate feedback path does not establish who authored a graph. `scripts/offline/safety-attestation.ts` checks each control against the live codebase and appends a dated entry to `static/reckons-safety-log.ttl`. It runs **weekly in CI** (`.github/workflows/safety-attestation.yml`) and on every push to `main`.

Each entry records, per control, PASS/FAIL with the evidence, plus the exact git commit. Git supplies an ordered, hash-linked history, while the hosted remote and CI run history provide independent timing evidence. **Git history alone can be rewritten, so this should not be represented as impossible to backdate.** Preserve protected remote history, CI logs/artifacts, and any retention settings counsel considers necessary.

Historical snapshot from 2026-07-12, commit `601cfec`: **5 of 6 passing. This is not a current attestation.** The prompt policy and publishing implementation have changed since then; use the latest safety-log entry and a fresh CI run for current evidence.

- ✅ Ethics preamble exists, with all four required prohibitions
- ✅ At that commit, the preamble was injected into 5/5 generative prompt modules (verified by the then-current static analysis). Current policy is purpose/locality-sensitive, so this historical check does not prove today's prompt coverage.
- ✅ App and MCP-server copies byte-identical (no silent drift)
- ✅ Content classifier present and filtering on ingest
- ✅ Safety test suite green (28 tests)
- ❌ **Egress gating: FAILING** — graph publishing is shipping ahead of its own safety gate (F66 is planned, publishing is already functional)

**That failure is recorded, deliberately.** An attestation log that only ever records success is worthless as evidence; one that demonstrably detects and reports its own gaps is credible. The record will show the date this was found and the date it was fixed.

---

## 8. Where the authoritative versions live

- Human-readable safety statement: `SAFETY.md`
- Content policy implementation: `src/lib/safety/content-policy.ts`
- Egress/gating model: `kb:data-egress-model` in `static/reckons-roadmap.ttl`
- Publish gate (planned): roadmap `F66`, `kb:publish-safety-gate`
