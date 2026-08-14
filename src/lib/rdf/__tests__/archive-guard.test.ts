import { describe, it, expect } from 'vitest';
import { guardIncoming, describePrompt, needsDecision, type ArchivedMatch } from '../archive-guard';
import type { Statement } from '../types';

let n = 0;
function st(subject: string, object: string, objectIsIri = true): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: 'urn:kbase:predicate/note' },
    o: objectIsIri ? { kind: 'iri', value: object } : { kind: 'literal', value: object },
    g: { kind: 'iri', value: 'urn:kbase:source/x' },
    sourceId: 'x',
    confidence: 1,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

const ARCHIVED = 'urn:kbase:concept/old-supplier';
const match: ArchivedMatch = { entity: ARCHIVED, label: 'Old Supplier' };

describe('guardIncoming', () => {
  it('writes everything when nothing is archived', () => {
    const batch = [st('urn:kbase:concept/a', 'text', false)];
    const d = guardIncoming(batch, []);
    expect(d.write).toHaveLength(1);
    expect(d.held).toHaveLength(0);
    expect(needsDecision(d)).toBe(false);
  });

  it('holds a fact ABOUT an archived entity', () => {
    const d = guardIncoming([st(ARCHIVED, 'text', false)], [match]);
    expect(d.held).toHaveLength(1);
    expect(d.write).toHaveLength(0);
    expect(needsDecision(d)).toBe(true);
  });

  it('holds an inbound EDGE to an archived entity — it mints the duplicate just as surely', () => {
    const d = guardIncoming([st('urn:kbase:concept/invoice', ARCHIVED)], [match]);
    expect(d.held).toHaveLength(1);
  });

  it('WRITES the rest of the batch — one archived match must not block an import', () => {
    // A 200-fact import mentioning one archived entity should write 199 and pause one.
    // Holding the whole batch would punish the user for having archived anything.
    const batch = [
      st(ARCHIVED, 'held', false),
      st('urn:kbase:concept/b', 'fine', false),
      st('urn:kbase:concept/c', 'fine', false),
    ];
    const d = guardIncoming(batch, [match]);
    expect(d.write).toHaveLength(2);
    expect(d.held).toHaveLength(1);
  });

  it('never writes and holds the same statement', () => {
    const batch = [st(ARCHIVED, 'x', false), st('urn:kbase:concept/b', ARCHIVED)];
    const d = guardIncoming(batch, [match]);
    const ids = new Set(d.write.map((s) => s.id));
    expect(d.held.some((h) => ids.has(h.id))).toBe(false);
    expect(d.write.length + d.held.length).toBe(batch.length);
  });

  it('deduplicates a statement matched by two archived entities', () => {
    const other = 'urn:kbase:concept/old-part';
    const both = st(ARCHIVED, other);
    const d = guardIncoming([both], [match, { entity: other }]);
    expect(d.held).toHaveLength(1);
    expect(d.prompts).toHaveLength(2); // each entity still gets its own prompt
  });

  it('ignores a match nothing in the batch mentions', () => {
    const d = guardIncoming([st('urn:kbase:concept/a', 'x', false)], [match]);
    expect(d.prompts).toHaveLength(0);
    expect(d.write).toHaveLength(1);
  });

  it('groups the waiting statements under their entity', () => {
    const d = guardIncoming([st(ARCHIVED, 'x', false), st(ARCHIVED, 'y', false)], [match]);
    expect(d.prompts[0].statements).toHaveLength(2);
    expect(d.prompts[0].entity).toBe(ARCHIVED);
  });
});

describe('describePrompt', () => {
  it('names the entity and what is waiting on it', () => {
    const d = guardIncoming([st(ARCHIVED, 'x', false)], [match]);
    const msg = describePrompt(d.prompts[0]);
    expect(msg).toMatch(/Old Supplier/);
    expect(msg).toMatch(/1 incoming fact mentions it/);
    expect(msg).toMatch(/restore it, or keep the new one separate/);
  });

  it('falls back to the IRI tail when the archive has no label', () => {
    const d = guardIncoming([st(ARCHIVED, 'x', false)], [{ entity: ARCHIVED }]);
    expect(describePrompt(d.prompts[0])).toMatch(/old-supplier/);
  });

  it('pluralises correctly', () => {
    const d = guardIncoming([st(ARCHIVED, 'x', false), st(ARCHIVED, 'y', false)], [match]);
    expect(describePrompt(d.prompts[0])).toMatch(/2 incoming facts mention it/);
  });
});

describe('describePrompt label fallback (regression, e2e-found 2026-08-14)', () => {
  // The detector sets label = the entity IRI when the archived node has no rdfs:label, so the
  // prompt read '"urn:kbase:concept/old-supplier" is in the archive'. The unit tests passed
  // because they supplied either a real label or no label at all — never the IRI-as-label case
  // the real detector actually produces.
  it('uses the IRI tail when the label IS the IRI', () => {
    const d = guardIncoming([st(ARCHIVED, 'x', false)], [{ entity: ARCHIVED, label: ARCHIVED }]);
    const msg = describePrompt(d.prompts[0]);
    expect(msg).toMatch(/"old-supplier"/);
    expect(msg).not.toMatch(/urn:kbase:concept/);
  });

  it('still prefers a REAL label over the tail', () => {
    const d = guardIncoming([st(ARCHIVED, 'x', false)], [{ entity: ARCHIVED, label: 'Old Supplier' }]);
    expect(describePrompt(d.prompts[0])).toMatch(/"Old Supplier"/);
  });

  it('handles any scheme, not just urn:', () => {
    const http = 'https://example.org/things/widget';
    const d = guardIncoming([st(http, 'x', false)], [{ entity: http, label: http }]);
    expect(describePrompt(d.prompts[0])).toMatch(/"widget"/);
  });
});
