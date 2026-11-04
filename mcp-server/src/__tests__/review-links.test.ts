/**
 * Review links (F195) — hand a person a task, not a queue.
 *
 * The property under test is ORDERING BY CONSEQUENCE. A group whose acceptance removes a human
 * from a decision must lead, however small it is, and a large group of low-priority rows must not
 * push it down. Getting that backwards produces a link that looks helpful and buries the one
 * decision that mattered.
 */
import { describe, expect, it } from 'vitest';
import { readPendingRows, renderReviewLinks, resolveBase, reviewGroups, type PendingRow } from '../review-links.js';

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

describe('producer runs and graph-aware links (2026-10-28)', () => {
  const day1 = '2026-10-27T19:47:40.894Z', day2 = '2026-10-28T01:00:00.000Z';

  it('splits one agent into separate groups per graph', () => {
    const g = reviewGroups([row({ agent: 'a', kb: 'roadmap' }), row({ agent: 'a', kb: 'codebase' })], BASE);
    expect(g.map((x) => x.kb).sort()).toEqual(['codebase', 'roadmap']);
  });

  it('splits one agent and graph into runs by UTC day when rows carry no run id', () => {
    const g = reviewGroups([
      row({ agent: 'a', kb: 'roadmap', addedAt: day1 }),
      row({ agent: 'a', kb: 'roadmap', addedAt: day1 }),
      row({ agent: 'a', kb: 'roadmap', addedAt: day2 }),
    ], BASE);
    expect(g.map((x) => [x.run, x.count]).sort()).toEqual([['2026-10-27', 2], ['2026-10-28', 1]]);
  });

  it('prefers an explicit run id over the day heuristic', () => {
    const g = reviewGroups([
      row({ agent: 'a', run: 'r1', addedAt: day1 }),
      row({ agent: 'a', runId: 'r1', addedAt: day2 }),
    ], BASE);
    expect(g).toHaveLength(1);
    expect(g[0].run).toBe('r1');
  });

  it('puts kb and agent in the link', () => {
    const [g] = reviewGroups([row({ agent: 'button-crawl', kb: 'roadmap' })], BASE);
    const u = new URL(g.url);
    expect(u.pathname).toBe('/review');
    expect(u.searchParams.get('kb')).toBe('roadmap');
    expect(u.searchParams.get('agent')).toBe('button-crawl');
  });

  it('says how many rows cannot be linked to an agent or a graph', () => {
    const out = renderReviewLinks(reviewGroups([row({ agent: undefined }), row({ agent: 'a' })], BASE), 2);
    expect(out).toContain('1 row(s) name no agent');
    expect(out).toContain('2 row(s) name no graph');
  });
});

describe('resolveBase', () => {
  it('takes the parameter, then RECKONS_APP_URL, then the dev server', () => {
    expect(resolveBase('https://x.test', { RECKONS_APP_URL: 'https://e.test' })).toBe('https://x.test');
    expect(resolveBase(undefined, { RECKONS_APP_URL: 'https://e.test' })).toBe('https://e.test');
    expect(resolveBase(undefined, {})).toBe('http://localhost:5173');
  });
});
