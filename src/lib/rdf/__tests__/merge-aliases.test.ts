import { describe, it, expect } from 'vitest';
import {
  mergeAliasValues,
  newAliasValues,
  primaryLabelAfterMerge,
  buildAliasStatements,
  entityAnswersTo,
  SKOS_ALT_LABEL,
} from '../merge-aliases';
import type { Statement, ReviewStatus } from '../types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KEEP = 'urn:kbase:concept/ava-growers-market';
const DROP = 'urn:kbase:concept/ava-farmers-market';

let n = 0;
function st(
  subject: string,
  predicate: string,
  object: string,
  status: ReviewStatus = 'confirmed',
): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: predicate },
    o: { kind: 'literal', value: object },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' },
    sourceId: 'manual',
    confidence: 1,
    status,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('mergeAliasValues', () => {
  it('preserves the dropped entity name that a merge would otherwise reject', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(DROP, RDFS_LABEL, 'Ava Farmers Market'),
    ];
    expect(mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market')).toContain(
      'Ava Farmers Market',
    );
  });

  it('never repeats the primary label as an alias', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(DROP, RDFS_LABEL, 'Ava Farmers Market'),
    ];
    expect(mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market')).not.toContain(
      'Ava Growers Market',
    );
  });

  it('treats case and whitespace differences as the same name, not a synonym', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(DROP, RDFS_LABEL, '  ava   growers market '),
    ];
    const out = mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market');
    // The case/space variant must not be recorded as a distinct name. The dropped IRI's own
    // slug ("ava farmers market") legitimately still is one, so this asserts the variant is
    // absent rather than that nothing was produced.
    expect(out.some((v) => /growers/i.test(v))).toBe(false);
  });

  it('recovers the name implied by the dropped IRI even with no rdfs:label', () => {
    const statements = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    // The dropped node was only ever identified by its IRI slug; that is still a name.
    expect(mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market').join('|')).toMatch(
      /ava.farmers.market/i,
    );
  });

  it("keeps the KEPT entity's own name when the user picks the dropped one as primary", () => {
    // The failure this guards: resolving the conflict toward B still loses A's name.
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(DROP, RDFS_LABEL, 'Ava Farmers Market'),
    ];
    expect(mergeAliasValues(KEEP, DROP, statements, 'Ava Farmers Market')).toContain(
      'Ava Growers Market',
    );
  });

  it('carries aliases the dropped entity had already accumulated (transitive merges)', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(DROP, RDFS_LABEL, 'Ava Farmers Market'),
      st(DROP, SKOS_ALT_LABEL, 'Douglas County Market'),
    ];
    const out = mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market');
    expect(out).toContain('Ava Farmers Market');
    expect(out).toContain('Douglas County Market');
  });

  it('ignores rejected and superseded labels', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(DROP, RDFS_LABEL, 'Stale Name', 'rejected'),
      st(DROP, SKOS_ALT_LABEL, 'Older Name', 'superseded'),
    ];
    const out = mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market');
    expect(out).not.toContain('Stale Name');
    expect(out).not.toContain('Older Name');
  });

  it('deduplicates when both entities already share an alias', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(KEEP, SKOS_ALT_LABEL, 'The Saturday Market'),
      st(DROP, SKOS_ALT_LABEL, 'the saturday market'),
    ];
    const out = mergeAliasValues(KEEP, DROP, statements, 'Ava Growers Market');
    expect(out.filter((v) => /saturday market/i.test(v))).toHaveLength(1);
  });
});

describe('newAliasValues', () => {
  it('omits aliases the kept entity already records, so re-merging adds nothing', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(KEEP, SKOS_ALT_LABEL, 'Ava Farmers Market'),
      st(DROP, RDFS_LABEL, 'Ava Farmers Market'),
    ];
    expect(newAliasValues(KEEP, DROP, statements, 'Ava Growers Market')).not.toContain(
      'Ava Farmers Market',
    );
  });
});

describe('primaryLabelAfterMerge', () => {
  it('reports the surviving label once the rejected one is excluded', () => {
    const a = st(KEEP, RDFS_LABEL, 'Ava Growers Market');
    const b = st(KEEP, RDFS_LABEL, 'Ava Farmers Market');
    expect(primaryLabelAfterMerge(KEEP, [a, b], new Set([b.id]))).toBe('Ava Growers Market');
    expect(primaryLabelAfterMerge(KEEP, [a, b], new Set([a.id]))).toBe('Ava Farmers Market');
  });
});

describe('buildAliasStatements', () => {
  it('emits confirmed skos:altLabel statements carrying the source graph', () => {
    let i = 0;
    const out = buildAliasStatements(
      KEEP,
      ['Ava Farmers Market'],
      { g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual' },
      () => `alias-${++i}`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].p.value).toBe(SKOS_ALT_LABEL);
    expect(out[0].s.value).toBe(KEEP);
    expect(out[0].o.value).toBe('Ava Farmers Market');
    // Confirmed, not pending — the human already settled the merge that produced it.
    expect(out[0].status).toBe('confirmed');
  });
});

describe('entityAnswersTo', () => {
  it('matches an entity by a preserved synonym, which is the point of keeping them', () => {
    const statements = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(KEEP, SKOS_ALT_LABEL, 'Ava Farmers Market'),
    ];
    expect(entityAnswersTo(KEEP, 'ava farmers market', statements)).toBe(true);
    expect(entityAnswersTo(KEEP, 'Some Other Market', statements)).toBe(false);
  });
});
