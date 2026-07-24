/**
 * Hume speech synthesis for STORY NARRATION (F5.1).
 *
 * Shelly's conversational voice already goes through Hume EVI (a live socket). Narration is a
 * different job: take a story step's text and speak it. This is the REST synthesis path, and it
 * reuses the EVI auth ladder (`planHumeAuth`) so a story shared with someone who has no Hume
 * account still narrates in the author's voice via the delegated token endpoint.
 *
 * FALLBACK IS PART OF THE CONTRACT. Every failure here throws with a readable message so the
 * caller can drop to the local Kokoro voice. A story that goes silent because a remote voice
 * failed is worse than one narrated in a different voice.
 *
 * NOT YET VERIFIED against the live Hume endpoint — that needs a real key. The response parsing
 * is deliberately permissive and every failure path is tested.
 */
import { fetchHumeTokenFromUrl, type HumeAuthPlan } from './token';

export const HUME_TTS_ENDPOINT = 'https://api.hume.ai/v0/tts';

/** A resolved credential for a single synthesis request. */
export type HumeTtsAuth = { header: string; value: string };

/**
 * Turn an auth PLAN into a concrete request credential.
 * - own key  → sent as the Hume API-key header.
 * - endpoint → a short-lived token is fetched and sent as a bearer.
 * Returns null when there is nothing usable, so the caller narrates locally instead.
 */
export async function resolveHumeTtsAuth(
  plan: HumeAuthPlan,
  fetchImpl: typeof fetch = fetch
): Promise<HumeTtsAuth | null> {
  if (plan.method === 'mint-local' || plan.method === 'api-key') {
    return { header: 'X-Hume-Api-Key', value: plan.apiKey };
  }
  if (plan.method === 'token-url') {
    const token = await fetchHumeTokenFromUrl(plan.tokenUrl, fetchImpl);
    return { header: 'Authorization', value: `Bearer ${token}` };
  }
  return null;
}

/** Should this narration go to Hume? Pure — the routing decision, testable on its own. */
export function shouldNarrateWithHume(
  voiceType: string | undefined,
  plan: HumeAuthPlan
): boolean {
  return voiceType === 'hume' && plan.method !== 'none';
}

export type HumeSpeechOptions = {
  text: string;
  auth: HumeTtsAuth;
  /** EVI/Octave voice id, when the persona names one. */
  voiceId?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Synthesize `text` and return playable audio. Throws (never returns silence) so the caller
 * can fall back to the local voice.
 */
export async function synthesizeHumeSpeech(opts: HumeSpeechOptions): Promise<Blob> {
  const text = opts.text?.trim();
  if (!text) throw new Error('nothing to narrate');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const utterance: Record<string, unknown> = { text };
  if (opts.voiceId?.trim()) utterance.voice = { id: opts.voiceId.trim() };

  let res: Response;
  try {
    res = await fetchImpl(HUME_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [opts.auth.header]: opts.auth.value,
      },
      body: JSON.stringify({ utterances: [utterance], format: { type: 'mp3' } }),
    });
  } catch (e) {
    throw new Error(`Hume TTS unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) throw new Error(`Hume TTS returned ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('Hume TTS returned a non-JSON response');
  }

  const base64 = extractAudio(body);
  if (!base64) throw new Error('Hume TTS response contained no audio');
  return base64ToBlob(base64, 'audio/mpeg');
}

/** Accept the documented shape and the obvious variants rather than failing on a rename. */
function extractAudio(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  const generations = b.generations;
  if (Array.isArray(generations) && generations.length > 0) {
    const first = generations[0] as Record<string, unknown> | undefined;
    const a = first?.audio;
    if (typeof a === 'string' && a.trim()) return a.trim();
  }
  for (const key of ['audio', 'audioBase64', 'audio_base64']) {
    const v = b[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function base64ToBlob(base64: string, mime: string): Blob {
  // Tolerate a data: URI as well as a bare base64 payload.
  const payload = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
