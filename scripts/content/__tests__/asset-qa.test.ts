// @vitest-environment node
/**
 * The asset QA loop (F281): PDF and SVG judges, the vision review parser, the fix loop's decisions,
 * and the receipt rule that lets a reseeded output validate only when its QA record names the seed.
 * Synthetic inputs only; no PDF tools, GPU or model are needed.
 */
import { describe, expect, it } from 'vitest';
import { countWordsOutside, judgePdf, judgeSvgSource, parsePdfFonts, parsePdfPageSizes, type PdfStats } from '../asset-checks';
import { mergeReviews, parseReview, reviewPrompt, DEFECTS } from '../asset-review';
import { attemptRecord, describeQa, improve, isClean, qaBudget, shouldRetry, summarize } from '../asset-qa';
import { validateReceipt, type GenerationRequest } from '../../../src/lib/generation/protocol';

const goodPdf: PdfStats = { pages: 1, pageSizesPt: [[595.28, 841.89]], fontsNotEmbedded: [], fontCount: 1, text: 'Harbor Reading Circle\nJoin us every Thursday', wordsOutside: 0, pageSpread: [15] };
const A4: [number, number] = [595, 842];

describe('judgePdf', () => {
  it('passes a good page', () => {
    expect(judgePdf(goodPdf, { pages: 1, pageSizePt: A4, text: ['harbor reading   circle'] }).pass).toBe(true);
  });
  it.each([
    ['a blank page', { pageSpread: [15, 0.2], pages: 2, pageSizesPt: [[595, 842], [595, 842]] as [number, number][] }, /page 2 is blank/],
    ['a missing phrase', {}, /expected text missing: "partner name"/],
    ['an unembedded font', { fontsNotEmbedded: ['Helvetica'] }, /fonts not embedded.*Helvetica/],
    ['the wrong page size', { pageSizesPt: [[446, 632]] as [number, number][] }, /page 1 is 446x632 pt, expected 595x842/],
    ['text off the page', { wordsOutside: 2 }, /2 word\(s\) run off the page/],
  ])('fails %s with its reason', (_n, over, re) => {
    const c = judgePdf({ ...goodPdf, ...over }, { pageSizePt: A4, text: _n === 'a missing phrase' ? ['partner name'] : [] });
    expect(c.pass).toBe(false);
    expect(c.problems.join(' | ')).toMatch(re);
  });
  it('notes, without failing, a PDF with no extractable text', () => {
    const c = judgePdf({ ...goodPdf, text: '  ' });
    expect(c.pass).toBe(true);
    expect(c.notes[0]).toMatch(/no extractable text/);
  });
});

describe('poppler output parsers', () => {
  it('reads per-page sizes', () => {
    expect(parsePdfPageSizes('Page    1 size: 595.276 x 841.89 pts (A4)\nPage    2 size: 612 x 792 pts (letter)\n')).toEqual([[595.276, 841.89], [612, 792]]);
  });
  it('finds fonts whose emb column is no', () => {
    const t = ['name type encoding emb sub uni object ID', '---- ---- ---- --- --- --- ---------',
      'IAANEJ+DejaVuSans                    TrueType          WinAnsi          yes yes yes      7  0',
      'Helvetica                            Type 1            Custom           no  no  no       9  0'].join('\n');
    expect(parsePdfFonts(t)).toEqual({ count: 2, notEmbedded: ['Helvetica'] });
  });
  it('counts words whose box leaves the page', () => {
    const x = '<page width="595.28" height="841.89"><word xMin="60" yMin="90" xMax="300" yMax="126">in</word><word xMin="560" yMin="160" xMax="640.5" yMax="185">out</word></page>';
    expect(countWordsOutside(x)).toBe(1);
  });
});

describe('judgeSvgSource', () => {
  it('passes a sized SVG', () => expect(judgeSvgSource('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>').pass).toBe(true));
  it('fails script, external references and an undefined size', () => {
    expect(judgeSvgSource('<svg viewBox="0 0 1 1"><script>x()</script></svg>').problems.join()).toMatch(/script/);
    expect(judgeSvgSource('<svg viewBox="0 0 1 1"><image href="https://example.com/a.png"/></svg>').problems.join()).toMatch(/external/);
    expect(judgeSvgSource('<svg><rect/></svg>').problems.join()).toMatch(/size is undefined/);
  });
});

describe('parseReview', () => {
  it('keeps only listed defects, adds off-intent, clamps the score', () => {
    const r = parseReview('Sure: {"matches_intent": false, "defects": ["garbled-text", "ugly"], "score": 9, "note": "x"}');
    expect(r).toMatchObject({ valid: true, defects: ['garbled-text', 'off-intent'], score: 5 });
  });
  it('marks prose or a missing score invalid, never clean', () => {
    expect(parseReview('Looks great!').valid).toBe(false);
    expect(parseReview('{"defects": []}').valid).toBe(false);
  });
  it('merges pages: every defect, the lowest score; one unreadable page makes the whole unreadable', () => {
    const a = parseReview('{"defects": ["text-overlap"], "score": 4}');
    const b = parseReview('{"defects": [], "score": 2}');
    expect(mergeReviews([a, b])).toMatchObject({ valid: true, defects: ['text-overlap'], score: 2 });
    expect(mergeReviews([a, parseReview('no')])?.valid).toBe(false);
  });
  it('the prompt names every defect and only those', () => {
    const p = reviewPrompt('page', 'A flyer');
    for (const d of Object.keys(DEFECTS)) expect(p).toContain(`- ${d}:`);
  });
});

