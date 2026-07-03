import { describe, it, expect } from 'vitest';
import {
  readCurrentsSettings,
  currentsSettingsToStatements,
  isTypeAllowed,
  applyTypeGate,
  buildArrivalStatements,
  normalizeTypeIri,
  CURRENTS_SUBJECT,
  CUR_ALLOWED_TYPE,
  KB_MENTIONED_IN,
  type CurrentsSettings
} from '../currents';
import { isMetaPredicate, iri, lit, type Statement } from '../types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function stmt(s: string, p: string, o: Statement['o'], status: Statement['status'] = 'pending'): Statement {
  return {
    id: `${s}|${p}|${o.value}`,
    s: iri(s), p: iri(p), o,
    g: iri('urn:kbase:source/test'),
    sourceId: 'test', confidence: 0.9, status,
    createdAt: 1, updatedAt: 1
  };
}

const SAMPLE: CurrentsSettings = {
  allowedTypes: ['urn:kbase:type/Concept', 'urn:kbase:type/Tool'],
  location: 'Colorado, US',
  currents: [
    { slug: 'hn', sourceUrl: 'https://hnrss.org/frontpage', kind: 'rss', label: 'Hacker News', cadenceMinutes: 60, enabled: true },
    { slug: 'arxiv-ai', sourceUrl: 'https://arxiv.org/rss/cs.AI', kind: 'rss', label: 'arXiv AI', cadenceMinutes: 360, enabled: false }
  ]
};

describe('currents settings round-trip', () => {
  it('write→read→write is identity', () => {
    const stmts = currentsSettingsToStatements(SAMPLE);
    const read = readCurrentsSettings(stmts);
    expect(read.allowedTypes).toEqual([...SAMPLE.allowedTypes].sort());
    expect(read.location).toBe(SAMPLE.location);
    expect(read.currents).toEqual([...SAMPLE.currents].sort((a, b) => a.slug.localeCompare(b.slug)));
    const stmts2 = currentsSettingsToStatements(read);
    expect(stmts2.map((s) => s.id)).toEqual(stmts.map((s) => s.id));
  });

  it('statement ids are deterministic', () => {
    const a = currentsSettingsToStatements(SAMPLE).map((s) => s.id);
    const b = currentsSettingsToStatements(SAMPLE).map((s) => s.id);
    expect(a).toEqual(b);
  });

  it('ignores rejected/superseded settings statements', () => {
    const stmts = currentsSettingsToStatements(SAMPLE);
    const rejected = stmts.map((s) => ({ ...s, status: 'rejected' as const }));
    const read = readCurrentsSettings(rejected);
    expect(read.allowedTypes).toEqual([]);
    expect(read.currents).toEqual([]);
  });

  it('normalizes bare local names to full type IRIs', () => {
    expect(normalizeTypeIri('Tool')).toBe('urn:kbase:type/Tool');
    expect(normalizeTypeIri('urn:kbase:type/Tool')).toBe('urn:kbase:type/Tool');
    const read = readCurrentsSettings([stmt(CURRENTS_SUBJECT, CUR_ALLOWED_TYPE, lit('Tool'), 'confirmed')]);
    expect(read.allowedTypes).toEqual(['urn:kbase:type/Tool']);
  });
});

describe('isTypeAllowed', () => {
  it('empty allowlist allows everything', () => {
    const s: CurrentsSettings = { allowedTypes: [], currents: [] };
    expect(isTypeAllowed(s, 'urn:kbase:type/Person')).toBe(true);
  });
  it('non-empty allowlist is exact', () => {
    expect(isTypeAllowed(SAMPLE, 'urn:kbase:type/Tool')).toBe(true);
    expect(isTypeAllowed(SAMPLE, 'Tool')).toBe(true);
    expect(isTypeAllowed(SAMPLE, 'urn:kbase:type/Person')).toBe(false);
  });
});

