#!/usr/bin/env npx tsx
/**
 * ASSET QA LOOP (F281): check, review, fix within a budget, and hand the best attempt to review.
 *
 *   npm run asset:qa -- <file> [--intent="what it should show"] [--text="phrase"]… [--pages=N] [--page-size=595x842] [--json]
 *
 * As a command it CHECKS any file (image, video, splat, PDF, SVG) and, with OLLAMA_BASE_URL set,
 * has the visual-testing vision model review it. It exits 1 when a deterministic check fails. It fixes
 * nothing, because a file from elsewhere has no inputs to change.
 *
 * As a library, improve() is the FIX LOOP the local generation runner uses (scripts/content/
 * generation-runner.ts). Each attempt is generated with the next seed (seed, seed+1, …) until one is
 * clean or the budget is spent. An attempt that fails a deterministic check is never reviewed (no
 * GPU time on a broken file) and never beats one that passed. The best attempt is the draft; the
 * record lists every attempt, what changed between the first and the chosen one, and what is still open.
 *
 * Reseeding is the only remedy for generated media: the prompt is the person's, so the loop never
 * rewrites it. Remedies for laid-out pages (smaller font, next layout candidate) belong to the F277
 * layout engine, which is not built yet (F281.4).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerationQa, GenerationQaAttempt } from '../../src/lib/generation/protocol.js';
import { checkAsset, type Check, type PdfExpect } from './asset-checks.js';
import { reviewAsset, type Review } from './asset-review.js';

export const DEFAULT_QA_ATTEMPTS = 3;
export const MAX_QA_ATTEMPTS = 6;

/** The attempt budget from RECKONS_QA_ATTEMPTS, clamped to 1..6. Pure. */
export function qaBudget(env: string | undefined = process.env.RECKONS_QA_ATTEMPTS): number {
  const n = Number(env);
  return Number.isInteger(n) && n >= 1 ? Math.min(MAX_QA_ATTEMPTS, n) : DEFAULT_QA_ATTEMPTS;
}

/** One attempt's check and review -> its record. Pure. */
export function attemptRecord(seed: number, check: Check, review: Review | undefined): GenerationQaAttempt {
  return {
    seed, pass: check.pass, problems: check.problems.slice(0, 8), notes: check.notes.slice(0, 8),
    reviewed: review !== undefined, ...(review && !review.valid ? { reviewUnreadable: true } : {}),
    defects: review?.valid ? review.defects : [], ...(review?.valid ? { score: review.score } : {}),
  };
}

/** Clean = passed the checks, and the review ran, was readable, found nothing and scored at least 3. Pure. */
export function isClean(a: GenerationQaAttempt): boolean {
  return a.pass && a.reviewed && !a.reviewUnreadable && a.defects.length === 0 && (a.score ?? 0) >= 3;
}

/**
 * Is another attempt worth it? Not when the budget is spent; yes when the checks failed or the review
 * named a defect or scored under 3. A review that was not run or not readable is no reason to spend
 * more GPU: that is the model's failure, not the asset's. Pure.
 */
export function shouldRetry(a: GenerationQaAttempt, index: number, budget: number): boolean {
  if (index + 1 >= budget) return false;
  if (!a.pass) return true;
  if (!a.reviewed || a.reviewUnreadable) return false;
  return a.defects.length > 0 || (a.score ?? 0) < 3;
}

/** Sort key, larger is better: passed, then fewer defects, then higher score, then the earlier attempt. Pure. */
const key = (a: GenerationQaAttempt, i: number): number[] => [a.pass ? 1 : 0, -a.defects.length, a.score ?? 0, -i];
function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The attempts -> the QA record: which one is the draft, its verdict, what was fixed and what is open. Pure. */
export function summarize(attempts: GenerationQaAttempt[], budget: number, reviewModel?: string): GenerationQa {
  let chosen = 0;
  attempts.forEach((a, i) => { if (better(key(a, i), key(attempts[chosen], chosen))) chosen = i; });
  const best = attempts[chosen];
  const first = attempts[0];
  const issues = (a: GenerationQaAttempt) => [...a.problems, ...a.defects];
  const open = [...issues(best)];
  if (best.pass && !best.reviewed) open.push('visual review not run');
  if (best.reviewUnreadable) open.push('visual review answer unreadable');
  if (best.pass && best.reviewed && !best.reviewUnreadable && (best.score ?? 0) < 3 && !best.defects.length) open.push(`visual review score ${best.score} of 5`);
  const fixed = chosen === 0 ? [] : issues(first).filter((x) => !issues(best).includes(x));
  const verdict: GenerationQa['verdict'] = !best.pass ? 'failed' : isClean(best) ? 'clean' : 'draft-with-notes';
  return { version: 1, budget, attempts, chosen, verdict, fixed, open, ...(reviewModel ? { reviewModel } : {}) };
}

