import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  UX_DIMENSIONS,
  impressionPrompt,
  parseImpression,
  summarize,
  type UxDimension,
} from './vision-ux';

const WELL_FORMED = `
crowding: busy — the bottom nav, chips and headline all compete for the same band
hierarchy: competing — two buttons share the same visual weight
legibility: easy — body text is large with strong contrast on the dark background
balance: balanced — weight is spread evenly left to right
consistency: consistent — one type scale and one accent colour throughout
impression: A landing page introducing a knowledge-graph product
worst: the two call-to-action buttons look equally important
`;

describe('vision-ux dimension table', () => {
  it('every dimension cites a rubric entity and has a threshold inside its scale', () => {
    for (const d of UX_DIMENSIONS) {
      expect(d.cites, d.key).toMatch(/^kb:[a-z0-9-]+$/);
      expect(d.scale.length, d.key).toBeGreaterThan(1);
      expect(d.flagAt, d.key).toBeGreaterThan(0);
      expect(d.flagAt, d.key).toBeLessThan(d.scale.length);
      // Labels must be single tokens: the parser normalises whitespace to '-',
      // so a two-word label would only ever match by accident.
      for (const label of d.scale) expect(label, `${d.key}/${label}`).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it('keys are unique — a duplicate would make one dimension shadow the other', () => {
    const keys = UX_DIMENSIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the prompt asks for exactly the dimensions the parser reads', () => {
    const p = impressionPrompt();
    for (const d of UX_DIMENSIONS) {
      expect(p).toContain(d.key);
      for (const label of d.scale) expect(p).toContain(label);
    }
    expect(p).toContain('impression:');
    expect(p).toContain('worst:');
  });
});

describe('parseImpression', () => {
  it('reads a well-formed completion', () => {
    const imp = parseImpression(WELL_FORMED);
    expect(imp.parsed).toBe(UX_DIMENSIONS.length);
    const crowding = imp.readings.find((r) => r.key === 'crowding')!;
    expect(crowding.label).toBe('busy');
    expect(crowding.rank).toBe(2);
    expect(crowding.reason).toContain('bottom nav');
    expect(imp.impression).toContain('knowledge-graph');
    expect(imp.worst).toContain('equally important');
  });

  it('flags at the threshold and not before', () => {
    const imp = parseImpression(WELL_FORMED);
    const flaggedKeys = imp.flagged.map((r) => r.key).sort();
    expect(flaggedKeys).toEqual(['crowding', 'hierarchy']);
    expect(imp.readings.find((r) => r.key === 'legibility')!.flagged).toBe(false);
    expect(imp.readings.find((r) => r.key === 'balance')!.flagged).toBe(false);
  });

  it('sorts flagged readings worst first', () => {
    const imp = parseImpression(`
crowding: crowded — no whitespace anywhere
hierarchy: competing — two equal buttons
`);
    expect(imp.flagged.map((r) => r.key)).toEqual(['crowding', 'hierarchy']);
    expect(imp.flagged[0].rank).toBeGreaterThan(imp.flagged[1].rank!);
  });

  it('does NOT coerce an out-of-scale answer to the nearest label', () => {
    const imp = parseImpression('crowding: quite busy actually — lots going on');
    const crowding = imp.readings.find((r) => r.key === 'crowding')!;
    expect(crowding.label).toBeNull();
    expect(crowding.rank).toBeNull();
    // An unanswered question is not a finding.
    expect(crowding.flagged).toBe(false);
    expect(imp.parsed).toBe(0);
  });

  it('never flags a dimension the model did not answer', () => {
    const imp = parseImpression('impression: a page');
    expect(imp.flagged).toEqual([]);
    expect(imp.parsed).toBe(0);
    for (const r of imp.readings) expect(r.label).toBeNull();
  });

  it('tolerates bullets, bold and a plain hyphen separator', () => {
    const imp = parseImpression('- **crowding**: crowded - everything is stacked');
    const crowding = imp.readings.find((r) => r.key === 'crowding')!;
    expect(crowding.label).toBe('crowded');
    expect(crowding.reason).toBe('everything is stacked');
  });

  it('keeps a hyphenated scale label whole', () => {
    // Regression: the separator regex split on any hyphen, so `mostly-consistent`
    // parsed as `mostly` and was reported as an out-of-scale answer.
    const imp = parseImpression('consistency: mostly-consistent — one accent colour throughout');
    const c = imp.readings.find((r) => r.key === 'consistency')!;
    expect(c.label).toBe('mostly-consistent');
    expect(c.reason).toBe('one accent colour throughout');
  });

  it('keeps hyphenated words inside free-text prose', () => {
    const imp = parseImpression('impression: A landing page for a knowledge-graph product');
    expect(imp.impression).toBe('A landing page for a knowledge-graph product');
  });

  it('accepts a label with no reason attached', () => {
    const imp = parseImpression('crowding: airy');
    const crowding = imp.readings.find((r) => r.key === 'crowding')!;
    expect(crowding.label).toBe('airy');
    expect(crowding.reason).toBe('');
  });

  it('normalises case and internal spacing to match a scale label', () => {
    const imp = parseImpression('consistency: Mostly Consistent — one accent colour');
    expect(imp.readings.find((r) => r.key === 'consistency')!.label).toBe('mostly-consistent');
  });

  it('treats "worst: none" as no problem rather than a problem called none', () => {
    expect(parseImpression('worst: none').worst).toBe('');
    expect(parseImpression('worst: None — it reads well').worst).toBe('');
    expect(parseImpression('worst: the nav overlaps the title').worst).toBe('the nav overlaps the title');
  });

  it('carries the rubric citation onto every reading', () => {
    const imp = parseImpression(WELL_FORMED);
    for (const r of imp.readings) {
      expect(r.cites).toBe(UX_DIMENSIONS.find((d) => d.key === r.key)!.cites);
    }
  });

  it('works with a caller-supplied dimension set', () => {
    const dims: UxDimension[] = [
      { key: 'noise', ask: 'how noisy', scale: ['quiet', 'loud'], flagAt: 1, cites: 'kb:guideline-legibility' },
    ];
    const imp = parseImpression('noise: loud — too much', dims);
    expect(imp.readings).toHaveLength(1);
    expect(imp.flagged[0].label).toBe('loud');
  });
});

describe('summarize', () => {
  it('names the flagged readings and how much was readable', () => {
    expect(summarize(parseImpression(WELL_FORMED))).toBe('busy crowding · competing hierarchy · 5/5 read');
  });

  it('says so plainly when nothing is flagged', () => {
    expect(summarize(parseImpression('crowding: airy — plenty of room'))).toContain('nothing flagged');
  });
});

describe('uxImpression (transport)', () => {
  const OLD = process.env.OLLAMA_BASE_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = OLD;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends the impression prompt with the image and parses the reply', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.resetModules();
    const m = await import('./vision-ux');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ response: WELL_FORMED }) }));
    vi.stubGlobal('fetch', fetchMock);

    const imp = await m.uxImpression('ZmFrZQ==');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.images).toEqual(['ZmFrZQ==']);
    expect(body.prompt).toContain('crowding');
    expect(body.prompt).toContain('FIRST-TIME visitor');
    expect(imp.flagged.map((r) => r.key)).toEqual(['crowding', 'hierarchy']);
  });
});
