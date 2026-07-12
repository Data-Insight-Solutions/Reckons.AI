# Reckons.AI — Safety & Responsibility

*A clear, concise statement of what Reckons.AI does to protect its users, where responsibility lies, and how we approach content that shouldn't be shared publicly.*

## What Reckons.AI is

Reckons.AI is a **local-first** personal knowledge-graph tool. Your data lives on **your device** as a standard Turtle (`.ttl`) file. Reckons.AI is **not a hosting provider, social network, or content platform** — it is software that helps you build and reason over your own graph.

## Where responsibility lies

**You own and are responsible for the content you create.** Reckons.AI is a neutral tool, like a text editor or a spreadsheet. It does not author your facts, and it does not host or distribute them on your behalf. We nonetheless make a **decent, good-faith effort** to protect users and to keep the worst content off the public web (below).

## What we do to protect users (good-faith effort)

- **Ethics guardrails in every AI call.** An `ETHICS_PREAMBLE` (`src/lib/safety/content-policy.ts`) is injected into **every** LLM prompt and cannot be overridden. It refuses to produce incitement to violence, instructions for mass-casualty weapons, sexualization of minors, or promotion of slavery/trafficking — while explicitly *allowing* academic and historical discussion.
- **Content classifier on ingest.** Incoming facts are classified `none` / `mature` / `blocked`. **Blocked** content (the categories above) is filtered out before it enters your graph; **mature** content is allowed but flagged.
- **Export advisories.** Exported files carry a content-advisory header when mature content is present, so a recipient is warned.
- **Local-first privacy.** Nothing is uploaded anywhere unless *you* connect an integration (a folder, Google Drive, an n8n instance, a Git host). There is no central server that sees your data.

## Export is a right. Distribution is a privilege.

**We gate only what we carry.**

- **Your export is never blocked.** Plain-text `.ttl` export of your own graph to your own disk is always available, whatever the graph contains. Your data is yours, in a portable, non-proprietary format. Withholding it from you would be lock-in, and we won't do it.
- **What you do with an exported file is your business.** Hand it to someone, email it, host it yourself — that is between you and them, the same as any file.
- **When *we* are the one delivering, we gate.** If Reckons.AI is the intermediary handing your content to someone else — publishing to the web, a share link, a guest view — then we are a participant in that delivery, and we take responsibility for what we carry.

## Adult content: we won't carry it, and we won't stand in your way

If you're a novelist writing explicit fiction, **Reckons.AI will not block you.** Write it, keep it, graph it, export it. The app is a tool, and your work is your own.

What we will not do is *publish it for you*. Reckons.AI offers **no distribution channel for adult content** — if you want it on the web, export it and host it yourself, under your own name and your own host's terms.

This is a refusal to **carry**, not a refusal to **let you have.** We're not judging your work; we've simply decided not to be the courier for it. And note what we deliberately do *not* do: we never ask you to justify or explain your content. There's no purpose questionnaire, no "declare your intent" checkbox, no terms you must attest to. A gate that accepts an explanation is a gate anyone can talk their way past — so we ask nothing, and there's nothing to lie about.

## Ethics, not just law

Laws vary across borders, and legality is a floor, not a ceiling. Reckons.AI applies a **baseline ethical standard** regardless of whether something happens to be legal in a given place. There is a category we refuse **everywhere we are in the loop**, and no explanation, purpose, or agreement unlocks it:

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
