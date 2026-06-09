/**
 * Lightweight feature-extraction wrapper.
 *
 * Used for:
 *  - clustering pending triples that refer to the same concept under
 *    slightly different surface forms ("morning coffee" vs "coffee at
 *    breakfast"), so the reviewer can collapse them with one tap.
 *  - semantic search across the KB.
 *
 * The model defaults to all-MiniLM-L6-v2 (22MB, 384 dims) which loads in
 * seconds and runs comfortably on phones.
 *
 * @xenova/transformers is dynamically imported so ort-web never runs on the
 * main thread at module-evaluation time (it only loads when first needed).
 *
 * NOTE: Do NOT add any static `import` from '@xenova/transformers' or
 * 'onnxruntime-web' here — even `import type` can cause Vite to include
 * ort-web in the main-thread bundle, which crashes with
 * "Cannot read properties of undefined (reading 'registerBackend')".
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;

export async function ensureEmbedder(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  extractor = (await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2'
  )) as FeatureExtractionPipeline;
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
