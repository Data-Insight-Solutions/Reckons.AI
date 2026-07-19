/**
 * Lightweight feature-extraction wrapper.
 *
 * Used for:
 *  - clustering pending triples that refer to the same concept under
 *    slightly different surface forms ("morning coffee" vs "coffee at
 *    breakfast"), so the reviewer can collapse them with one tap.
 *  - semantic search across the KB.
 *  - cross-KB entity alignment via label embedding similarity.
 *
 * The model defaults to bge-small-en-v1.5 (33MB, 384 dims) which loads in
 * seconds and runs comfortably on phones. Configurable via settings.
 *
 * @huggingface/transformers is dynamically imported so ort-web never runs on
 * the main thread at module-evaluation time (it only loads when first needed).
 *
 * NOTE: Do NOT add any static `import` from '@huggingface/transformers' or
 * 'onnxruntime-web' here — even `import type` can cause Vite to include
 * ort-web in the main-thread bundle, which crashes with
 * "Cannot read properties of undefined (reading 'registerBackend')".
 *
 * device-select.ts is safe to import statically: it touches only `navigator.gpu`
 * and has no transformers/ort dependency of its own.
 */
import { loadWithDeviceFallback, type InferenceDevice } from '$lib/integrations/llm/device-select';

/** Local alias — cannot import type from @huggingface/transformers (see note above) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;
/** Currently loaded model ID — reset when switching models */
let loadedModel: string | null = null;

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

/** Model size estimates (MB) for consent dialog */
const MODEL_SIZES: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 22,
  'Xenova/bge-small-en-v1.5': 33,
  'Xenova/gte-small': 33,
  'Xenova/e5-small-v2': 33,
  'Xenova/all-MiniLM-L12-v2': 33,
  'Xenova/paraphrase-MiniLM-L6-v2': 22,
  'Xenova/jina-embeddings-v2-small-en': 33,
  'nomic-ai/nomic-embed-text-v1.5': 130,
};

/**
 * Download consent gate — same pattern as wasm.ts / whisper-stt.ts.
 */
let consentHandler: ((model: string, approxMB: number) => Promise<boolean>) | null = null;
const consentGranted = new Set<string>();

export function setEmbedConsentHandler(
  handler: ((model: string, approxMB: number) => Promise<boolean>) | null
) {
  consentHandler = handler;
}

/** Allow external code (settings) to override which model is used */
let _modelOverride: string | null = null;
export function setEmbeddingModel(model: string | undefined) {
  const next = model || DEFAULT_MODEL;
  if (next !== _modelOverride) {
    _modelOverride = next;
    // If a different model was loaded, reset so next call loads the new one
    if (loadedModel && loadedModel !== next) {
      extractor = null;
      loadedModel = null;
    }
  }
}

function resolveModel(): string {
  return _modelOverride || DEFAULT_MODEL;
}

async function isEmbedCached(model: string): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    // Check for quantized ONNX file — works for Xenova/* and onnx-community/*
    const url = `https://huggingface.co/${model}/resolve/main/onnx/model_quantized.onnx`;
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/** How long to wait for an embedding model load before giving up (ms). Mirrors wasm.ts. */
const EMBED_INIT_TIMEOUT_MS = 90_000;

type EmbedProgressCallback = (status: string, progress: number) => void;
const embedProgressCallbacks = new Set<EmbedProgressCallback>();
/** Subscribe to embedding-model load progress (parity with the LLM worker, which always had it). */
export function onEmbedProgress(cb: EmbedProgressCallback): () => void {
  embedProgressCallbacks.add(cb);
  return () => embedProgressCallbacks.delete(cb);
}

/** Provider the embedder actually loaded on. */
let activeEmbedDevice: InferenceDevice = 'wasm';
export function currentEmbedDevice(): InferenceDevice { return activeEmbedDevice; }

