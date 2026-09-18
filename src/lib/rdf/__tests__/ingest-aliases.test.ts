import { describe, it, expect } from 'vitest';
import { aliasesFromNormalization, type SubjectRemap } from '../ingest-aliases';
import { SKOS_ALT_LABEL } from '../merge-aliases';
import type { Statement, ReviewStatus } from '../types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KEEP = 'urn:kbase:concept/ava-growers-market';
const FOLDED = 'urn:kbase:concept/ava-farmers-mkt';
const OTHER = 'urn:kbase:concept/somewhere-else';
const SELLS = 'urn:kbase:predicate/sells';

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
    g: { kind: 'iri', value: 'urn:kbase:source/doc-1' },
    sourceId: 'doc-1',
    confidence: 0.9,
    status,
    createdAt: 0,
    updatedAt: 0,
  };
}

const fold = (similarity = 0.93): SubjectRemap[] => [
  { from: FOLDED, to: KEEP, kind: 'subject', similarity },
];

describe('aliasesFromNormalization', () => {
  it('preserves the name a fold would otherwise turn into a rejected conflict', () => {
    // The exact shape normalizeEntities leaves behind: the incoming label survived the IRI
    // rewrite and now sits on the canonical entity as a rival rdfs:label.
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt', 'pending')];

    const { statements, conversions } = aliasesFromNormalization(incoming, fold(), existing);

    expect(statements[0].p.value).toBe(SKOS_ALT_LABEL);
    expect(statements[0].o).toEqual({ kind: 'literal', value: 'Ava Farmers Mkt' });
    expect(conversions).toEqual([
      { iri: KEEP, value: 'Ava Farmers Mkt', fromIri: FOLDED, similarity: 0.93 },
    ]);
  });

  it('marks the alias pending, because an embedding proposed it and no human agreed', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt', 'confirmed')];

    const { statements } = aliasesFromNormalization(incoming, fold(), existing);

    // Deliberately different from buildAliasStatements, which confirms: there, a human had
    // just settled the merge that implied the alias. Here nobody has agreed to anything.
    expect(statements[0].status).toBe('pending');
  });

  it('carries the cosine that proposed it as the statement confidence', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];

    const { statements } = aliasesFromNormalization(incoming, fold(0.884), existing);

    expect(statements[0].confidence).toBeCloseTo(0.884);
  });

  it('keeps the id and provenance, so the name keeps the citation that produced it', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];
    const originalId = incoming[0].id;

    const { statements } = aliasesFromNormalization(incoming, fold(), existing);

    expect(statements[0].id).toBe(originalId);
    expect(statements[0].sourceId).toBe('doc-1');
    expect(statements[0].g).toEqual({ kind: 'iri', value: 'urn:kbase:source/doc-1' });
  });

  it('leaves a label alone when the target has no name yet — that is naming, not synonymy', () => {
    const existing = [st(KEEP, SELLS, 'apples')]; // exists, but unnamed
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];

    const { statements, conversions } = aliasesFromNormalization(incoming, fold(), existing);

    expect(statements[0].p.value).toBe(RDFS_LABEL);
    expect(conversions).toHaveLength(0);
  });

  it('does not convert a label on an entity this ingest never folded into', () => {
    const existing = [st(OTHER, RDFS_LABEL, 'Somewhere Else')];
    const incoming = [st(OTHER, RDFS_LABEL, 'Some Other Name')];

    const { statements, conversions } = aliasesFromNormalization(incoming, fold(), existing);

    expect(statements[0].p.value).toBe(RDFS_LABEL);
    expect(conversions).toHaveLength(0);
  });

  it('does not re-add a name the entity already answers to by label', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, '  ava growers market  ')];

    const { statements, conversions } = aliasesFromNormalization(incoming, fold(), existing);

    // Case and surrounding space do not make a synonym; leave it for computeDiff to call a
    // duplicate rather than minting a second name that reads identically.
    expect(statements[0].p.value).toBe(RDFS_LABEL);
    expect(conversions).toHaveLength(0);
  });

  it('does not re-add a name already recorded as an alias, so re-ingest is idempotent', () => {
    const existing = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(KEEP, SKOS_ALT_LABEL, 'Ava Farmers Mkt'),
    ];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];

    const { conversions } = aliasesFromNormalization(incoming, fold(), existing);

    expect(conversions).toHaveLength(0);
  });

  it('ignores a rejected label when deciding what the entity answers to', () => {
    const existing = [
      st(KEEP, RDFS_LABEL, 'Ava Growers Market'),
      st(KEEP, SKOS_ALT_LABEL, 'Ava Farmers Mkt', 'rejected'),
    ];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];

    const { conversions } = aliasesFromNormalization(incoming, fold(), existing);

    // A human rejected that alias once, but it is not an ACTIVE name, so the proposal returns
    // as pending rather than being silently suppressed. Re-proposing a rejected fact is the
    // 'returned' signal computeDiff already models; suppressing it here would hide it.
    expect(conversions).toHaveLength(1);
  });

  it('mints each distinct name once when a source repeats it', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [
      st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt'),
      st(KEEP, RDFS_LABEL, 'ava farmers mkt'),
      st(KEEP, RDFS_LABEL, 'Ava Market'),
    ];

    const { statements, conversions } = aliasesFromNormalization(incoming, fold(), existing);

    expect(conversions.map((c) => c.value)).toEqual(['Ava Farmers Mkt', 'Ava Market']);
    expect(statements[1].p.value).toBe(RDFS_LABEL); // the case-variant duplicate, left alone
  });

  it('attributes the strongest fold when several entities collapse into one target', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];
    const remaps: SubjectRemap[] = [
      { from: FOLDED, to: KEEP, kind: 'subject', similarity: 0.88 },
      { from: OTHER, to: KEEP, kind: 'subject', similarity: 0.97 },
    ];

    const { conversions } = aliasesFromNormalization(incoming, remaps, existing);

    expect(conversions[0].similarity).toBe(0.97);
    expect(conversions[0].fromIri).toBe(OTHER);
  });

  it('ignores predicate remaps — a folded predicate is not a name', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];
    const remaps: SubjectRemap[] = [
      { from: 'urn:kbase:predicate/vends', to: SELLS, kind: 'predicate', similarity: 0.95 },
    ];

    const { statements, conversions } = aliasesFromNormalization(incoming, remaps, existing);

    expect(statements[0].p.value).toBe(RDFS_LABEL);
    expect(conversions).toHaveLength(0);
  });

  it('returns the statements untouched when nothing was folded', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];

    const { statements, conversions } = aliasesFromNormalization(incoming, [], existing);

    expect(statements).toEqual(incoming);
    expect(conversions).toHaveLength(0);
  });

  it('leaves non-label statements of a folded entity completely alone', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, SELLS, 'apples'), st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];

    const { statements } = aliasesFromNormalization(incoming, fold(), existing);

    expect(statements[0]).toEqual(incoming[0]);
    expect(statements[1].p.value).toBe(SKOS_ALT_LABEL);
  });

  it('skips a blank or whitespace-only label rather than minting an empty name', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, '   ')];

    const { statements, conversions } = aliasesFromNormalization(incoming, fold(), existing);

    expect(statements[0].p.value).toBe(RDFS_LABEL);
    expect(conversions).toHaveLength(0);
  });

  it('does not mutate the arrays it is given', () => {
    const existing = [st(KEEP, RDFS_LABEL, 'Ava Growers Market')];
    const incoming = [st(KEEP, RDFS_LABEL, 'Ava Farmers Mkt')];
    const snapshot = JSON.parse(JSON.stringify(incoming));

    aliasesFromNormalization(incoming, fold(), existing);

    expect(incoming).toEqual(snapshot);
  });
});
