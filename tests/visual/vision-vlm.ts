/**
 * Local VLM image review (offline) — the visual-testing arm of the token-driven
 * local-first model. Reviews screenshots with a LOCAL Ollama vision model
 * (qwen2.5vl:7b, the VLM-gate bench winner) instead of cloud Claude, so the deep
 * tests (F34/F40) grade UI images offline and for free.
 *
 * Opt-in via OLLAMA_BASE_URL (same convention as the MCP local tools). When it's
 * set, this is the PREFERRED review tier (see availableTiers() in vision-analyze);
 * cloud Claude becomes an optional higher-tier fallback, not the default.
 */

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? process.env.VITE_OLLAMA_BASE_URL ?? '';
/** Winner of the VLM gate bench (npm run bench:vlm). Override with VLM_MODEL. */
export const VLM_MODEL = process.env.VLM_MODEL ?? 'qwen2.5vl:7b';

/** Local VLM review is available (opted in) when an Ollama base URL is set. */
export function hasOllamaVlm(): boolean {
  return !!OLLAMA_URL;
}

/** Raw VLM completion for a screenshot + prompt. `imgB64` is a base64 PNG. */
export async function reviewImageVLM(imgB64: string, prompt: string, model = VLM_MODEL): Promise<string> {
  if (!OLLAMA_URL) throw new Error('OLLAMA_BASE_URL not set — local VLM review is opt-in');
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [imgB64],
      stream: false,
      // Pin context so the 7B VLM fits VRAM (VLM bench lesson) and stay deterministic.
      options: { num_ctx: 8192, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama VLM ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { response?: string };
  return (json.response ?? '').trim();
}

export interface VlmGateResult {
  pass: boolean;
  notes: string;
}

/**
 * Yes/no gate: ask the local VLM a criteria question about the screenshot and
 * parse a leading YES/NO. This is the review primitive deep tests use to grade a
 * path's rendering against the UX rubric.
 */
export async function vlmGate(imgB64: string, criteria: string, model = VLM_MODEL): Promise<VlmGateResult> {
  const prompt =
    'You are a strict UI reviewer inspecting an app screenshot. Answer the question ' +
    'about what is visible. Reply with "YES" or "NO" on the first line, then a ' +
    `one-sentence reason.\n\nQuestion: ${criteria}`;
  const raw = await reviewImageVLM(imgB64, prompt, model);
  const pass = /^\s*(yes|true|pass|correct)\b/i.test(raw);
  return { pass, notes: raw };
}

export interface VlmDiff {
  changed: boolean;
  notes: string;
}

/**
 * Compare two screenshots of the same page (baseline vs candidate) with the local
 * VLM and report meaningful visual differences. Used by the offline branch/env
 * diff to catch regressions between deploys (prod->dev / staging->dev).
 */
export async function diffImagesVLM(
  baseB64: string,
  headB64: string,
  label = 'page',
  model = VLM_MODEL,
): Promise<VlmDiff> {
  if (!OLLAMA_URL) throw new Error('OLLAMA_BASE_URL not set — local VLM review is opt-in');
  const prompt =
    `Two screenshots of the same ${label}: image 1 is the BASELINE, image 2 is the ` +
    'CANDIDATE. List meaningful VISUAL differences (layout shifts, missing/extra/moved ' +
    'elements, broken or overlapping rendering, colour/text changes). Ignore tiny ' +
    'anti-aliasing noise. If there are no meaningful differences reply exactly ' +
    '"IDENTICAL"; otherwise start with "CHANGED:" then a short bulleted list.';
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [baseB64, headB64],
      stream: false,
      options: { num_ctx: 8192, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama VLM ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { response?: string };
  const raw = (json.response ?? '').trim();
  return { changed: !/^\s*identical\b/i.test(raw), notes: raw };
}

/** Free the model from VRAM between runs (keep_alive: 0). Best-effort. */
export async function unloadVlm(model = VLM_MODEL): Promise<void> {
  if (!OLLAMA_URL) return;
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
    });
  } catch {
    /* ignore — teardown only */
  }
}
