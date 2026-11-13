/**
 * VISUAL REVIEW of a generated asset (F281.2): the visual-testing vision model, pointed at what the
 * generators make instead of at the app's screens.
 *
 * It reuses tests/visual/vision-vlm.ts (qwen2.5vl:7b, the VLM gate bench winner, opt-in through
 * OLLAMA_BASE_URL). The model looks at a picture of the asset and names defects from a FIXED list;
 * it never edits anything. Its verdict is ADVICE: the deterministic checks in asset-checks.ts are the
 * gate, and the fix loop (asset-qa.ts) only uses the defects to decide whether another attempt is
 * worth its GPU time.
 *
 * WEAKNESSES, said out loud:
 *  - A 7B vision model misses small defects and sometimes names ones that are not there. It has
 *    not been benched on generated assets yet, only on app screenshots (npm run bench:vlm).
 *  - A video is judged by one middle frame and a PDF by its first two pages.
 *  - A splat has no picture to look at here, so it gets no visual review.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { hasOllamaVlm, reviewImageVLM, unloadVlm, VLM_MODEL } from '../../tests/visual/vision-vlm.js';
import { renderPdfPages, renderSvg } from './asset-checks.js';

export const DEFECTS = {
  'garbled-text': 'letters or words that are malformed or unreadable',
  'deformed-subject': 'distorted faces, hands, limbs or objects',
  'heavy-artifacts': 'noise, smears, banding or tiling that spoil the picture',
  'cropped-subject': 'the main subject or the content is cut off by the edge',
  'off-intent': 'it does not show what was intended',
  'blank-or-placeholder': 'empty, a flat color, or placeholder content',
  'text-overlap': 'text overlaps other text, or a busy part of the picture, so it is hard to read',
  'low-contrast-text': 'text too faint against its background',
} as const;
export type Defect = keyof typeof DEFECTS;
export type ReviewKind = 'image' | 'page' | 'frame';

export type Review =
  | { valid: true; defects: Defect[]; score: number; note: string; model: string }
  | { valid: false; raw: string; model: string };

const NOUN: Record<ReviewKind, string> = { image: 'generated image', page: 'page of a generated document', frame: 'frame from a generated video' };

/** The review prompt. The defect list is the only vocabulary the answer may use. Pure. */
export function reviewPrompt(kind: ReviewKind, intent: string): string {
  const list = Object.entries(DEFECTS).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return [
    `You are checking a ${NOUN[kind]} before a person sees it.`,
    `What was intended: "${intent.replace(/"/g, "'").slice(0, 600)}"`,
    'Reply with JSON only, no other text:',
    '{"matches_intent": true or false, "defects": [names], "score": 1 to 5, "note": "one sentence"}',
    'Use only these defect names, and only for what you can actually see:',
    list,
    'Score 5 means ready to use and 1 means unusable. An empty defects list means you saw none.',
  ].join('\n');
}

/**
 * The model's answer -> a review. Only listed defects are kept; matches_intent false adds off-intent;
 * the score is clamped to 1..5. An answer with no parseable JSON is INVALID, never clean. Pure.
 */
export function parseReview(raw: string, model = VLM_MODEL): Review {
  const block = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!block) return { valid: false, raw: raw.slice(0, 300), model };
  let j: { matches_intent?: unknown; defects?: unknown; score?: unknown; note?: unknown };
  try { j = JSON.parse(block); } catch { return { valid: false, raw: raw.slice(0, 300), model }; }
  const named = Array.isArray(j.defects) ? j.defects.filter((d): d is Defect => typeof d === 'string' && d in DEFECTS) : [];
  if (j.matches_intent === false && !named.includes('off-intent')) named.push('off-intent');
  const n = Number(j.score);
  if (!Number.isFinite(n)) return { valid: false, raw: raw.slice(0, 300), model };
  const score = Math.min(5, Math.max(1, Math.round(n)));
  return { valid: true, defects: [...new Set(named)], score, note: typeof j.note === 'string' ? j.note.slice(0, 300) : '', model };
}

/** Several pictures of one asset (a PDF's pages) -> one review: every defect named, the lowest score. Pure. */
export function mergeReviews(reviews: Review[]): Review | undefined {
  if (!reviews.length) return undefined;
  const ok = reviews.filter((r): r is Extract<Review, { valid: true }> => r.valid);
  if (ok.length < reviews.length) return reviews.find((r) => !r.valid);
  return { valid: true, defects: [...new Set(ok.flatMap((r) => r.defects))], score: Math.min(...ok.map((r) => r.score)), note: ok.map((r) => r.note).filter(Boolean).join(' '), model: ok[0].model };
}

const png = (buf: Buffer | string): Promise<Buffer> =>
  sharp(buf).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).png().toBuffer();

/** Pictures the model can look at, by file type: one for an image, SVG or video, up to two for a PDF, none for a splat. */
export async function picturesOf(file: string): Promise<{ kind: ReviewKind; pngs: Buffer[] }> {
  if (/\.(png|webp|jpe?g)$/i.test(file)) return { kind: 'image', pngs: [await png(file)] };
  if (/\.svg$/i.test(file)) return { kind: 'page', pngs: [await png(await renderSvg(file, 768))] };
  if (/\.pdf$/i.test(file)) {
    const pages = await renderPdfPages(file, 72, 2);
    try { return { kind: 'page', pngs: await Promise.all(pages.map((p) => png(readFileSync(p)))) }; }
    finally { if (pages.length) rmSync(join(pages[0], '..'), { recursive: true, force: true }); }
  }
  if (/\.(webm|mp4)$/i.test(file)) {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const mid = Math.max(0, Number(probe.trim()) / 2 || 0);
    const frame = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(mid), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 64 << 20 });
    return { kind: 'frame', pngs: [await png(frame)] };
  }
  return { kind: 'image', pngs: [] };
}

/**
 * Reviews a file against its intent with the local vision model, then unloads it so the next
 * generation gets the GPU back. undefined = not reviewed (no OLLAMA_BASE_URL, or nothing to look at);
 * the report says so rather than counting it as clean.
 */
export async function reviewAsset(file: string, intent: string, model = VLM_MODEL): Promise<Review | undefined> {
  if (!hasOllamaVlm()) return undefined;
  const { kind, pngs } = await picturesOf(file);
  if (!pngs.length) return undefined;
  const out: Review[] = [];
  try {
    for (const p of pngs) {
      try { out.push(parseReview(await reviewImageVLM(p.toString('base64'), reviewPrompt(kind, intent), model), model)); }
      catch (e) { out.push({ valid: false, raw: `review call failed: ${(e as Error).message}`.slice(0, 300), model }); }
    }
  } finally { await unloadVlm(model).catch(() => undefined); }
  return mergeReviews(out);
}