describe('applyTypeGate', () => {
  const person = 'urn:kbase:concept/jane-doe';
  const tool = 'urn:kbase:concept/neat-tool';
  const existing = 'urn:kbase:concept/known-thing';

  const batch = [
    stmt(person, RDF_TYPE, iri('urn:kbase:type/Person')),
    stmt(person, 'urn:kbase:predicate/works-at', lit('Acme')),
    stmt(tool, RDF_TYPE, iri('urn:kbase:type/Tool')),
    stmt(tool, 'urn:kbase:predicate/relates-to', iri(person)),
    stmt(existing, 'urn:kbase:predicate/notes', lit('a new fact')),
    stmt(existing, RDF_TYPE, iri('urn:kbase:type/Person'))
  ];

  it('drops disallowed NEW entities (as subject and IRI-object) but keeps allowed ones', () => {
    const res = applyTypeGate(batch, new Set([existing]), SAMPLE);
    const subjects = res.allowed.map((s) => s.s.value);
    expect(subjects).not.toContain(person);
    expect(res.allowed.some((s) => s.o.kind === 'iri' && s.o.value === person)).toBe(false);
    expect(subjects).toContain(tool);
    expect(res.gatedEntities[person]).toEqual(['urn:kbase:type/Person']);
    expect(res.gatedStatementCount).toBe(3);
  });

  it('facts on already-existing entities always pass, even with disallowed types', () => {
    const res = applyTypeGate(batch, new Set([existing]), SAMPLE);
    const existingFacts = res.allowed.filter((s) => s.s.value === existing);
    expect(existingFacts).toHaveLength(2);
  });

  it('empty allowlist gates nothing', () => {
    const res = applyTypeGate(batch, new Set(), { allowedTypes: [], currents: [] });
    expect(res.allowed).toHaveLength(batch.length);
    expect(res.gatedStatementCount).toBe(0);
  });

  it('untyped new entities pass (gate judges only what it can see)', () => {
    const untyped = [stmt('urn:kbase:concept/mystery', 'urn:kbase:predicate/mentions', lit('x'))];
    const res = applyTypeGate(untyped, new Set(), SAMPLE);
    expect(res.allowed).toHaveLength(1);
  });
});

describe('buildArrivalStatements', () => {
  const extracted = [
    stmt('urn:kbase:concept/quantum-chip', RDF_TYPE, iri('urn:kbase:type/Tool')),
    stmt('urn:kbase:concept/quantum-chip', 'urn:kbase:predicate/made-by', iri('urn:kbase:concept/acme'))
  ];
  const arrival = buildArrivalStatements({
    title: 'New Quantum Chip Announced!',
    url: 'https://example.com/quantum',
    publishedAt: '2026-07-02',
    excerpt: 'A new quantum chip was announced.',
    sourceId: 'src-1',
    extracted
  });

  it('creates a Document article node with label and url', () => {
    const article = 'urn:kbase:concept/new-quantum-chip-announced';
    expect(arrival.some((s) => s.s.value === article && s.p.value === RDF_TYPE && s.o.value === 'urn:kbase:type/Document')).toBe(true);
    expect(arrival.some((s) => s.s.value === article && s.o.value === 'New Quantum Chip Announced!')).toBe(true);
    expect(arrival.some((s) => s.s.value === article && s.o.value === 'https://example.com/quantum')).toBe(true);
  });

  it('links each extracted concept to the article via mentioned-in, once', () => {
    const links = arrival.filter((s) => s.p.value === KB_MENTIONED_IN);
    expect(links).toHaveLength(1);
    expect(links[0].s.value).toBe('urn:kbase:concept/quantum-chip');
  });

  it('everything is pending and includes the extracted statements', () => {
    expect(arrival.every((s) => s.status === 'pending')).toBe(true);
    for (const e of extracted) expect(arrival).toContainEqual(e);
  });
});

describe('isMetaPredicate integration', () => {
  it('hides the whole currents namespace from graph edges', () => {
    expect(isMetaPredicate(CUR_ALLOWED_TYPE)).toBe(true);
    expect(isMetaPredicate('urn:reckons:meta/currents/sourceUrl')).toBe(true);
    expect(isMetaPredicate(KB_MENTIONED_IN)).toBe(false);
  });
});
