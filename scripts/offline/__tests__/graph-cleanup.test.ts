import { describe, it, expect } from 'vitest';
import { Parser, type Quad } from 'n3';
import { analyse, toPendingRow } from '../graph-cleanup';

const parse = (ttl: string): Quad[] => new Parser().parse(ttl) as Quad[];

const PREFIX = `@prefix kb: <urn:kbase:concept/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix ktype: <urn:kbase:type/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

describe('analyse — collapsed entities', () => {
  it('finds a proposition that became an entity name', () => {
    const g = parse(`${PREFIX}
      kb:orange-logic-is-an-enterprise-dam kpred:used-by kb:large-companies .
    `);
    const { findings } = analyse(g);
    const collapsed = findings.filter((f) => f.kind === 'collapsed');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].entity).toContain('orange-logic-is-an-enterprise-dam');
  });

  it('leaves an ordinary name alone', () => {
    const g = parse(`${PREFIX} kb:orange-logic kpred:used-by kb:large-companies .`);
    expect(analyse(g).findings.filter((f) => f.kind === 'collapsed')).toHaveLength(0);
  });

  it('traces a collapsed entity back to the note it came from', () => {
    const g = parse(`${PREFIX}
      kb:orange-logic-is-an-enterprise-dam kpred:extracted-from kb:note-1 .
    `);
    expect(analyse(g).findings.find((f) => f.kind === 'collapsed')?.note).toContain('note-1');
  });
});

// The bug this guards: the first run produced 45 mis-hearing findings of which 45 were noise.
describe('analyse — mis-hearings, and the noise that nearly shipped', () => {
  it('does NOT compare clock-derived note names', () => {
    // phoneticKey drops digits, so every note IRI sounds identical to every other one.
    const g = parse(`${PREFIX}
      kb:note-2026-08-27T16-56-41-444Z kpred:captured-note "a" .
      kb:note-2026-08-27T18-31-51-202Z kpred:captured-note "b" .
      kb:note-2026-08-28T13-38-52-197Z kpred:captured-note "c" .
    `);
    expect(analyse(g).findings.filter((f) => f.kind === 'misheard')).toHaveLength(0);
  });

  it('still catches a real one', () => {
    const g = parse(`${PREFIX}
      kb:matthew-roe kpred:used-by kb:a .
      kb:matthew-rowe kpred:used-by kb:b .
    `);
    const misheard = analyse(g).findings.filter((f) => f.kind === 'misheard');
    expect(misheard.length).toBeGreaterThan(0);
    expect(misheard[0].detail).toMatch(/matthew-ro/);
  });

  it('ignores names too short to compare', () => {
    const g = parse(`${PREFIX} kb:ab kpred:used-by kb:ac .`);
    expect(analyse(g).findings.filter((f) => f.kind === 'misheard')).toHaveLength(0);
  });
});

describe('analyse — untyped notes', () => {
  it('finds a captured note with no rdf:type', () => {
    const g = parse(`${PREFIX} kb:note-1 kpred:captured-note "text" .`);
    const found = analyse(g).findings.filter((f) => f.kind === 'untyped-note');
    expect(found).toHaveLength(1);
    expect(found[0].entity).toContain('note-1');
  });

  it('leaves a note that already has a type alone', () => {
    const g = parse(`${PREFIX}
      kb:note-1 kpred:captured-note "text" ;
                rdf:type ktype:Document .
    `);
    expect(analyse(g).findings.filter((f) => f.kind === 'untyped-note')).toHaveLength(0);
  });
});

describe('analyse — bookkeeping is not content', () => {
  it('does not count reification triples as facts', () => {
    const g = parse(`${PREFIX}
      @prefix kmeta: <urn:kbase:meta/> .
      kb:a kpred:used-by kb:b .
      <urn:kbase:stmt/1> rdf:type rdf:Statement ;
        rdf:subject kb:a ; rdf:predicate kpred:used-by ; rdf:object kb:b ;
        kmeta:status "confirmed" .
    `);
    // One real fact; the reification block describes it rather than adding to it.
    expect(analyse(g).facts).toBe(1);
  });
});

describe('toPendingRow', () => {
  it('proposes RE-EXTRACTION for a collapsed entity, never a rewrite', () => {
    const row = toPendingRow(
      { kind: 'collapsed', entity: 'urn:kbase:concept/x-is-a-y', detail: 'collapsed', note: 'urn:kbase:concept/note-1' },
      'personal-notes',
    );
    expect(String(row.object)).toContain('Re-extract');
    expect(String(row.note)).toContain('not to rewrite this fact');
    expect(row.priority).toBe('high');
  });

  it('proposes the Document type directly for an untyped note', () => {
    const row = toPendingRow(
      { kind: 'untyped-note', entity: 'urn:kbase:concept/note-1', detail: 'untyped' },
      'personal-notes',
    );
    expect(row.predicate).toContain('22-rdf-syntax-ns#type');
    expect(row.object).toBe('urn:kbase:type/Document');
    expect(row.objectKind).toBe('iri');
  });

  it('routes every row to the graph it came from', () => {
    const row = toPendingRow({ kind: 'orphaned', entity: 'urn:kbase:concept/x', detail: 'd' }, 'my-graph');
    expect(row.kb).toBe('my-graph');
  });
});
