RAW TEXT CORPUS FOR MANUAL EXTRACTION TESTING
=============================================

Extraction takes TEXT. Every fixture in tests/fixtures/*.ttl is already-extracted
triples, so none of them exercise the extractor at all — that gap is why the
extraction half of the chain had never been driven by hand.

These files are the input side. They are SYNTHETIC because this repository is
public and the real corpus (Matt's dictated Pebble Index 01 notes) lives in the
gitignored workspace. They reproduce the damage patterns catalogued from the real
notes on 2026-09-02 rather than inventing new ones:

  phonetic damage on a product name      "Recon's AI"        -> Reckons.AI
  homophone on a domain acronym          "enterprise damn"   -> enterprise DAM
  proper nouns split by the decoder      "A primo and binder"-> Aprimo, Bynder
  a person's name misheard               "Matthew Rowe"      -> Roe
  a whole sentence as one entity slug    orange-logic-is-an-enterprise-dam
  co-hyponyms sharing a name head        node attribute {name,value,type,...}
  a REQUEST mixed in with claims         "generate a doc and email it to me"

Each file has a companion EXPECTED block naming what a correct run produces, so a
manual run is judgeable rather than merely observable. Where current behaviour is
known to be wrong, the expected block says so and says why — do not "fix" the
expectation to match the output.

  01-note-single.txt    one dictated note        (~30 words)   the smallest unit
  02-notes-batch.txt    eight dictated notes     (~250 words)  Pebble-scale
  03-doc-medium.md      a briefing document      (~600 words)  structured prose
  04-article-large.md   fetch instructions only  (~8k words)   scale ceiling

RUN THEM in this order. Small first is not politeness, it is the only way to tell
a scale failure from a correctness failure: if 01 is already wrong, 04 tells you
nothing you did not already know.
