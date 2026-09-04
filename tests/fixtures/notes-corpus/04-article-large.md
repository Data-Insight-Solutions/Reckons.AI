# 04 — Large article (fetch on demand, not committed)

A real Wikipedia article is the scale ceiling Matt named. It is NOT committed
here, for two reasons: Wikipedia text is CC BY-SA and would need attribution
carried through every derived artifact, and an 8,000-word file bloats the repo
for a fixture whose only job is to be big.

Fetch one when you need it. Any of these work; the first is recommended because
it is dense with typed entities, dates and relationships, which is what stresses
an extractor:

    curl -s "https://en.wikipedia.org/api/rest_v1/page/html/Digital_asset_management" \
      -o /tmp/dam.html

    curl -s "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&titles=Knowledge_graph" \
      | python3 -c "import sys,json; d=json.load(sys.stdin)['query']['pages']; print(list(d.values())[0]['extract'])" \
      > /tmp/knowledge-graph.txt

Or paste a URL straight into /ingest — the URL path already handles fetching and
is itself worth testing at this size.

WHAT THIS FILE TESTS THAT THE SMALLER ONES CANNOT
-------------------------------------------------
Scale changes which failures dominate. Run it LAST, and only once 01-03 are
understood, or a scale failure is indistinguishable from a correctness one.

1. CHUNKING BOUNDARIES. A long article must be split before a model sees it.
   Watch for claims that straddle a boundary — a subject introduced in one chunk
   and referred to by pronoun in the next produces an orphan or a wrong subject.
   This is the failure the small files structurally cannot show.

2. ENTITY EXPLOSION. Expect hundreds of entities. The question is not whether
   extraction works but whether REVIEW survives: at this volume the queue must
   aggregate, or a person faces a flat list of several hundred rows.
   Measured baseline for comparison (real corpus, 2026-09-02): the cascade floor
   formed 33 questions over 148 bookkeeping facts, and left 53 claims loose with
   ZERO decisions open. Expect that ratio to get worse here, not better.

3. VOCABULARY DRIFT AT VOLUME. A big article names the same thing several ways.
   normalizeEntities (BGE cosine >= 0.90) and vocabulary-repair both fire far
   more often. Watch the FALSE-POSITIVE rate specifically: the digit guard added
   2026-09-02 stopped identifier collisions, but co-hyponym over-merging is only
   guarded in the offline harness, not in the app.

4. TIME. Note how long extraction takes and whether the UI stays honest about
   progress. A stage that appears to hang is a finding even if it completes.

DO NOT judge accuracy here by reading every triple — that is what the scored
corpus in F146 phase 1 is for, and it does not exist yet. Judge SHAPE: chunk
seams, review survivability, drift rate, and whether the app stays responsive.