export interface AttemptResult<T> { file: string; check: Check; payload: T }

/**
 * The fix loop. `attempt(seed, index)` generates one candidate; `review(file)` is optional advice.
 * Stops early when an attempt is clean or `cancelled()` turns true. A thrown error (the tool itself
 * failed) is not reseeded: it propagates, so a broken install fails once instead of N times.
 */
export async function improve<T>(o: {
  seed: number; budget: number;
  attempt: (seed: number, index: number) => Promise<AttemptResult<T>>;
  review?: (file: string) => Promise<Review | undefined>;
  cancelled?: () => boolean;
}): Promise<{ qa: GenerationQa; best: AttemptResult<T> }> {
  const results: AttemptResult<T>[] = [];
  const records: GenerationQaAttempt[] = [];
  let reviewModel: string | undefined;
  for (let i = 0; i < o.budget; i++) {
    if (i > 0 && o.cancelled?.()) break;
    const seed = o.seed + i;
    const r = await o.attempt(seed, i);
    const review = r.check.pass && o.review ? await o.review(r.file) : undefined;
    if (review) reviewModel = review.model;
    results.push(r);
    records.push(attemptRecord(seed, r.check, review));
    if (!shouldRetry(records[i], i, o.budget)) break;
  }
  const qa = summarize(records, o.budget, reviewModel);
  return { qa, best: results[qa.chosen] };
}

/** One sentence for a person: the verdict, how many attempts, what was fixed and what is open. Pure. */
export function describeQa(qa: GenerationQa): string {
  const n = qa.attempts.length;
  const tries = n === 1 ? 'first attempt' : `attempt ${qa.chosen + 1} of ${n}`;
  const fixed = qa.fixed.length ? ` Fixed: ${qa.fixed.join('; ')}.` : '';
  const open = qa.open.length ? ` Still open: ${qa.open.join('; ')}.` : '';
  const head = qa.verdict === 'clean' ? `Clean (${tries}).` : qa.verdict === 'failed' ? `Failed every check (${n} attempt${n === 1 ? '' : 's'}); no draft.` : `Draft with notes (${tries}).`;
  return `${head}${fixed}${open}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const val = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  if (!file) { console.error('Usage: npm run asset:qa -- <file> [--intent="…"] [--text="phrase"]… [--pages=N] [--page-size=WxH] [--json]'); process.exit(2); }
  const expect: PdfExpect = {};
  const text = args.filter((a) => a.startsWith('--text=')).map((a) => a.slice(7));
  if (text.length) expect.text = text;
  if (val('pages')) expect.pages = Number(val('pages'));
  const size = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(val('page-size') ?? '');
  if (size) expect.pageSizePt = [Number(size[1]), Number(size[2])];
  const check = await checkAsset(file, expect);
  const intent = val('intent');
  const review = check.pass && intent ? await reviewAsset(file, intent) : undefined;
  const qa = summarize([attemptRecord(0, check, review)], 1, review?.model);
  if (args.includes('--json')) console.log(JSON.stringify({ file, check, review, qa }, null, 2));
  else {
    console.log(`${path.basename(file)}: ${check.pass ? 'checks PASS' : 'checks FAIL'}`);
    for (const p of check.problems) console.log(`  problem: ${p}`);
    for (const n of check.notes) console.log(`  note: ${n}`);
    if (review?.valid) console.log(`  review (${review.model}): score ${review.score}/5${review.defects.length ? `, defects: ${review.defects.join(', ')}` : ', no defects named'}${review.note ? ` — ${review.note}` : ''}`);
    else if (review) console.log(`  review (${review.model}): answer unreadable`);
    else console.log(`  review: not run (${!check.pass ? 'the checks failed, so the file is not worth a look' : !intent ? 'pass --intent to review' : 'set OLLAMA_BASE_URL to opt in'})`);
    console.log(`  ${describeQa(qa)}`);
  }
  process.exit(check.pass ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
