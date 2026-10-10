import { describe, expect, it } from 'vitest';
import { PANEL_WORDS, ambiguousIn, standardBatch } from '../queue';

const panelJobs = (ambiguous: (w: string) => boolean) =>
  standardBatch('/r', 'tsx', [], ambiguous).map((j) => j.name).filter((n) => n.startsWith('term-senses:'));

describe('standard batch: term-senses panels', () => {
  it('seeds only words the graph gives two or more meanings', () => {
    // 2026-10-09: space, source, set and statement were seeded with fewer and each run failed
    expect(panelJobs((w) => w === 'node' || w === 'graph')).toEqual(['term-senses:node', 'term-senses:graph']);
    expect(panelJobs(() => true)).toHaveLength(PANEL_WORDS.length);
  });
  it('seeds none when the terminology graph cannot be read', () => {
    const ambiguous = ambiguousIn('/nonexistent-root');
    expect(PANEL_WORDS.some(ambiguous)).toBe(false);
  });
  it('reads the real graph: node and graph are ambiguous today', () => {
    const ambiguous = ambiguousIn(process.cwd());
    expect(ambiguous('node')).toBe(true);
    expect(ambiguous('graph')).toBe(true);
  });
});