/**
 * In-flight load, shared by every concurrent caller.
 *
 * THE FIRST-RUN HANG (found 2026-07-18) lived here. `semanticEnrichDiff` calls embedMany TWICE in
 * parallel (subjects and predicates via Promise.all), so two callers reached ensureEmbedder at
 * once, neither found a loaded model, and BOTH requested download consent. The consent store holds
 * a SINGLE `_pending` slot — the second request overwrote the first, discarding its `resolve`.
 * The user saw one dialog, clicked Download, resolved the second caller... and the first was
 * orphaned FOREVER. Promise.all then waited on a promise that could never settle: no error, no
 * log, no spinner, just an ingest that never finished.
 *
 * Sharing one in-flight promise fixes it at the root: one consent request, one download, one
 * session — and it stops two callers racing to load the same model twice, which was wasteful even
 * when it happened to work.
 */
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

async function ensureEmbedder(): Promise<FeatureExtractionPipeline> {
  if (extractor && loadedModel === resolveModel()) return extractor;
  if (loadingPromise) return loadingPromise;
  loadingPromise = loadEmbedder();
  try {
    return await loadingPromise;
  } finally {
    // Cleared on success AND failure: a failed load must not poison every later attempt.
    loadingPromise = null;
  }
}

async function loadEmbedder(): Promise<FeatureExtractionPipeline> {
  const MODEL = resolveModel();

  // If same model is already loaded, reuse
  if (extractor && loadedModel === MODEL) return extractor;

  // If switching models, release old one
  if (extractor && loadedModel !== MODEL) {
    try { await extractor.dispose?.(); } catch { /* ignore */ }
    extractor = null;
    loadedModel = null;
  }

  const approxMB = MODEL_SIZES[MODEL] ?? 40;

  // Ask user before downloading if not cached
  if (consentHandler && !consentGranted.has(MODEL)) {
    const cached = await isEmbedCached(MODEL);
    if (!cached) {
      const ok = await consentHandler(MODEL, approxMB);
      if (!ok) throw new Error('Embedding model download declined by user.');
      consentGranted.add(MODEL);
    }
  }

  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  // TIMEOUT (added 2026-07-18). wasm.ts has guarded its load with a 90s Promise.race for a long
  // time; this path had NO bound at all, so a stalled LOAD would hang forever with no error and no
  // progress. Closing that gap is worth doing on its own merits.
  //
  // HONEST SCOPE: this does NOT fix the first-run stall recorded in HANDOFF.md. That was measured
  // and the timeout does not fire, which proves the load RESOLVES — the 44.4MB arrives and the
  // pipeline builds. Whatever stalls happens AFTER, on the WASM execution provider, and is still
  // unlocalized (embedding inference over the diff? semantic-diff itself? the awaited pipeline?).
  // Do not read this guard as a fix for that bug.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(
        `Embedding model load timed out after ${EMBED_INIT_TIMEOUT_MS / 1000}s. ` +
        `Check your connection, or switch embedding off / choose a different model in Settings.`,
      )),
      EMBED_INIT_TIMEOUT_MS,
    ),
  );

  // WebGPU when a real adapter exists, WASM otherwise — falling back if WebGPU fails to build.
  const load = loadWithDeviceFallback((device) =>
    pipeline('feature-extraction', MODEL, {
      device,
      dtype: 'q8',
      progress_callback: (p: { status: string; progress?: number }) => {
        for (const cb of embedProgressCallbacks) cb(p.status, p.progress ?? 0);
      },
    }),
  );

  const loaded = await Promise.race([load, timeout]);
  extractor = loaded.value as FeatureExtractionPipeline;
  activeEmbedDevice = loaded.device;
  loadedModel = MODEL;
  return extractor;
}

export async function embed(text: string): Promise<Float32Array> {
  const ex = await ensureEmbedder();
  const out = await ex(text, { pooling: 'mean', normalize: true });
  return new Float32Array(out.data as Float32Array);
}

export async function embedMany(texts: string[]): Promise<Float32Array[]> {
  const ex = await ensureEmbedder();
  return Promise.all(
    texts.map(async (t) => {
      const o = await ex(t, { pooling: 'mean', normalize: true });
      return new Float32Array(o.data as Float32Array);
    })
  );
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already normalised
}

/** Cluster items by cosine similarity above threshold (single-link) */
export function cluster<T>(items: T[], vecs: Float32Array[], threshold = 0.85): T[][] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (cosine(vecs[i], vecs[j]) >= threshold) union(i, j);
  const groups = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(items[i]);
  }
  return [...groups.values()];
}
