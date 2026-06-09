# PROV-O Alignment Analysis — Reckons.AI

PROV-O (W3C PROV Ontology, `http://www.w3.org/ns/prov#`) is a W3C Recommendation for
representing provenance on the Web. This document analyses Reckons.AI's current alignment
with the standard and documents what a full-conformance path looks like.

---

## PROV-O core model

PROV-O defines three core classes and the relationships between them:

| Class | Meaning |
|---|---|
| `prov:Entity` | A thing that exists or existed — a document, a dataset, a statement |
| `prov:Activity` | Something that occurred — an extraction run, a merge, a confirmation |
| `prov:Agent` | Something responsible for actions — a person, a software agent |

Key properties linking them:

```
Entity  ←── prov:wasGeneratedBy ──── Activity
Entity  ←── prov:wasDerivedFrom ──── Entity
Entity  ←── prov:wasAttributedTo ─── Agent
Activity ←── prov:wasAssociatedWith ─ Agent
Activity  ── prov:used ────────────── Entity
Activity  ── prov:startedAtTime/endedAtTime (xsd:dateTime literals)
```

---

## Current Reckons.AI usage

### What is already PROV-O aligned

#### 1. `prov:wasDerivedFrom` — statement provenance (serialize.ts)

Every exported statement carries a provenance triple:

```turtle
<urn:kbase:stmt/{id}>
  prov:wasDerivedFrom <urn:kbase:source/{sourceId}> ;
  dc:created "2024-06-01T12:00:00Z"^^xsd:dateTime .
```

This correctly uses `prov:wasDerivedFrom` to link a derived entity (the extracted
statement) to its source entity (the original document/URL/note). This is the
most important PROV-O property and it is in use.

#### 2. Named graph as provenance carrier (N-Quads)

Each statement is stored as an N-Quad where the fourth term (graph IRI) identifies
the source:

```
<urn:kbase:concept/alice> <urn:kbase:predicate/knows> <urn:kbase:concept/bob>
  <urn:kbase:source/src123> .
```

The named graph pattern is the canonical RDF provenance mechanism (used by Wikidata,
DBpedia, and PROV-O bundles). Reckons.AI's use of the graph IRI as a source identifier
is correct and interoperable.

#### 3. Temporal predicates recognised (temporal.ts)

The temporal conflict detector recognises `prov:startedAtTime` and `prov:endedAtTime`
as first-class temporal bounds — fully aligned with PROV-O Activity timing.

#### 4. `prov` prefix registered (serialize.ts)

```typescript
prov: 'http://www.w3.org/ns/prov#'
```

All Turtle exports carry the prefix declaration, so any downstream tool reading the
file will correctly resolve PROV-O terms.

---

### What is partially aligned

#### 5. `dc:created` instead of `prov:generatedAtTime`

The statement creation timestamp uses Dublin Core:

```turtle
dc:created "2024-06-01T12:00:00Z"^^xsd:dateTime
```

PROV-O has a dedicated property for this:

```turtle
prov:generatedAtTime "2024-06-01T12:00:00Z"^^xsd:dateTime
```

Both convey the same information; `prov:generatedAtTime` is more precise in PROV-O
semantics (it applies to `prov:Entity`, and marks the moment the entity came into
existence). Replacing `dc:created` here would tighten conformance without breaking
any RDF consumer.

#### 6. Sources implicitly act as `prov:Entity` but are not typed

The `Source` record maps naturally to `prov:Entity`:

| Source field | PROV-O property |
|---|---|
| `id` | IRI identity (`urn:kbase:source/{id}`) |
| `title` | `rdfs:label` |
| `ingestedAt` | `prov:generatedAtTime` |
| `uri` | `prov:atLocation` or `foaf:page` |
| `hash` | `prov:value` (content hash) |

The source IRI is already used in `prov:wasDerivedFrom`. Declaring it as
`a prov:Entity` in the Turtle export would make this explicit and enable
PROV-O reasoners to traverse the provenance chain.

---

### What is missing for full conformance

#### 7. No `prov:Activity` for the extraction run

Each ingest is a discrete extraction activity — the AI reads a source and
generates statements. PROV-O models this as an Activity:

```turtle
<urn:kbase:activity/ingest-{sourceId}>
  a prov:Activity ;
  rdfs:label "Ingest: Climate Report 2024" ;
  prov:used <urn:kbase:source/{sourceId}> ;
  prov:startedAtTime "2024-06-01T12:00:00Z"^^xsd:dateTime ;
  prov:endedAtTime   "2024-06-01T12:00:45Z"^^xsd:dateTime .

<urn:kbase:stmt/{id}>
  prov:wasGeneratedBy <urn:kbase:activity/ingest-{sourceId}> .
```

The `Source` record already carries `ingestedAt`, `extractionBackend`, and
`extractionModel` — all the data needed to emit an Activity block.

#### 8. No `prov:Agent` for the AI backend

