# Reckons.AI — Safety & Responsibility

*A clear, concise statement of what Reckons.AI does to protect its users, where responsibility lies, and how we approach content that shouldn't be shared publicly.*

## What Reckons.AI is

Reckons.AI is a **local-first** personal knowledge-graph tool. Your data lives on **your device** as a standard Turtle (`.ttl`) file. Reckons.AI is **not a hosting provider, social network, or content platform** — it is software that helps you build and reason over your own graph.

## Where responsibility lies

**You own and are responsible for the content you create.** Reckons.AI is a neutral tool, like a text editor or a spreadsheet. It does not author your facts, and it does not host or distribute them on your behalf. We nonetheless make a **decent, good-faith effort** to protect users and to keep the worst content off the public web (below).

## What we do to protect users (good-faith effort)

- **Ethics guardrails in every AI call.** An `ETHICS_PREAMBLE` (`src/lib/safety/content-policy.ts`) is injected into **every** LLM prompt. It refuses to produce incitement to violence, instructions for mass-casualty weapons, sexualization of minors, or promotion of slavery/trafficking — while explicitly *allowing* academic and historical discussion. **It cannot be overridden from within the app** (a custom system prompt cannot displace it). **It is not, and cannot be, enforcement:** Reckons.AI is open-source and runs on your machine, so anyone willing to edit the source — or to point the app at their own uncensored local model — can remove it. We would rather say that plainly than imply a control we do not have. It is a good-faith default.
- **Content classifier on ingest.** Incoming facts are classified `none` / `mature` / `blocked`. **Blocked** content is filtered out before it enters your graph; **mature** content is allowed but flagged. Pattern matching is imperfect — see the caveat below before relying on it.
- **Export advisories.** Exported files carry a content-advisory header when mature content is present, so a recipient is warned. This *warns*; it does not block.
- **Local-first privacy.** Nothing is uploaded anywhere unless *you* connect an integration (a folder, Google Drive, an n8n instance, a Git host). There is no central server that sees your data.
- **A public record that we mean it.** Each of these controls is verified against the live code and recorded, dated, every week — including when a control **fails**. See [the attestation log](static/reckons-safety-log.ttl). It currently records **6 of 6 passing** — and when a control fails, it says so, by name.

## ⚠️ Honest status: what is built, and what is not

We would rather tell you the truth than sound reassuring. **As of 2026-07-12:**

| | Status |
|---|---|
| Ethics preamble in every AI prompt | ✅ **Built and verified** ([attestation log](static/reckons-safety-log.ttl)) |
| Content classifier on ingest | ⚠️ **Built** — pattern-based, imperfect; see the caveat below |
| Export advisory header | ✅ **Built** |
| **Publish safety gate** | ✅ **Built** (F66) — publishing through Reckons.AI is now gated |
| **Adult-content distribution policy** | ✅ **Built** (F66.1) — enforced by code, not just stated |

**Classifier caveat, plainly:** pattern matching is imperfect and always will be. It will miss things, and it will sometimes flag something harmless. Two things limit the damage. First, the gate applies **only** to publishing *through us* — a false positive costs you one export and a self-host, never your work. Second, we detect **coercion structure** (a real person + intimate material + a threat + a demand) rather than trying to detect explicitness, because the structure is what actually distinguishes a blackmailer from a novelist.

We will not describe a control we do not have. When something here is not built, this table says so.

## Export is a right. Distribution is a privilege.

**We gate only what we carry.**

- **Your export is never blocked.** ✅ *(true today)* Plain-text `.ttl` export of your own graph to your own disk is always available, whatever the graph contains. Your data is yours, in a portable, non-proprietary format. Withholding it from you would be lock-in, and we won't do it.
- **What you do with an exported file is your business.** ✅ *(true today)* Hand it to someone, email it, host it yourself — that is between you and them, the same as any file.
- **When *we* are the one delivering, we gate.** ✅ *(true today — F66)* If Reckons.AI is the intermediary handing your content to someone else — publishing to the web, a share link, a guest view — then we are a participant in that delivery, and we take responsibility for what we carry. Publishing to GitHub runs the gate and **refuses with an explanation**; it never silently drops part of your graph. Your offline `.zip` export is *not* gated, because that is an export, not a delivery.

## Adult content: we won't carry it, and we won't stand in your way

If you're a novelist writing explicit fiction, **Reckons.AI will not block you.** Write it, keep it, graph it, export it. The app is a tool, and your work is your own.

What we will not do is *publish it for you*. Reckons.AI offers **no distribution channel for adult content** — if you want it on the web, export it and host it yourself, under your own name and your own host's terms.

This is a refusal to **carry**, not a refusal to **let you have.** We're not judging your work; we've simply decided not to be the courier for it. And note what we deliberately do *not* do: we never ask you to justify or explain your content. There's no purpose questionnaire, no "declare your intent" checkbox, no terms you must attest to. A gate that accepts an explanation is a gate anyone can talk their way past — so we ask nothing, and there's nothing to lie about.

## Ethics, not just law

Laws vary across borders, and legality is a floor, not a ceiling. Reckons.AI applies a **baseline ethical standard** regardless of whether something happens to be legal in a given place. There is a category we refuse **everywhere we are in the loop** — enforced at generation time by the ethics preamble ✅, and at distribution by the publish gate ✅ — and no explanation, purpose, or agreement unlocks it:

- Any sexualization of minors
- Non-consensual intimate content of real people
- Sextortion or blackmail material
- Incitement to violence; instructions for mass-casualty weapons

The line here is not explicitness — it is **whether the content targets a real, identifiable person who did not consent.** Fiction between consenting adults has no victim. Content aimed at a real person does. That is the distinction, and it is why a romance author and a blackmailer are not remotely the same case.

## The natural barrier to abuse

Reckons.AI **does not host anything for you.** To publish to the public web you must use **your own domain, hosting, or file-sharing service** (Cloudflare Pages, GitHub Pages, a Git host, etc.). Not everyone can or will set that up, which meaningfully limits casual and anonymous abuse — and it means **the publisher is accountable through their own hosting provider**, under that provider's terms and the law of their jurisdiction. Reckons.AI is one step removed by design.

## Verified badge (planned)

We plan a **verified badge** to signal a reviewed, accountable publisher or graph — a positive trust signal for good-faith authors, distinct from the anonymous, un-hosted default. See the roadmap (`kb:verified-badge`).

## Reporting

If you encounter a Reckons.AI-built graph published publicly that violates the above, contact **matthew.roe@data-insight.solutions**. We will make a good-faith effort to help, though public files are ultimately hosted and controlled by whoever published them.

## Disclaimer

Reckons.AI is provided as-is, under the MIT license. The measures above are a **reasonable, good-faith effort**, not a guarantee. Reckons.AI and its authors are **not responsible for content that users create, share privately, or publish through their own hosting.** Responsibility for user-generated content rests with the user who created and shared it.
