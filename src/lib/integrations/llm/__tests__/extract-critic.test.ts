/**
 * THINKING MODE'S MERGE RULES — the half of a second pass that can actually be tested offline.
 *
 * Whether the critic FINDS more facts is a question for scripts/offline/extraction-score.ts against
 * the hand-checked corpus; it needs a model and it belongs in the harness. What belongs here is the
 * part that must hold regardless of what any model returns: that a second pass can only ever ADD.
 * A critic that quietly drops a first-pass fact is a regression sold as a refinement, and it would
 * be invisible in an accuracy score that only counts what was found.
 */
import { describe, it, expect } from 'vitest';
import { mergeCriticPass, tripleKey, renderKnownTriples, buildCriticUserPrompt } from '../extract-critic';
import type { ExtractedTriple } from '../extractor';
import { contextWindowFor } from '../providers';

const t = (subject: string, predicate: string, object: string): ExtractedTriple =>
  ({ subject, predicate, object }) as ExtractedTriple;

describe('tripleKey — loose enough to catch a restatement, strict enough to keep a new fact', () => {
  it('treats case, spacing and punctuation as noise', () => {
    expect(tripleKey(t('Lumenpath', 'is-a', 'Enterprise CAD'))).toBe(tripleKey(t('lumenpath', 'is_a', 'enterprise-cad')));
  });

  it('does NOT collapse two genuinely different facts about one subject', () => {
    // Northwind is both a systems integrator AND a technology consultant. A key that merged these
    // would silently delete the second classification, which is corpus expectation 02.6.
    expect(tripleKey(t('northwind', 'is-a', 'systems-integrator'))).not.toBe(
      tripleKey(t('northwind', 'is-a', 'technology-consultant')),
    );
  });
});

describe('mergeCriticPass', () => {
  const first = [t('lumenpath', 'is-a', 'enterprise-cad'), t('lumenpath', 'founded', '2014')];

  it('ADDS the new and keeps every original — the invariant of a second pass', () => {
    const r = mergeCriticPass(first, [t('lumenpath', 'headquartered-in', 'toronto')]);
    expect(r.added).toHaveLength(1);
    expect(r.merged).toHaveLength(3);
    // Every first-pass fact survives, in order.
    expect(r.merged.slice(0, 2)).toEqual(first);
  });

  it('discards a restatement of something already held', () => {
    const r = mergeCriticPass(first, [t('Lumenpath', 'is-a', 'Enterprise CAD')]);
    expect(r.added).toHaveLength(0);
    expect(r.duplicates).toBe(1);
    expect(r.merged).toHaveLength(2);
  });

  it('an empty critic response is valid and changes nothing', () => {
    // The prompt tells the critic that [] is a correct answer. If that ever became an error path,
    // a model would learn to invent work to avoid it.
    const r = mergeCriticPass(first, []);
    expect(r.merged).toEqual(first);
    expect(r.added).toHaveLength(0);
  });

  it('drops malformed critic rows rather than passing them downstream', () => {
    const r = mergeCriticPass(first, [t('', 'is-a', 'thing'), t('x', '', 'y'), t('x', 'p', '')]);
    expect(r.added).toHaveLength(0);
    expect(r.merged).toEqual(first);
  });

  it('CANNOT delete a first-pass fact, even when the critic returns nothing but noise', () => {
    const r = mergeCriticPass(first, [t('', '', '')]);
    expect(r.merged).toHaveLength(2);
  });

  it('de-duplicates within the critic response itself', () => {
    const r = mergeCriticPass(first, [
      t('lumenpath', 'headquartered-in', 'toronto'),
      t('Lumenpath', 'headquartered_in', 'Toronto'),
    ]);
    expect(r.added).toHaveLength(1);
    expect(r.duplicates).toBe(1);
  });
});

describe('the critic prompt', () => {
  it('lists what is already held, so the critic can compare rather than re-extract', () => {
    const rendered = renderKnownTriples([t('lumenpath', 'is-a', 'enterprise-cad')]);
    expect(rendered).toContain('lumenpath');
    expect(rendered).toContain('enterprise-cad');
  });

  it('says plainly when the first pass found nothing', () => {
    expect(renderKnownTriples([])).toContain('nothing was extracted');
  });

  it('caps the list and says how many were withheld, rather than truncating silently', () => {
    const many = Array.from({ length: 150 }, (_, i) => t(`s${i}`, 'p', 'o'));
    const rendered = renderKnownTriples(many);
    expect(rendered).toContain('and 30 more');
    expect(rendered).toContain('do not re-emit');
  });

  it('carries the source text and the instruction not to repeat', () => {
    const p = buildCriticUserPrompt('Lumenpath was founded in 2014.', 'note', [t('lumenpath', 'is-a', 'cad')]);
    expect(p).toContain('Lumenpath was founded in 2014.');
    expect(p).toContain('do NOT repeat');
  });
});

/*
 * Context sizing lives with the extraction tests because it is an EXTRACTION failure when it goes
 * wrong, not a networking one. Measured 2026-09-04: qwen3:32b ran at 100% CPU with both 3090s idle
 * purely because a 32K context pushed a 20GB model past a 24GB card.
 */
describe('contextWindowFor — the fix for a silent 20x slowdown', () => {
  it('gives a dictated note a small window instead of the server-wide 32K', () => {
    // corpus 01 is ~122 chars; a 32K window for that is what put a 32B model on the CPU.
    expect(contextWindowFor(122 + 1200, 2048)).toBeLessThanOrEqual(8192);
  });

  it('grows for a real document rather than truncating it', () => {
    // 12,000 chars is exactly what buildExtractionUserPrompt slices to, so this is the real ceiling
    // of a single-pass extraction — a window that truncated here would silently lose facts and look
    // like the model getting worse.
    expect(contextWindowFor(12_000 + 2_000, 4096)).toBeGreaterThanOrEqual(8192);
  });

  it('never returns less than a 4K floor', () => {
    expect(contextWindowFor(0, 0)).toBe(4096);
    expect(contextWindowFor(10, 10)).toBe(4096);
  });

  it('is monotonic — more prompt never buys a smaller window', () => {
    const sizes = [500, 5_000, 12_000, 40_000].map((c) => contextWindowFor(c, 2048));
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });
});
