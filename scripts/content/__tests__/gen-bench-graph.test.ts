/**
 * Bench tasks as graph entities (F183.2): the Testing graph parses to the task objects the runner
 * uses, the answer key survived the move out of TypeScript, and a malformed task fails loudly with
 * the entity named instead of being defaulted into a benchmark that grades against nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { briefsFor, loadBenchTasks, parseBenchTasks, TESTING_GRAPH } from '../gen-bench-graph';

const PREFIXES = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix hnav: <urn:reckons:nav/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix bench: <urn:reckons:bench/> .
`;
/** A minimal valid graph: three stages, one image brief with four items, one video and one splat brief. */
const valid = (): string => PREFIXES + `
bench:Task-image a bench:BenchTask ; bench:stage "image" ; bench:seed 7 ; bench:seed 8 .
bench:Task-video a bench:BenchTask ; bench:stage "video" ; bench:seed 7 ; bench:seed 8 .
bench:Task-splat a bench:BenchTask ; bench:stage "splat" ; bench:seed 7 ; bench:seed 8 .
bench:image-cup a bench:Brief ; rdfs:label "A cup" ; skos:broader bench:Task-image ; hnav:order 1 ; bench:tier "smoke" ; kpred:prompt "A cup on a desk" .
${['a', 'b', 'c', 'd'].map((id, i) => `bench:image-cup--${id} a bench:ChecklistItem ; skos:broader bench:image-cup ; hnav:order ${4 - i} ; skos:notation "${id}" ; kpred:question "Question ${id}?" .`).join('\n')}
bench:video-cup a bench:Brief ; rdfs:label "Steam" ; skos:broader bench:Task-video ; hnav:order 1 ; bench:tier "hard" ; bench:source-brief bench:image-cup ; kpred:prompt "steam rises" ; bench:min-motion 0.01 ; kpred:description "steam moves" .
bench:splat-cup a bench:Brief ; rdfs:label "Cup" ; skos:broader bench:Task-splat ; hnav:order 1 ; bench:tier "smoke" ; bench:source-brief bench:image-cup ; bench:gaussians 1000 ; bench:depth-to-width-min 0.3 ; bench:depth-to-width-max 1.6 ; bench:min-silhouette-iou 0.5 ; kpred:description "a solid" .
`;

describe('parseBenchTasks: the TTL shape becomes the task objects', () => {
  it('round-trips a small graph, ordering children by hnav:order, not by file order', () => {
    const t = parseBenchTasks(valid());
    expect(t.seeds).toEqual([7, 8]);
    expect(t.image).toEqual([{
      slug: 'cup', label: 'A cup', tier: 'smoke', prompt: 'A cup on a desk',
      checklist: [
        { id: 'd', question: 'Question d?' }, { id: 'c', question: 'Question c?' }, { id: 'b', question: 'Question b?' }, { id: 'a', question: 'Question a?' },
      ],
    }]);
    expect(t.video).toEqual([{ slug: 'cup', label: 'Steam', tier: 'hard', sourceImage: 'cup', prompt: 'steam rises', expects: { minMotion: 0.01, note: 'steam moves' } }]);
    expect(t.splat).toEqual([{ slug: 'cup', label: 'Cup', tier: 'smoke', sourceImage: 'cup', gaussians: 1000, expects: { depthToWidth: [0.3, 1.6], minSilhouetteIoU: 0.5, note: 'a solid' } }]);
  });
  it('briefsFor narrows by tier', () => {
    const t = parseBenchTasks(valid());
    expect(briefsFor(t, 'video', 'smoke')).toHaveLength(0);
    expect(briefsFor(t, 'video', 'hard')).toHaveLength(1);
    expect(briefsFor(t, 'image', 'all')).toHaveLength(1);
  });
});

describe('parseBenchTasks: a malformed task fails loudly and names the entity', () => {
  const broken = (from: string | RegExp, to: string) => () => parseBenchTasks(valid().replace(from, to));
  it('a brief with no prompt', () => { expect(broken('; kpred:prompt "A cup on a desk"', '')).toThrow(/bench:image-cup|image-cup.*kpred:prompt/); });
  it('a tier outside smoke|hard', () => { expect(broken('bench:tier "smoke" ; kpred:prompt', 'bench:tier "medium" ; kpred:prompt')).toThrow(/bench:tier must be smoke or hard, got "medium"/); });
  it('fewer than four checklist items', () => { expect(broken(/bench:image-cup--d a [^\n]*\n/, '')).toThrow(/needs at least 4 checklist items, found 3/); });
  it('a duplicate checklist id', () => { expect(broken('skos:notation "d"', 'skos:notation "a"')).toThrow(/checklist ids must be distinct/); });
  it('a non-numeric expectation', () => { expect(broken('bench:min-motion 0.01', 'bench:min-motion "fast"')).toThrow(/min-motion is not a number/); });
  it('an inverted depth-to-width range', () => { expect(broken('bench:depth-to-width-max 1.6', 'bench:depth-to-width-max 0.1')).toThrow(/range must satisfy/); });
  it('a source brief that does not exist', () => { expect(broken('bench:source-brief bench:image-cup ; kpred:prompt', 'bench:source-brief bench:image-ghost ; kpred:prompt')).toThrow(/image-ghost is not an image brief/); });
  it('a missing stage task', () => { expect(broken(/bench:Task-splat a [^\n]*\n/, '')).toThrow(/exactly one BenchTask for stage "splat"/); });
  it('seeds that differ between stages', () => { expect(broken('bench:stage "video" ; bench:seed 7 ; bench:seed 8', 'bench:stage "video" ; bench:seed 7 ; bench:seed 9')).toThrow(/same seeds/); });
  it('a graph with no bench tasks at all', () => { expect(() => parseBenchTasks(PREFIXES)).toThrow(/BenchTask/); });
  it('invalid Turtle', () => { expect(() => parseBenchTasks('bench:x a ;;;')).toThrow(); });
});

describe('the committed Testing graph', () => {
  const t = loadBenchTasks();
  it('is the file the runner reads', () => { expect(TESTING_GRAPH).toMatch(/static[\\/]docs-testing\.ttl$/); expect(readFileSync(TESTING_GRAPH, 'utf8')).toContain('bench:Task-image'); });
  it('keeps the original smoke answer key verbatim', () => {
    const lh = t.image.find((b) => b.slug === 'red-lighthouse')!;
    expect(lh.tier).toBe('smoke');
    expect(lh.prompt).toMatch(/^A tall lighthouse painted with red and white horizontal stripes/);
    expect(lh.checklist.map((c) => c.id)).toEqual(['lighthouse', 'red', 'one', 'sea', 'sky']);
    expect(lh.checklist[2].question).toBe('Is there exactly one lighthouse (not two or more)?');
    expect(t.seeds).toEqual([101, 202, 303]);
    expect(t.video).toHaveLength(4);
    expect(t.splat).toHaveLength(4);
  });
  it('gives every image brief a checklist of yes/no questions', () => {
    for (const b of t.image) for (const c of b.checklist) expect(c.question).toMatch(/\?$/);
  });
});
