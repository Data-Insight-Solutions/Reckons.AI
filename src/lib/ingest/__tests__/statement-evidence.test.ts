import { describe, it, expect } from 'vitest';
import { deriveEvidence, evidenceNotice } from '../statement-evidence';

const para = (n: number) => `Paragraph ${n} says something distinct about topic ${n}. `.repeat(8).trim();
const text = Array.from({ length: 10 }, (_, i) => para(i + 1)).join('\n\n');
const opts = { size: 400, overlap: 50 };

describe('deriveEvidence', () => {
  it('anchors an exact excerpt to a passage with the span highlighted', () => {
    const excerpt = 'Paragraph 7 says something distinct about topic 7.';
    const e = deriveEvidence({ sourceTitle: 'Synthetic', excerpt, sourceText: text }, opts);
    expect(e.kind).toBe('anchored');
    if (e.kind !== 'anchored') return;
    expect(e.highlight).toBe(excerpt);
    expect(e.passageNumber).toBeGreaterThan(1);
    expect(e.passageCount).toBeGreaterThanOrEqual(e.passageNumber);
    expect(e.before + e.highlight + e.after).toContain(excerpt);
    expect(e.match).toBe('exact');
  });

  it('flags a whitespace-only mismatch as normalized', () => {
    const e = deriveEvidence({ sourceTitle: 'S', excerpt: 'Paragraph 2 says   something\ndistinct', sourceText: text }, opts);
    expect(e.kind === 'anchored' && e.match).toBe('normalized');
    expect(evidenceNotice(e)).toMatch(/spacing/);
  });

  it('says the text was not kept when there is no source text, and shows the excerpt alone', () => {
    const e = deriveEvidence({ sourceTitle: 'S', excerpt: 'a quote', sourceText: null });
    expect(e).toMatchObject({ kind: 'excerpt-only', reason: 'no-source-text', excerpt: 'a quote' });
    expect(evidenceNotice(e)).toMatch(/not kept/);
  });

  it('never guesses a span when the excerpt is not in the text', () => {
    const e = deriveEvidence({ sourceTitle: 'S', excerpt: 'completely absent sentence', sourceText: text }, opts);
    expect(e).toMatchObject({ kind: 'excerpt-only', reason: 'not-found' });
  });

  it('respects grounded=false without searching', () => {
    const e = deriveEvidence({ sourceTitle: 'S', excerpt: 'Paragraph 1 says', sourceText: text, grounded: false }, opts);
    expect(e).toMatchObject({ kind: 'excerpt-only', reason: 'not-in-source' });
  });

  it('reports no excerpt', () => {
    expect(deriveEvidence({ sourceTitle: 'S', excerpt: '  ', sourceText: text }).kind).toBe('none');
    expect(deriveEvidence({ sourceTitle: 'S', sourceText: text }).kind).toBe('none');
  });

  it('clamps a highlight that crosses a passage boundary', () => {
    const t = 'A'.repeat(150) + '. ' + 'B'.repeat(150) + '. ' + 'C'.repeat(150) + '.';
    const e = deriveEvidence({ sourceTitle: 'S', excerpt: t, sourceText: t }, { size: 200, overlap: 20 });
    expect(e.kind).toBe('anchored');
    if (e.kind !== 'anchored') return;
    expect(e.continuesInNext).toBe(true);
    expect(e.after).toBe('');
    expect(evidenceNotice(e)).toMatch(/next passage/);
  });
});