The extracting model (Claude, GPT, Ollama, WASM) is a software agent in PROV-O
terms. Recording it enables attribution chains:

```turtle
<urn:kbase:agent/claude-haiku-4-5>
  a prov:SoftwareAgent ;
  rdfs:label "Claude Haiku (claude-haiku-4-5-20251001)" .

<urn:kbase:activity/ingest-{sourceId}>
  prov:wasAssociatedWith <urn:kbase:agent/claude-haiku-4-5> .

<urn:kbase:stmt/{id}>
  prov:wasAttributedTo <urn:kbase:agent/claude-haiku-4-5> .
```

`extractionBackend` and `extractionModel` on the `Source` type already carry
this information; it just needs to be serialised into the export.

#### 9. No `prov:Bundle` for the named graph

PROV-O defines `prov:Bundle` as a named graph that itself carries provenance.
The source named graph `<urn:kbase:source/{id}>` could be declared as:

```turtle
<urn:kbase:source/{id}>
  a prov:Bundle, prov:Entity ;
  rdfs:label "..." ;
  prov:generatedAtTime "..."^^xsd:dateTime .
```

This makes the graph itself first-class in the PROV-O model and allows SPARQL
queries to directly inspect provenance at the bundle level.

#### 10. No `prov:qualifiedAttribution` for trust scores

The app maintains a trust score per source (time-decayed, based on
confirm/reject history). PROV-O has `prov:qualifiedAttribution` for attaching
metadata to attribution links:

```turtle
<urn:kbase:stmt/{id}>
  prov:qualifiedAttribution [
    a prov:Attribution ;
    prov:agent <urn:kbase:source/{sourceId}> ;
    prov:hadRole <urn:kbase:role/source> ;
    kbase:trustScore "0.87"^^xsd:decimal ;
  ] .
```

---

## Conformance roadmap

| Priority | Change | Files |
|---|---|---|
| High | Replace `dc:created` with `prov:generatedAtTime` | `serialize.ts`, `import-ttl.ts` |
| High | Declare sources as `a prov:Entity, prov:Bundle` in export | `serialize.ts` |
| Medium | Emit `prov:Activity` block per ingest using Source metadata | `serialize.ts` |
| Medium | Emit `prov:SoftwareAgent` for `extractionBackend`/`extractionModel` | `serialize.ts` |
| Medium | Add `prov:wasGeneratedBy` on statement entities | `serialize.ts` |
| Low | Add `prov:wasAttributedTo` on statement entities | `serialize.ts` |
| Low | `prov:qualifiedAttribution` blocks with trust score | `serialize.ts` |

---

## What full PROV-O export looks like

```turtle
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix kb:   <urn:kbase:concept/> .
@prefix src:  <urn:kbase:source/> .
@prefix act:  <urn:kbase:activity/> .
@prefix agt:  <urn:kbase:agent/> .
@prefix stmt: <urn:kbase:stmt/> .

# ---- Source entity (document) ----
src:climate-report-2024
  a prov:Entity, prov:Bundle ;
  rdfs:label "IPCC Synthesis Report 2024" ;
  prov:generatedAtTime "2024-01-15T00:00:00Z"^^xsd:dateTime .

# ---- Extraction activity ----
act:ingest-climate-report-2024
  a prov:Activity ;
  rdfs:label "Triple extraction: IPCC Synthesis Report 2024" ;
  prov:used src:climate-report-2024 ;
  prov:wasAssociatedWith agt:claude-haiku-4-5 ;
  prov:startedAtTime "2024-06-01T12:00:00Z"^^xsd:dateTime ;
  prov:endedAtTime   "2024-06-01T12:00:43Z"^^xsd:dateTime .

# ---- AI agent ----
agt:claude-haiku-4-5
  a prov:SoftwareAgent ;
  rdfs:label "Claude Haiku (claude-haiku-4-5-20251001)" .

# ---- Knowledge facts ----
kb:global-mean-temperature
  rdfs:label "Global Mean Temperature" ;
  <urn:kbase:predicate/trend> "increasing" .

# ---- Statement provenance ----
stmt:abc123
  a prov:Entity ;
  prov:wasDerivedFrom src:climate-report-2024 ;
  prov:wasGeneratedBy act:ingest-climate-report-2024 ;
  prov:wasAttributedTo agt:claude-haiku-4-5 ;
  prov:generatedAtTime "2024-06-01T12:00:30Z"^^xsd:dateTime .
```

---

## Summary

Reckons.AI is **partially PROV-O aligned**. The most important property
(`prov:wasDerivedFrom`) is already in use and the named-graph provenance model
is structurally correct. The primary gaps are the absence of explicit
`prov:Activity` and `prov:Agent` declarations in the export.

These gaps are addressable entirely in `serialize.ts` using data that is already
stored in the `Source` type (`extractionBackend`, `extractionModel`, `ingestedAt`).
No schema migration is required.
