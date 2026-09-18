# LinkedIn: "Enterprise technology without the subscription"

Audience: LinkedIn feed. Data and AI practitioners, CTOs, knowledge-management people, and
the semantic-web crowd who will recognise every name in it and check the ones they don't.

Grounded in `static/docs-why-reckons.ttl` (F200). Every figure below is sourced and dated
in that graph. **Do not add a priority claim.** The evidence against it is recorded in
`static/reckons-roadmap.ttl` under F200 `kpred:measured`.

---

## Main post (~2,400 characters)

Palantir will sell you an ontology for somewhere between $500,000 and $2,000,000 a year.

Databricks shipped OntoBricks: OWL ontologies, R2RML mappings, a materialized triple store, SHACL validation, the whole apparatus. It runs beautifully, provided you are already a Databricks customer.

Microsoft announced Fabric IQ at Ignite and put an Ontology item at the centre of it. Billing meters started this year.

Stardog and Ontotext have been doing this properly since before it was fashionable. Ontotext even has a free tier: two concurrent queries, and the licence forbids using it in anything that makes money.

Here is what struck me while I was mapping the field.

Underneath the branding, every one of these products made the same four choices. RDF triples as the unit of knowledge. OWL for the vocabulary. SHACL for the shapes. MCP so a language model can query the graph as a tool.

Those are the same four choices I made building Reckons.AI. Not because I was clever or early, but because when five well-resourced teams independently arrive at the same architecture, the architecture is probably just correct.

So the interesting question isn't who thought of it. It's why it costs six figures.

And the answer is: it doesn't, any more. The standards are open W3C specs. The reasoning runs in a browser tab. The embeddings and the extraction models run on your laptop. The storage is a file.

Reckons.AI is that stack with the invoice removed. MIT licensed. Works offline. No account, no seat count, no usage meter, no server I could bill you from if I wanted to.

In practice it is a notes app. You type something, paste something, or talk at your phone, and it works out the claims inside and asks you to confirm them. The speech recognition runs on the device, so the easiest way to get a thought in is also the most private one. That matters more than any of the machinery above it: an ontology you need training to edit is not available to most people even when it costs nothing.

To be straight about it: there is no SPARQL engine, the reasoner is a small RDFS/OWL subset rather than OWL 2 RL, and it is version 0.2.0 with one maintainer. If you have fifty million rows under a compliance regime, buy the enterprise product, because it is better at that.

But if you just want to know what you know, and where each piece of it came from, you should not need a procurement department.

reckons.ai

---

## Short variant (~700 characters, higher reach)

Palantir sells ontologies for $500k–$2M a year. Databricks built OntoBricks. Microsoft put an Ontology item at the heart of Fabric IQ and started metering it this year.

Strip the branding off all three and they made the same four choices: RDF triples, OWL, SHACL, and MCP so an LLM can query the graph.

Those are the same choices Reckons.AI makes. Not because I was first. I wasn't: OntoBricks beat me to the repo by two months. But when several well-funded teams land on one architecture independently, it's probably right.

The difference is the invoice, and who it shuts out. Open standards, models that run on your laptop, storage that's just a file.

In practice it's a notes app: talk at your phone, and what you said becomes facts you confirmed, with the speech recognition running on the device.

MIT licensed. Works offline. No account.

reckons.ai

---

## Notes for posting

- **Lead with Palantir.** It is the name that stops the scroll, and the number is the argument.
- **Keep the limitations paragraph.** It is the most persuasive thing in the post: an
  audience that recognises these products will discount anything that reads as an advert,
  and naming what the tool cannot do is what buys the rest of it.
- **Never claim we predate them.** Checked 2026-09-16: OntoBricks' repo was created
  2026-04-07, ours 2026-06-09. The short variant turns that into an asset by saying it out loud.
- Figures are third-party reported (Palantir publishes no rate card). If challenged, the
  sources are on the comparison page and in the graph.
- Suggested link target: the /docs → "Why Reckons.AI" section.
