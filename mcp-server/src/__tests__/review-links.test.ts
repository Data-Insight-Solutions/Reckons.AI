/**
 * Review links (F195) — hand a person a task, not a queue.
 *
 * The property under test is ORDERING BY CONSEQUENCE. A group whose acceptance removes a human
 * from a decision must lead, however small it is, and a large group of low-priority rows must not
 * push it down. Getting that backwards produces a link that looks helpful and buries the one
 * decision that mattered.
 */
import { describe, expect, it } from 'vitest';
import { readPendingRows, renderReviewLinks, reviewGroups, type PendingRow } from '../review-links.js';

const BASE = 'http://localhost:5173';
const row = (over: Partial<PendingRow> = {}): PendingRow =>
  ({ subject: 's', predicate: 'p', object: 'o', agent: 'offline:x', ...over });

describe('reviewGroups', () => {
  it('groups by the agent that proposed each row', () => {
    const g = reviewGroups([row({ agent: 'a' }), row({ agent: 'a' }), row({ agent: 'b' })], BASE);
    expect(g.map((x) => [x.agent, x.count])).toEqual([['a', 2], ['b', 1]]);
  });

  it('leads with a group that has HIGH rows, even when it is much smaller', () => {
    const g = reviewGroups([
      ...Array.from({ length: 300 }, () => row({ agent: 'bulk', priority: 'low' })),
      row({ agent: 'consequential', priority: 'high' }),
    ], BASE);
    expect(g[0].agent).toBe('consequential');
  });

  it('orders two high-priority groups by how many high rows each holds', () => {
    const g = reviewGroups([
      row({ agent: 'few', priority: 'high' }),
      row({ agent: 'many', priority: 'high' }),
      row({ agent: 'many', priority: 'high' }),
    ], BASE);
    expect(g.map((x) => x.agent)).toEqual(['many', 'few']);
  });

  it('falls back to size only when nothing is high priority', () => {
    const g = reviewGroups([
      row({ agent: 'small', priority: 'low' }),
      row({ agent: 'big', priority: 'low' }),
      row({ agent: 'big', priority: 'low' }),
    ], BASE);
    expect(g.map((x) => x.agent)).toEqual(['big', 'small']);
  });

  it('builds a link that filters to exactly that agent, URL-encoded', () => {
    // Agents name themselves with the model attached, so parentheses and colons must survive.
    const [g] = reviewGroups([row({ agent: 'offline:layer-classify (qwen3:32b)' })], BASE);
    expect(g.url).toContain('/review?tab=incoming&agent=');
    expect(g.url).toContain(encodeURIComponent('offline:layer-classify (qwen3:32b)'));
    expect(new URL(g.url).searchParams.get('agent')).toBe('offline:layer-classify (qwen3:32b)');
  });

  it('does not fabricate a filter for unattributed rows', () => {
    // There is nothing to filter by, and a link that silently shows everything would misrepresent
    // the size of the job.
    const [g] = reviewGroups([row({ agent: undefined }), row({ agent: '  ' })], BASE);
    expect(g.agent).toBe('(unattributed)');
    expect(g.count).toBe(2);
    expect(g.url).toBe(`${BASE}/review?tab=incoming`);
    expect(g.url).not.toContain('agent=');
  });

  it('tolerates a trailing slash on the base URL', () => {
    const [g] = reviewGroups([row()], 'http://localhost:5173/');
    expect(g.url.startsWith('http://localhost:5173/review')).toBe(true);
  });

  it('reports the latest addedAt in each group', () => {
    const [g] = reviewGroups([
      row({ addedAt: '2026-09-01T00:00:00Z' }),
      row({ addedAt: '2026-09-09T00:00:00Z' }),
    ], BASE);
    expect(g.latest).toBe('2026-09-09T00:00:00Z');
  });

  it('is empty for an empty queue', () => {
    expect(reviewGroups([], BASE)).toEqual([]);
  });
});

describe('readPendingRows', () => {
  it('returns nothing for a file that is not there, rather than throwing', () => {
    expect(readPendingRows('/nonexistent/queue.jsonl')).toEqual([]);
  });
});

describe('renderReviewLinks', () => {
  it('says plainly when there is nothing to review', () => {
    expect(renderReviewLinks([], 0)).toContain('empty');
  });

  it('flags the high-priority count so the reader knows why a group leads', () => {
    const g = reviewGroups([row({ agent: 'a', priority: 'high', note: 'this removes a human' })], BASE);
    const out = renderReviewLinks(g, 1);
    expect(out).toContain('1 HIGH');
    expect(out).toContain('this removes a human');
    expect(out).toContain('/review?tab=incoming&agent=');
  });
});
