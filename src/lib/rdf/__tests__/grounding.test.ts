/**
 * Passage grounding (kb:passage-grounding).
 *
 * Every extracted triple carries an `excerpt` — the "verbatim source sentence". The
 * prompt tells the model to copy it exactly. NOTHING EVER CHECKED THAT IT DID, so a
 * paraphrased or invented quote was stored and rendered to the user as provenance.
 *
 * For an app that sells itself on provenance and trust, a fabricated citation is the
 * worst failure available: the user checks the receipt, the receipt looks right, and it
 * is a forgery. These are the tests that would have caught it.
 */
import { describe, it, expect } from 'vitest';
import {
  verifyExcerpt,
  normalizeForGrounding,
  groundStatement,
  groundStatements,
  countUngrounded,
  UNGROUNDED_CONFIDENCE_PENALTY,
  type GroundableStatement,
} from '../grounding';

const SOURCE =
  'Marie Curie was born in Warsaw in 1867. She won two Nobel Prizes, in Physics and in Chemistry. ' +
  'She remains the only person to win in two different sciences.';

const st = (excerpt: string | undefined, confidence = 0.9): GroundableStatement => ({ excerpt, confidence });

describe('verifyExcerpt', () => {
  it('accepts a genuine verbatim quote', () => {
    expect(verifyExcerpt('Marie Curie was born in Warsaw in 1867.', SOURCE).verdict).toBe('grounded');
  });

  it('reports where in the source the quote was found', () => {
    const r = verifyExcerpt('She won two Nobel Prizes', SOURCE);
    expect(r.verdict).toBe('grounded');
    expect(r.index).toBeGreaterThan(0);
  });

  // ── THE BUG ───────────────────────────────────────────────────────────────
  it('REJECTS an invented quote — the source never said it', () => {
    expect(verifyExcerpt('Marie Curie was born in Paris in 1901.', SOURCE).verdict).toBe('ungrounded');
  });

  it('REJECTS a paraphrase, which is exactly what small models produce', () => {
    // Every word is plausible. None of this sentence is in the source.
    expect(verifyExcerpt('Curie was awarded two Nobel Prizes.', SOURCE).verdict).toBe('ungrounded');
  });

  it('rejects a quote that is subtly altered — one wrong number', () => {
    expect(verifyExcerpt('Marie Curie was born in Warsaw in 1876.', SOURCE).verdict).toBe('ungrounded');
  });

  // ── Must not cry wolf ─────────────────────────────────────────────────────
  it('forgives cosmetic differences a reasonable reader would ignore', () => {
    const source = 'The company’s revenue — up 12% — beat expectations.';

    // smart quotes and em-dashes swapped for ascii: same sentence, not a forgery
    expect(verifyExcerpt("The company's revenue - up 12% - beat expectations.", source).verdict).toBe('grounded');
    // wrapped across lines by the extractor
    expect(verifyExcerpt('The company’s revenue — up 12%\n— beat expectations.', source).verdict).toBe('grounded');
    // case
    expect(verifyExcerpt('THE COMPANY’S REVENUE — UP 12% — BEAT EXPECTATIONS.', source).verdict).toBe('grounded');
  });

  it('treats a missing excerpt as absent, not as a forgery', () => {
    expect(verifyExcerpt(undefined, SOURCE).verdict).toBe('absent');
    expect(verifyExcerpt('   ', SOURCE).verdict).toBe('absent');
  });

  it('does not accuse when there is no source text to check against', () => {
    // Silence is not evidence of forgery. We must not mark a citation fake merely
    // because we could not look at the source.
    expect(verifyExcerpt('anything at all', undefined).verdict).toBe('unverifiable');
  });
});

describe('normalizeForGrounding', () => {
  it('normalizes quotes, dashes, whitespace and case', () => {
    expect(normalizeForGrounding('  “Hello”  —  world’s \n best  ')).toBe('"hello" - world\'s best');
  });
});

describe('groundStatement', () => {
  it('marks a real quote as grounded and leaves it intact', () => {
    const r = groundStatement(st('She won two Nobel Prizes'), SOURCE);
    expect(r.grounded).toBe(true);
    expect(r.excerpt).toBe('She won two Nobel Prizes');
    expect(r.confidence).toBe(0.9); // untouched
  });

  it('DROPS a fabricated quote rather than showing it', () => {
    // The heart of it: we would rather show the user NO citation than a forged one.
    const r = groundStatement(st('Marie Curie invented the telephone.'), SOURCE);
    expect(r.grounded).toBe(false);
    expect(r.excerpt).toBeUndefined();
  });

  it('penalises confidence when the model fabricated its evidence', () => {
    // A model that invents its receipt has told us something real about its reliability
    // here. The fact may still be true, so we keep it — but a human should look.
    const r = groundStatement(st('Not in the source at all.', 0.95), SOURCE);
    expect(r.confidence).toBeCloseTo(0.95 * UNGROUNDED_CONFIDENCE_PENALTY, 5);
    expect(r.confidence).toBeLessThan(0.95);
  });

  it('keeps the statement — a bad citation is not proof the fact is wrong', () => {
    const r = groundStatement(st('paraphrased badly'), SOURCE);
    expect(r).toBeDefined();
    expect(r.grounded).toBe(false);
  });

  it('leaves statements alone when there is no source text', () => {
    const r = groundStatement(st('unchecked quote', 0.8), undefined);
    expect(r.excerpt).toBe('unchecked quote'); // not dropped
    expect(r.grounded).toBeUndefined();        // and not claimed as verified
    expect(r.confidence).toBe(0.8);
  });
});

describe('groundStatements / countUngrounded', () => {
  it('separates real citations from forged ones across a batch', () => {
    const batch = groundStatements(
      [
        st('Marie Curie was born in Warsaw in 1867.'), // real
        st('She won two Nobel Prizes'),                // real
        st('She was awarded a third Nobel in 1935.'),  // invented
        st(undefined),                                 // no claim
      ],
      SOURCE,
    );

    expect(batch.map((s) => s.grounded)).toEqual([true, true, false, undefined]);
    expect(countUngrounded(batch)).toBe(1);
    expect(batch[2].excerpt).toBeUndefined(); // the forgery is gone
  });
});
