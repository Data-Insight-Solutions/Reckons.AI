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

## Private sharing vs. public publishing

- **Private sharing is yours to manage.** If you export a `.ttl` and hand it to someone directly, that is between you and them — the same as emailing any file. Reckons.AI does not police private files.
- **Public publishing is gated.** When you publish a graph to the open web, Reckons.AI makes a **good-faith effort to block publicly sharing content that incites violence or is otherwise illegal or hateful** (see the Publish Safety Gate on the roadmap, built on the same classifier). We would rather refuse to help publish such content than look the other way.

## Ethics, not just law

Laws vary across borders, and legality is a floor, not a ceiling. Reckons.AI applies a **baseline ethical standard** — no incitement, no hate, no content that sexualizes minors — **regardless of whether it happens to be legal in a given place.** Some things simply should not be broadcast publicly.

## The natural barrier to abuse

Reckons.AI **does not host anything for you.** To publish to the public web you must use **your own domain, hosting, or file-sharing service** (Cloudflare Pages, GitHub Pages, a Git host, etc.). Not everyone can or will set that up, which meaningfully limits casual and anonymous abuse — and it means **the publisher is accountable through their own hosting provider**, under that provider's terms and the law of their jurisdiction. Reckons.AI is one step removed by design.

## Verified badge (planned)

We plan a **verified badge** to signal a reviewed, accountable publisher or graph — a positive trust signal for good-faith authors, distinct from the anonymous, un-hosted default. See the roadmap (`kb:verified-badge`).

## Reporting

If you encounter a Reckons.AI-built graph published publicly that violates the above, contact **matthew.roe@data-insight.solutions**. We will make a good-faith effort to help, though public files are ultimately hosted and controlled by whoever published them.

## Disclaimer

Reckons.AI is provided as-is, under the MIT license. The measures above are a **reasonable, good-faith effort**, not a guarantee. Reckons.AI and its authors are **not responsible for content that users create, share privately, or publish through their own hosting.** Responsibility for user-generated content rests with the user who created and shared it.
