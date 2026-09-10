/**
 * The validator that stands between a local model and the review queue.
 *
 * This is the whole reason an agent-tier job is safe: the model is a plugin inside a harness that
 * grounds it, checks its work, and emits a PROPOSAL a human gates. Every case below is a real
 * output shape — the inline-markdown one is literally what qwen3:32b produced on the first run and
 * the validator let through, which is why the check now looks inside a line and not only at its
 * start (F74.3: local models hallucinate conventions; validate, do not trust).
 *
 * Importing this module must not fire a model: `main()` is guarded, and these tests exercise only
 * the pure functions.
 */
import { describe, it, expect } from 'vitest';
import { rejectReason, proseWeight, MIN_WORDS, DOCS_GRAPHS } from '../offline/docs-expand';

const SUBJECT = 'urn:reckons:arch/KnowledgeGraph';

/** A draft that should pass: long enough, plain, no invention. */
const GOOD =
  'A knowledge graph is a graph-structured database where entities are nodes and relationships '
  + 'are edges. Triples, each with a subject, predicate and object, form the graph, so the same '
  + 'subject can appear in many triples and build a web of interconnected knowledge. The result is '
  + 'queryable in ways a document store is not, because every claim is separately addressable.';

describe('rejectReason — what never reaches a human reviewer', () => {
  it('accepts a grounded, plainly written paragraph', () => {
    expect(rejectReason(GOOD, SUBJECT)).toBeNull();
  });

  it('rejects empty and near-empty output', () => {
    expect(rejectReason('', SUBJECT)).toBe('empty');
    expect(rejectReason('A knowledge graph stores triples.', SUBJECT)).toMatch(/too short/);
  });

  it('rejects hedging, which is how a model pads when it has nothing', () => {
    const hedged = GOOD.replace('is a graph-structured database', 'might be a graph-structured database');
    expect(rejectReason(hedged, SUBJECT)).toMatch(/hedging/);
  });

  it('rejects block markdown — the value becomes a TTL literal, not a document', () => {
    expect(rejectReason(`## Heading\n\n${GOOD}`, SUBJECT)).toBe('markdown formatting');
    expect(rejectReason(`- point one\n- point two\n${GOOD}`, SUBJECT)).toBe('markdown formatting');
  });

  /**
   * THE REGRESSION. qwen3:32b wrote "the IRI *urn:reckons:guide/WhatIsReckonsAI* uniquely names a
   * concept" and the validator passed it, because it only tested line starts. Asterisks inside a
   * TTL literal survive all the way onto the page and render as italics nobody wrote.
   */
  it('rejects INLINE markdown, not just markdown at the start of a line', () => {
    const italic = `For example, the IRI *urn:reckons:guide/Thing* names a concept. ${GOOD}`;
    expect(rejectReason(italic, SUBJECT)).toBe('inline markdown');
    expect(rejectReason(`${GOOD} Use \`kpred:description\` here.`, SUBJECT)).toBe('inline markdown');
  });

  it('rejects an invented repository path — a fact that reads true and points at nothing', () => {
    const invented = `${GOOD} It is implemented in src/lib/totally/made-up.ts today.`;
    expect(rejectReason(invented, SUBJECT)).toMatch(/invented path/);
  });

  it('rejects our own concept IRIs in prose, but allows an illustrative one', () => {
    // A reader has no use for kb:knowledge-graph; on a page about identifiers, an example IRI is
    // the point. The reviewer judges the second case — the validator should not swallow it.
    expect(rejectReason(`${GOOD} See kb:knowledge-graph.`, SUBJECT))
      .toBe('leaked a project IRI into prose');
    expect(rejectReason(`${GOOD} An identifier looks like urn:example:thing in practice.`, SUBJECT))
      .toBeNull();
  });

  it('rejects a restatement of the label', () => {
    const circular = `Knowledge Graph is Knowledge Graph, and ${GOOD.toLowerCase()}`;
    expect(rejectReason(circular, 'urn:x/Knowledge Graph')).toBeTruthy();
  });
});

describe('targeting', () => {
  it('measures prose from the real graphs, and finds the thin entities', () => {
    // A subject that carries a definition scores above zero; a nonexistent one scores zero. This
    // pins that the corpus actually loaded — a silent parse failure would make every target list
    // empty and the job would cheerfully report nothing to do.
    expect(proseWeight('urn:this/does/not/exist')).toBe(0);
    expect(DOCS_GRAPHS.length).toBeGreaterThan(5);
  });

  it('uses the same threshold the page generator uses to decide what is a page', () => {
    // If these drift, the job drafts prose for entities that were never going to be pages, or
    // ignores ones that are. 45 is PAGE_THRESHOLD_WORDS in scripts/docs-pages.ts.
    expect(MIN_WORDS).toBe(45);
  });
});
