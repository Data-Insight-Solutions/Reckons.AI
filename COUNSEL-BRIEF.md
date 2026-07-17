# Reckons.AI — Engineering Brief for Counsel

**Prepared for:** Data Insight Solutions LLC
**Subject:** What the software actually does, sees, and controls — for drafting Terms & Conditions and assessing content-liability exposure.
**Date:** 2026-07-12
**Status:** Engineering description. **Not legal advice.** Written to make counsel's work fast and accurate.

---

## 1. Read this first: the three claims that drive everything

1. **We host nothing.** Reckons.AI is a static web app. User data lives in the user's browser (IndexedDB) and on the user's own disk. Data Insight Solutions LLC operates no server that stores, receives, or transmits user content.
2. **Most of our "controls" are bypassable by design.** The app is open-source and local-first. A user can remove any client-side safety control in minutes. Controls are *good-faith defaults*, not enforcement.
3. **We currently have no way to identify a user or retain a record of anything they do.** There are no accounts, no server, no logs. See §6 — this directly contradicts an assumption we were making about traceability, and it is the most important open question in this brief.

---

## 2. What the product is

A local-first personal knowledge-graph tool. The user ingests text (notes, URLs, documents, code repos), an LLM extracts subject–predicate–object facts ("triples"), and the user reviews, edits, and explores them as a graph. Data is stored as standard RDF/Turtle (`.ttl`) — a plain-text, non-proprietary format.

**Distribution:** static site (SvelteKit compiled to HTML/JS/CSS), served from a CDN. No application backend.

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

**There is no path in the current product where user content reaches infrastructure operated by Data Insight Solutions LLC.** We are, functionally, a text editor that happens to call an LLM with the user's own key.

The one exception is the contact form, which posts to a webhook the *user* configures (their own self-hosted n8n instance).

---

## 4. Safety controls — enforceable vs. best-effort

**This distinction matters more than any other in this document.** Overclaiming a control we cannot exercise is itself a liability.

| Control | What it does | Enforceable? |
|---|---|---|
| `ETHICS_PREAMBLE` | ~121-token instruction prepended to **every** LLM prompt. Refuses incitement to violence, mass-casualty weapons instructions, sexualization of minors, promotion of slavery/trafficking. Explicitly permits academic/historical discussion. | **No — best-effort.** Open-source client code. A user can delete it, or point the app at an uncensored local model. It constrains the *default* experience, honestly and by design. |
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

**The decisive property of this design: there is no attestation to game.** We considered requiring a purpose declaration + T&C acceptance to unlock Tier 2 distribution. We rejected it. A stated purpose is an *attestation, not evidence* — a bad actor simply writes a plausible paragraph about their novel, and any gate that accepts context as input is a gate that anyone can talk their way past. **Under Option C we ask no question, so there is nothing to lie about.** This also eliminates accounts, PII, retention duties, and age-verification exposure.

**Over-blocking is cheap here, and that matters.** Our classifier is imperfect (§4). Under Option C a false positive costs the user one export and a self-host — not the loss of their work, and not a ban. That is what makes the policy workable *despite* an imperfect classifier, rather than dependent on a perfect one.