const ok = { pass: true, problems: [], notes: [], measured: {} };
const flat = { pass: false, problems: ['flat image'], notes: [], measured: {} };
const review = (defects: string[], score: number) => parseReview(JSON.stringify({ defects, score }));

describe('fix loop decisions', () => {
  it('budget comes from RECKONS_QA_ATTEMPTS, clamped', () => {
    expect([qaBudget(undefined), qaBudget('1'), qaBudget('99'), qaBudget('0'), qaBudget('x')]).toEqual([3, 1, 6, 3, 3]);
  });
  it('retries a failed check or a named defect, not an unreviewed or unreadable pass, never past the budget', () => {
    expect(shouldRetry(attemptRecord(1, flat, undefined), 0, 3)).toBe(true);
    expect(shouldRetry(attemptRecord(1, ok, review(['garbled-text'], 4)), 0, 3)).toBe(true);
    expect(shouldRetry(attemptRecord(1, ok, review([], 2)), 0, 3)).toBe(true);
    expect(shouldRetry(attemptRecord(1, ok, undefined), 0, 3)).toBe(false);
    expect(shouldRetry(attemptRecord(1, ok, parseReview('??')), 0, 3)).toBe(false);
    expect(shouldRetry(attemptRecord(1, flat, undefined), 2, 3)).toBe(false);
  });
  it('clean needs a readable review with nothing found', () => {
    expect(isClean(attemptRecord(1, ok, review([], 4)))).toBe(true);
    expect(isClean(attemptRecord(1, ok, undefined))).toBe(false);
  });
  it('a draft is never a failed attempt when one passed, and the summary says what was fixed', () => {
    const qa = summarize([attemptRecord(5, flat, undefined), attemptRecord(6, ok, review(['heavy-artifacts'], 3)), attemptRecord(7, flat, undefined)], 3, 'qwen2.5vl:7b');
    expect(qa).toMatchObject({ chosen: 1, verdict: 'draft-with-notes', fixed: ['flat image'], open: ['heavy-artifacts'] });
    expect(describeQa(qa)).toBe('Draft with notes (attempt 2 of 3). Fixed: flat image. Still open: heavy-artifacts.');
  });
  it('no passing attempt = failed, no draft', () => {
    expect(summarize([attemptRecord(1, flat, undefined)], 1).verdict).toBe('failed');
  });
});

describe('improve', () => {
  it('tries seed, seed+1 … stops at the first clean attempt, reviews only passing files', async () => {
    const reviewed: string[] = [];
    const { qa, best } = await improve({
      seed: 10, budget: 3,
      attempt: async (seed) => ({ file: `f${seed}`, check: seed === 10 ? flat : ok, payload: seed }),
      review: async (file) => { reviewed.push(file); return review([], 5); },
    });
    expect(qa.attempts.map((a) => a.seed)).toEqual([10, 11]);
    expect(reviewed).toEqual(['f11']);
    expect([qa.verdict, best.payload]).toEqual(['clean', 11]);
  });
  it('stops when cancelled and lets a tool error through instead of reseeding it', async () => {
    let n = 0;
    const r = await improve({ seed: 1, budget: 3, cancelled: () => true, attempt: async () => { n++; return { file: 'f', check: flat, payload: 0 }; } });
    expect([n, r.qa.verdict]).toEqual([1, 'failed']);
    await expect(improve({ seed: 1, budget: 3, attempt: async () => { throw new Error('sd-cli missing'); } })).rejects.toThrow('sd-cli missing');
  });
});

describe('validateReceipt with a reseeded output', () => {
  const request: GenerationRequest = { version: 1, id: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', spaceId: 's', stage: 'image', prompt: 'p', seed: 42 };
  const receipt = (seed: number, qa?: unknown) => ({
    stage: 'image', tool: { name: 't', version: '1', license: 'MIT' }, models: [{ file: 'm', sha256: 'a'.repeat(64), license: 'MIT' }],
    input: { prompt: 'p' }, output: { file: 'image.webp', sha256: 'b'.repeat(64), bytes: 10 }, check: { pass: true },
    settings: { seed }, ranAt: '2026-11-04T12:00:00Z', durationS: 1, ...(qa ? { qa } : {}),
  });
  const qa = (seeds: number[], chosen: number) => ({ version: 1, budget: 3, chosen, verdict: 'clean', fixed: [], open: [], attempts: seeds.map((seed) => ({ seed, pass: true, problems: [], notes: [], reviewed: false, defects: [] })) });
  it('accepts the requested seed, and a retry seed its QA record names as chosen', () => {
    expect(() => validateReceipt(receipt(42), request)).not.toThrow();
    expect(() => validateReceipt(receipt(43, qa([42, 43], 1)), request)).not.toThrow();
  });
  it('rejects an unexplained seed, a record that starts elsewhere, or a chosen attempt with another seed', () => {
    expect(() => validateReceipt(receipt(43), request)).toThrow();
    expect(() => validateReceipt(receipt(43, qa([41, 43], 1)), request)).toThrow();
    expect(() => validateReceipt(receipt(43, qa([42, 43], 0)), request)).toThrow();
  });
});
