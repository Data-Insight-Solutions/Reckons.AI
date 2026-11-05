/**
 * F275.2 — the narration plan for a demo: one audio clip per narrated step.
 *
 * PRECEDENCE, per step: Matt's own recording (<overrideDir>/<workflow>/<step>.wav) > a cached
 * synthesis (<cacheDir>/<cacheKey>.mp3) > a new synthesis, which is then cached. So a re-render
 * pays only for lines that changed, and a recorded line always wins.
 *
 * PURE: synthesis, probing and file access are injected (scripts/demo/render.ts supplies the real
 * ones), so this runs in unit tests with no network and no ffprobe.
 *
 * Voice strings are PROVIDER-QUALIFIED and opaque here (e.g. "hume:<id>"): the key hashes the whole
 * string, so a clip from one provider can never be served for another. Hume's TTS ends 2026-11-13
 * (kb:int-hume); a line cached before then keeps rendering after it.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type NarratedStep = { id: string; narration: string | null };
export type ClipSource = 'recorded' | 'cache' | 'synthesized';

export interface NarrationDeps {
  /** Matt's recordings: <overrideDir>/<workflowId>/<stepId>.wav */
  overrideDir: string;
  /** Synthesis cache: <cacheDir>/<cacheKey>.mp3 */
  cacheDir: string;
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  /** The caller's implementation creates parent directories. */
  writeFile(path: string, bytes: Uint8Array): void;
  /** MP3 bytes; throws on failure. */
  synth(text: string, voice: string): Promise<Uint8Array>;
  probeDurationMs(path: string): Promise<number>;
}

export type PlannedClip = {
  stepId: string;
  path: string;
  source: ClipSource;
  /** The provider-qualified voice for cache/synthesized clips; the literal 'recorded' for Matt's own. */
  voice: string;
  durationMs: number;
  /** SHA-256 hex of the clip file's bytes. */
  sha256: string;
};

/** A step with no narration still shows for this long. */
export const MIN_HOLD_MS = 2500;
/** Breathing room after a line ends, before the next step starts. */
export const PAD_MS = 600;

export function cacheKey(voice: string, text: string): string {
  return createHash('sha256').update(`${voice}\n${text.trim()}`).digest('hex');
}

export function holdMs(narrationMs: number | null): number {
  if (narrationMs === null) return MIN_HOLD_MS;
  return Math.max(MIN_HOLD_MS, narrationMs + PAD_MS);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function planNarration(
  workflowId: string,
  steps: NarratedStep[],
  voice: string,
  deps: NarrationDeps,
): Promise<{ clips: PlannedClip[]; silent: string[] }> {
  const clips: PlannedClip[] = [];
  const silent: string[] = [];
  for (const step of steps) {
    const text = step.narration?.trim() ?? '';
    if (!text) { silent.push(step.id); continue; }

    const recording = join(deps.overrideDir, workflowId, `${step.id}.wav`);
    let path: string;
    let source: ClipSource;
    let clipVoice = voice;
    if (deps.exists(recording)) {
      path = recording; source = 'recorded'; clipVoice = 'recorded';
    } else {
      path = join(deps.cacheDir, `${cacheKey(voice, text)}.mp3`);
      if (deps.exists(path)) {
        source = 'cache';
      } else {
        let bytes: Uint8Array;
        try {
          bytes = await deps.synth(text, voice);
        } catch (e) {
          throw new Error(`narration for step "${step.id}" failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        deps.writeFile(path, bytes);
        source = 'synthesized';
      }
    }
    clips.push({
      stepId: step.id,
      path,
      source,
      voice: clipVoice,
      durationMs: await deps.probeDurationMs(path),
      sha256: sha256(deps.readFile(path)),
    });
  }
  return { clips, silent };
}