**Export is exempt from all of this.** Plain-text export of the user's own graph to their own disk is never blocked, whatever it contains. Withholding a user's own data from them would be data lock-in, and it would be futile regardless (the data is readable directly out of the browser's storage). Gates apply to **distribution** — where Reckons.AI is the intermediary handing content to someone else — not to **export**.

---

## 6. ⚠️ The contradiction counsel must resolve

We had assumed that a user who lies in a purpose declaration "could be traced to them." **As currently architected, this is false.**

- There are **no user accounts** (the product explicitly advertises "no accounts required").
- There is **no server**, therefore **no logs**, **no IP records**, **no attestation records**.
- Publishing happens through the **user's own** hosting credentials, so even the published artifact carries no link to us.
- **Cloudflare Pages logs do not close this gap.** They are *request* logs (IP, path, timestamp) for loading the static app, with short retention. They contain no user content, and — decisively — **publishing never touches our CDN at all**, because it goes to the user's own host. They would show that someone loaded the app. Nothing more.

**Current posture:** the product has effectively no users yet, so present exposure is negligible. The reason to act now is not today's risk — it is that a good-faith effort is only credible if it is *contemporaneous*. A safety record assembled after an incident is worth little; one that has been accruing, dated and verified, since before there were any users is worth a great deal. See §9.

**An attestation we cannot retain is not evidence, and a term we cannot enforce may be worse than no term at all.**

Three options were considered:

- **Option A — Accept the limit.** Attestation is a click-through deterrent only; T&Cs disclaim heavily. Pure local-first, no accounts, no logs. Enforcement: none. *A click-through we cannot retain is not evidence.*
- **Option B — Identity for adult distribution.** Distributing adult content through a Reckons.AI-mediated path requires an account + a retained attestation record. The **only** option under which "we can trace the lie" is a true statement — but it introduces a server, PII, retention duties, and breaks local-first for that path.
- **Option C — Don't mediate adult distribution at all.** ✅ **DECIDED 2026-07-12.**

### The decision: Option C

**Reckons.AI provides no mediated distribution channel for adult content.** Users may author, store, and export it without impediment; if they wish to publish it, they self-host, on their own infrastructure, under their own name and their own host's terms.

This does not *solve* the traceability problem — **it dissolves it.** There is no attestation to retain because we ask for none; there is no lie to trace because we require no claim. We do not adjudicate the user's purpose, because we have removed the only reason we would ever need to know it.

Consequences, which we believe are all favourable to DIS LLC:

- No accounts, no server, no PII, no retention duty
- No age-verification surface (we distribute nothing)
- No gameable purpose declaration
- Our imperfect classifier (§4) becomes tolerable: a false positive costs the user one export and a self-host, not their work and not a ban
- Fully consistent with the product's existing architecture and its stated principles

---

## 7. Questions for counsel

Option C removes most of what we were worried about. What remains:

1. **Are we a "provider" for reporting purposes?** We host nothing and never receive user content. Do the obligations under 18 U.S.C. § 2258A (NCMEC reporting) attach to us at all? **This is the most important question in this brief** — it is the one thing Option C does not obviously dispose of.
2. **Open-source bypassability.** We ship safety controls a user can remove, and we say so plainly (§4). Does that candour strengthen or weaken our good-faith position?
3. **The user's own LLM keys.** When a user's content goes to Anthropic/OpenAI under the *user's* API key and *their* account, whose terms govern? Must we surface that in ours?
4. **Refusal to carry.** Is declining to distribute lawful adult content, while explicitly permitting the user to export and self-host it, a clean position? Any consumer-protection or common-carrier angle we are not seeing?
5. **The contemporaneous record** (§9) — is a dated, cryptographically chained log of verified safety controls, accruing from before we had users, of evidentiary value? Should we be doing anything differently to preserve it?
6. **Age verification.** Likely moot under Option C, since we distribute nothing — please confirm.

---

## 9. The contemporaneous record (what we do have, and it is the strong card)

Because we cannot retain evidence about *users*, we instead retain verified evidence about the *software*. `scripts/offline/safety-attestation.ts` checks each control against the live codebase and appends a dated entry to `static/reckons-safety-log.ttl`. It runs **weekly in CI** (`.github/workflows/safety-attestation.yml`) and on every push to `main`.

Each entry records, per control, PASS/FAIL with the evidence, plus the exact git commit. Because the log is committed, **git supplies the properties a record like this needs and that we could not otherwise buy: it is timestamped, ordered, and cryptographically chained. It cannot be backdated.**

Controls currently verified (2026-07-12, commit `601cfec`): **5 of 6 passing.**

- ✅ Ethics preamble exists, with all four required prohibitions
- ✅ Preamble injected into 5/5 generative prompt modules (verified by static analysis, not asserted)
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
