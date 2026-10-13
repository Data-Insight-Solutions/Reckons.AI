import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { graphSense } from '../lib/term-sense-rules';
import { findings, jargonPattern, ratchetCounts, readTermConfig } from '../ui-terms';
import type { Occurrence } from '../ui-copy';

const ROOT = join(import.meta.dirname, '../../..');

describe('graph sense rules against the hand-labelled fixture', () => {
  const fx = JSON.parse(readFileSync(join(ROOT, 'scripts/agent/fixtures/ui-copy-graph.labels.json'), 'utf8')) as { items: { sentence: string; label: string }[] };
  it('decide most of /kb and are NEVER wrong on it (the panel was right 3 of 59)', () => {
    const seen = new Map<string, number>();
    let right = 0; const wrong: string[] = []; let undecided = 0;
    for (const it of fx.items) {
      const n = seen.get(it.sentence) ?? 0; seen.set(it.sentence, n + 1);
      const ms = [...it.sentence.matchAll(/\bgraphs?\b/gi)]; const m = ms[Math.min(n, ms.length - 1)];
      const r = graphSense(it.sentence, m?.index ?? 0, m?.[0]);
      if (r.sense === 'undecided') undecided++; else if (r.sense === it.label) right++; else wrong.push(`${r.sense}≠${it.label}: ${it.sentence}`);
    }
    expect(wrong).toEqual([]);
    expect(right).toBeGreaterThanOrEqual(47);
    expect(undecided).toBeLessThanOrEqual(12);
  });
  it('keeps the drawn picture and the RDF term; rewords a file format', () => {
    expect(graphSense('pod view on the graph', 'pod view on the '.length).sense).toBe('keep');
    expect(graphSense('3D models for graph nodes', '3D models for '.length).sense).toBe('keep');
    expect(graphSense('one named graph per source', 'one named '.length).sense).toBe('keep');
    expect(graphSense('is it a Turtle graph?', 'is it a Turtle '.length).sense).toBe('reword');
    expect(graphSense('Rename graph', 'Rename '.length).sense).toBe('space');
    expect(graphSense('Manage graphs', 'Manage '.length, 'graphs').sense).toBe('space');
  });
});

describe('ui-terms config and findings', () => {
  const ttl = `@prefix kpred: <urn:kbase:predicate/> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
    <urn:kbase:vocabulary/terminology> kpred:ui-jargon "IndexedDB", "triple" ; kpred:ui-term-ratchet "jargon/3", "graph-as-space/9" ; kpred:technical-surface "src/lib/components/Dev" .
    <urn:kbase:term/statement> skos:prefLabel "statement" ; kpred:user-label "fact" ; kpred:standards-label "rdf:Statement" .
    <urn:kbase:term/x> skos:prefLabel "triple" ; kpred:user-label "fact" .`;
  const cfg = readTermConfig(ttl);
  it('reads jargon (with prefixed standards names and the user word as the fix), surfaces and baselines', () => {
    expect(cfg.jargon.get('rdf:Statement')).toBe('fact');
    expect(cfg.jargon.get('triple')).toBe('fact');
    expect(cfg.jargon.has('IndexedDB')).toBe(true);
    expect(cfg.ratchets).toEqual({ jargon: 3, 'graph-as-space': 9 });
    expect(cfg.surfaces).toEqual(['src/lib/components/Dev']);
  });
  it('matches whole words, plurals, exact case for acronyms and any case for words', () => {
    const p = jargonPattern(cfg.jargon.keys());
    const hits = (s: string) => [...s.matchAll(p)].map((m) => m[0]);
    expect(hits('Triples are stored in IndexedDB; see rdf:Statement')).toEqual(['Triples', 'IndexedDB', 'rdf:Statement']);
    expect(hits('indexeddb, tripled, kb_triple, urn:x/triple')).toEqual([]);
  });
  it('turns occurrences into findings, skips technical surfaces, and ratchets templates only', () => {
    const o = (file: string, word: string, sentence: string, kind: Occurrence['kind'], where: Occurrence['where'] = 'text'): Occurrence => ({ file, line: 1, start: 0, end: 0, word, kind, where, sentence });
    const f = findings([
      o('src/a.svelte', 'triples', 'no outgoing triples', 'jargon'),
      o('src/a.svelte', 'graph', 'Rename graph', 'graph'),
      o('src/a.svelte', 'graph', 'pod view on the graph', 'graph'),
      o('src/a.ts', 'graph', 'Rename graph', 'graph', 'script'),
      o('src/lib/components/DevPanel.svelte', 'triple', 'a triple', 'jargon'),
    ], cfg);
    expect(f.map((x) => `${x.check}:${x.sense ?? ''}:${x.suggest ?? ''}`)).toEqual(['jargon::fact', 'graph:space:space', 'graph:space:space']);
    expect(ratchetCounts(f)).toEqual({ jargon: 1, 'graph-as-space': 1 });
  });
  it('judges the second "graph" in a sentence at its own position', () => {
    const s = 'Your graph is empty. Load a starter graph to explore';
    const occ = (k: number): Occurrence => ({ file: 'src/b.svelte', line: 1, start: k, end: k, word: 'graph', kind: 'graph', where: 'text', sentence: s });
    expect(findings([occ(0), occ(1)], cfg).map((x) => x.rule)).toHaveLength(2);
  });
});
