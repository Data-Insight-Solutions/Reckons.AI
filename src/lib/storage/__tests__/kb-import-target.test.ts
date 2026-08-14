import { describe, it, expect } from 'vitest';
import { resolveImportTarget, uniqueKbName, parseGeneratedAt } from '../kb-import-target';
import type { KbEntry } from '../kb-registry';

function entry(p: Partial<KbEntry> & { id: string; name: string }): KbEntry {
  return { createdAt: 0, ...p } as KbEntry;
}

const REG: KbEntry[] = [
  entry({ id: 'kb1', name: 'reckons-roadmap', stableId: 'stable-roadmap', statementCount: 900 }),
  entry({ id: 'kb2', name: 'My Graph' }),
];

describe('resolveImportTarget', () => {
  it('replaces in place when the stable id matches — same graph, newer copy', () => {
    const t = resolveImportTarget({ name: 'anything', stableId: 'stable-roadmap' }, REG);
    expect(t.kind).toBe('replace');
    if (t.kind === 'replace') {
      expect(t.entry.id).toBe('kb1');
      expect(t.basis).toBe('stable-id');
    }
  });

  it('prefers stable id over name when the two disagree', () => {
    const t = resolveImportTarget({ name: 'My Graph', stableId: 'stable-roadmap' }, REG);
    expect(t.kind).toBe('replace');
    if (t.kind === 'replace') expect(t.entry.id).toBe('kb1');
  });

  it('reports a NAME-only collision as ambiguous rather than replacing', () => {
    // This is the load-bearing case: overwriting on a name match can destroy another
    // project's graph that happens to share a filename.
    const t = resolveImportTarget({ name: 'reckons-roadmap' }, REG);
    expect(t.kind).toBe('ambiguous');
    if (t.kind === 'ambiguous') expect(t.basis).toBe('name');
  });

  it('treats a name match as ambiguous even when the stable ids differ', () => {
    const t = resolveImportTarget({ name: 'reckons-roadmap', stableId: 'some-other-id' }, REG);
    expect(t.kind).toBe('ambiguous');
  });

  it('ignores the .ttl extension and case, which is how the duplicates were created', () => {
    // The ingest page derives the name from the filename, so "reckons-roadmap.ttl" must
    // collide with the existing "reckons-roadmap".
    expect(resolveImportTarget({ name: 'reckons-roadmap.ttl' }, REG).kind).toBe('ambiguous');
    expect(resolveImportTarget({ name: 'RECKONS-ROADMAP' }, REG).kind).toBe('ambiguous');
    expect(resolveImportTarget({ name: '  reckons-roadmap  ' }, REG).kind).toBe('ambiguous');
  });

  it('creates when nothing matches', () => {
    expect(resolveImportTarget({ name: 'brand-new-graph' }, REG).kind).toBe('create');
  });

  it('does not match an entry against itself when re-importing into it', () => {
    const t = resolveImportTarget({ name: 'reckons-roadmap', stableId: 'stable-roadmap' }, REG, 'kb1');
    expect(t.kind).toBe('create');
  });

  it('creates on an empty registry', () => {
    expect(resolveImportTarget({ name: 'anything', stableId: 'x' }, []).kind).toBe('create');
  });
});

describe('staleness guard', () => {
  const T = Date.UTC(2026, 7, 13);
  const REG_TS: KbEntry[] = [
    entry({ id: 'kb1', name: 'roadmap', stableId: 'sid', lastModified: T }),
  ];

  it('replaces when the incoming export is NEWER than the graph', () => {
    const t = resolveImportTarget({ name: 'roadmap', stableId: 'sid', generatedAt: T + 1000 }, REG_TS);
    expect(t.kind).toBe('replace');
  });

  it('refuses to silently replace a NEWER graph with an older export', () => {
    // The hazard identity-matching introduces: a stale workspace root holds a perfectly
    // valid, perfectly identified, months-out-of-date copy.
    const t = resolveImportTarget({ name: 'roadmap', stableId: 'sid', generatedAt: T - 86_400_000 }, REG_TS);
    expect(t.kind).toBe('ambiguous');
    if (t.kind === 'ambiguous') expect(t.basis).toBe('stale');
  });

  it('still replaces when the timestamp is unknown — hand-written TTL must stay importable', () => {
    expect(resolveImportTarget({ name: 'roadmap', stableId: 'sid' }, REG_TS).kind).toBe('replace');
  });

  it('still replaces when the graph has no recorded lastModified', () => {
    const reg = [entry({ id: 'kb1', name: 'roadmap', stableId: 'sid' })];
    expect(
      resolveImportTarget({ name: 'roadmap', stableId: 'sid', generatedAt: 1 }, reg).kind,
    ).toBe('replace');
  });
});

describe('parseGeneratedAt', () => {
  it('reads the exporter header', () => {
    const ttl = '# generated 2026-08-13T19:42:06.246Z\n# 3132 statements — full annotated export\n\n@prefix kb: <x> .';
    expect(parseGeneratedAt(ttl)).toBe(Date.parse('2026-08-13T19:42:06.246Z'));
  });

  it('returns undefined for a hand-written TTL with no header', () => {
    expect(parseGeneratedAt('@prefix kb: <urn:kbase:concept/> .\nkb:a rdfs:label "x" .')).toBeUndefined();
  });

  it('returns undefined rather than NaN for an unparseable date', () => {
    expect(parseGeneratedAt('# generated not-a-date\n')).toBeUndefined();
  });
});

describe('uniqueKbName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueKbName('brand-new', REG)).toBe('brand-new');
  });

  it('suffixes a taken name readably', () => {
    expect(uniqueKbName('reckons-roadmap', REG)).toBe('reckons-roadmap (2)');
  });

  it('keeps counting past an existing suffix', () => {
    const reg = [...REG, entry({ id: 'kb3', name: 'reckons-roadmap (2)' })];
    expect(uniqueKbName('reckons-roadmap', reg)).toBe('reckons-roadmap (3)');
  });
});
