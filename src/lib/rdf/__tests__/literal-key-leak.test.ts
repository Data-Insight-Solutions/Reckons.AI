/**
 * 2026-09-10 incident: an exported graph contained `<l:high||> skos:altLabel "high-priority"`
 * plus a reification with `rdf:subject <l:high||>`. `l:high||` is termKey() of the plain literal
 * "high" — a graph NODE ID used as a subject IRI. N3 rejects it, so the whole graph would not
 * re-import. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Parser } from 'n3';
import {
  termKey, lit, iri, looksLikeTermKey, iriFromNodeKey, hasLeakedTermKey, type Statement,
} from '../types';
import { toTurtle, toTurtleFull, toTriG, toNQuads } from '../serialize';
import { buildAliasStatements } from '../merge-aliases';
import { importTurtleFull } from '../import-ttl';

const pushed = vi.hoisted(() => [] as Array<{ title: string; body?: string; type: string }>);
vi.mock('../../stores/notifications.svelte', () => ({
  pushNotification: (n: { title: string; body?: string; type: string }) => { pushed.push(n); },
}));
const flush = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => { pushed.length = 0; });

const ALT = 'http://www.w3.org/2004/02/skos/core#altLabel';
const G = { kind: 'iri', value: 'urn:kbase:source/manual' } as const;

function st(id: string, s: Statement['s'], p: string, o: Statement['o']): Statement {
  return { id, s, p: iri(p), o, g: G, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: 1, updatedAt: 1 };
}
const good = st('g1', iri('urn:kbase:concept/task'), 'http://www.w3.org/2000/01/rdf-schema#label', lit('Task'));

/** What the node panel did before the fix: key -> "IRI" via the startsWith('i:') ? slice : key fallback. */
const oldBuggyIri = (key: string) => (key.startsWith('i:') ? key.slice(2) : key);

describe('literal node key leaking in as a subject IRI', () => {
  const key = termKey(lit('high'));
  it('reproduces the incident key', () => {
    expect(key).toBe('l:high||');
  });

  it('the shared helper refuses non-IRI node keys (the fix at the source)', () => {
    expect(iriFromNodeKey(key)).toBeNull();
    expect(iriFromNodeKey('b:abc')).toBeNull();
    expect(iriFromNodeKey(null)).toBeNull();
    expect(iriFromNodeKey('i:urn:kbase:concept/task')).toBe('urn:kbase:concept/task');
    // double-wrapped key is not an IRI either
    expect(iriFromNodeKey('i:l:high||')).toBeNull();
  });

  it('looksLikeTermKey rejects only exact key shapes', () => {
    for (const v of ['l:high||', 'l:two words|http://www.w3.org/2001/XMLSchema#integer|', 'l:x||en', 'i:urn:kbase:x', 'i:http://a/b', 'b:node1'])
      expect(looksLikeTermKey(v), v).toBe(true);
    for (const v of ['urn:kbase:concept/l:high', 'http://example.org/l:x', 'http://example.org/a|b', 'mailto:a@b.c', 'urn:isbn:123', 'l:high', 'bitcoin:abc', 'info:doi/10.1', 'later:x'])
      expect(looksLikeTermKey(v), v).toBe(false);
  });

  // Confirms the failure the old code path produced, so the guards below are not vacuous.
  it('REPRODUCTION: the pre-fix derivation emitted Turtle that N3 rejects', () => {
    const leaked = buildAliasStatements(oldBuggyIri(key), ['high-priority'], { g: G, sourceId: 'manual' }, () => 'a1');
    const naive = `<${leaked[0].s.value}> <${ALT}> "high-priority" .`;
    expect(() => new Parser({ format: 'TriG' }).parse(naive)).toThrow();
    expect(hasLeakedTermKey(leaked[0])).toBe(true);
  });

  const leaked = st('bad1', { kind: 'iri', value: key }, ALT, lit('high-priority'));

  it('serializers skip leaked statements loudly and still round-trip through N3', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = [good, leaked];
    const outs = [toTurtle(input), toTurtleFull(input, []), toTriG(input)];
    for (const out of outs) {
      expect(out).not.toContain('<l:');
      expect(out).toContain('SKIPPED 1');
      expect(() => new Parser({ format: 'TriG' }).parse(out)).not.toThrow();
    }
    expect(toNQuads(input)).not.toContain('l:high');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a leaked object is also skipped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const asObject = st('bad2', iri('urn:kbase:concept/task'), 'urn:kbase:predicate/related', { kind: 'iri', value: key });
    const out = toTurtle([good, asObject]);
    expect(() => new Parser({ format: 'TriG' }).parse(out)).not.toThrow();
    expect(out).not.toContain('l:high');
    err.mockRestore();
  });

  it('clean graphs are unaffected (no SKIPPED note)', () => {
    expect(toTurtle([good])).not.toContain('SKIPPED');
  });
});

describe('importing a file already damaged by the leak', () => {
  const damaged = `
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix kmeta: <urn:kbase:meta/> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<urn:kbase:concept/task> rdfs:label "Task" .
<l:high||> skos:altLabel "high-priority" .

<urn:kbase:stmt/s1> a rdf:Statement ;
    rdf:subject <urn:kbase:concept/task> ; rdf:predicate rdfs:label ; rdf:object "Task" ;
    kmeta:status "confirmed" ; prov:wasDerivedFrom <urn:kbase:source/manual> .
<urn:kbase:stmt/s2> a rdf:Statement ;
    rdf:subject <l:high||> ; rdf:predicate skos:altLabel ; rdf:object "high-priority" ;
    kmeta:status "confirmed" ; prov:wasDerivedFrom <urn:kbase:source/manual> .
`;

  it('plain parse fails (this is why the whole graph was lost)', () => {
    expect(() => new Parser({ format: 'TriG' }).parse(damaged)).toThrow();
  });

  it('imports everything else and reports what it quarantined', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await importTurtleFull(damaged);
    expect(res.statements).toHaveLength(1);
    expect(res.statements[0].o.value).toBe('Task');
    expect(res.quarantined?.count).toBe(1);
    expect(res.quarantined?.samples).toEqual(['l:high||']);
    expect(res.statements.some(hasLeakedTermKey)).toBe(false);
    warn.mockRestore();
  });

  it('still throws for a file that is broken for another reason', async () => {
    await expect(importTurtleFull('<urn:a> <urn:b> .. garbage')).rejects.toThrow();
  });
});

describe('a cut is never silent: the person is told, not just the console', () => {
  it('export: skipped statements raise one notification per export', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = st('b', { kind: 'iri', value: 'l:high||' }, ALT, lit('x'));
    toTurtle([good, bad]);
    await flush();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].type).toBe('warn');
    expect(pushed[0].title).toContain('1 fact left out');
    toTurtle([good]);
    await flush();
    expect(pushed).toHaveLength(1); // clean export: no notification
    err.mockRestore();
  });

  it('import (workspace/kb-import pass the file name): names the file, count, and that it is unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ttl = '<urn:a> <urn:b> "ok" .\n<l:high||> <http://www.w3.org/2004/02/skos/core#altLabel> "x" .\n';
    await importTurtleFull(ttl, { name: 'my-private-graph.ttl' });
    await flush();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].body).toContain('my-private-graph.ttl');
    expect(pushed[0].body).toContain('1 fact was set aside');
    expect(pushed[0].body).toContain('file itself was not changed');
    warn.mockRestore();
  });
});
