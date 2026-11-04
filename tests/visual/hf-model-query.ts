#!/usr/bin/env npx tsx
/**
 * HuggingFace Model Query — Auto-discover top embedding models
 *
 * Queries the HuggingFace API for ONNX-compatible embedding models,
 * ranked by downloads or likes. Used by the embedding bench to compare
 * current model (MiniLM-L6-v2) against top alternatives.
 *
 * Usage:
 *   npx tsx tests/visual/hf-model-query.ts                  # top 10 by downloads
 *   npx tsx tests/visual/hf-model-query.ts --top 20         # top 20
 *   npx tsx tests/visual/hf-model-query.ts --sort likes     # sort by likes
 *   npx tsx tests/visual/hf-model-query.ts --json           # JSON output
 */

export interface HFModel {
  modelId: string;
  downloads: number;
  likes: number;
  pipeline_tag: string;
  tags: string[];
  /** Estimated ONNX size in MB (from siblings if available) */
  onnxSizeMB: number | null;
  /** Whether an ONNX variant is confirmed in the repo */
  hasOnnx: boolean;
}

const HF_API = 'https://huggingface.co/api/models';

/**
 * Query HuggingFace for top feature-extraction (embedding) models.
 * Filters for ONNX compatibility by checking tags and library metadata.
 */
export async function queryEmbeddingModels(opts: {
  top?: number;
  sort?: 'downloads' | 'likes';
  /** Additional filter string (e.g. 'onnx') */
  filter?: string;
} = {}): Promise<HFModel[]> {
  const { top = 10, sort = 'downloads', filter } = opts;

  // Fetch more than we need since we'll filter for ONNX compatibility
  const limit = Math.max(top * 3, 50);
  const params = new URLSearchParams({
    pipeline_tag: 'feature-extraction',
    sort: sort,
    direction: '-1',
    limit: String(limit),
    ...(filter ? { filter } : {}),
  });

  const url = `${HF_API}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF API ${res.status}: ${await res.text()}`);

  const models: Array<{
    modelId: string;
    downloads: number;
    likes: number;
    pipeline_tag: string;
    tags: string[];
    siblings?: Array<{ rfilename: string; size?: number }>;
    library_name?: string;
  }> = await res.json();

  // Filter and map to our type
  const results: HFModel[] = [];

  for (const m of models) {
    // Check for ONNX compatibility: tags, library_name, or known ONNX-ready repos
    const tags = m.tags ?? [];
    const hasOnnxTag = tags.some(t =>
      t === 'onnx' || t === 'transformers.js' || t === 'sentence-transformers'
    );
    const hasOnnxLib = m.library_name === 'onnx' || m.library_name === 'transformers.js';
    const hasOnnxFile = m.siblings?.some(s => s.rfilename.endsWith('.onnx')) ?? false;
    const hasOnnx = hasOnnxTag || hasOnnxLib || hasOnnxFile;

    // Estimate ONNX model size from siblings
    let onnxSizeMB: number | null = null;
    if (m.siblings) {
      const onnxFiles = m.siblings.filter(s => s.rfilename.endsWith('.onnx'));
      if (onnxFiles.length > 0) {
        const totalBytes = onnxFiles.reduce((sum, f) => sum + (f.size ?? 0), 0);
        if (totalBytes > 0) onnxSizeMB = Math.round(totalBytes / 1_048_576);
      }
    }

    results.push({
      modelId: m.modelId,
      downloads: m.downloads,
      likes: m.likes,
      pipeline_tag: m.pipeline_tag,
      tags,
      onnxSizeMB,
      hasOnnx,
    });
  }

  // Sort ONNX-confirmed first, then by the chosen metric
  results.sort((a, b) => {
    if (a.hasOnnx !== b.hasOnnx) return a.hasOnnx ? -1 : 1;
    return sort === 'likes' ? b.likes - a.likes : b.downloads - a.downloads;
  });

  return results.slice(0, top);
}

/**
 * Get well-known embedding models for benchmarking — a curated
 * fallback list when the API is unavailable.
 */
export function getCuratedModels(): Array<{ modelId: string; dims: number; sizeMB: number; dtype: string }> {
  return [
    { modelId: 'Xenova/all-MiniLM-L6-v2', dims: 384, sizeMB: 22, dtype: 'q8' },
    { modelId: 'nomic-ai/nomic-embed-text-v1.5', dims: 768, sizeMB: 130, dtype: 'fp32' },
    { modelId: 'Xenova/bge-small-en-v1.5', dims: 384, sizeMB: 33, dtype: 'q8' },
    { modelId: 'Xenova/gte-small', dims: 384, sizeMB: 33, dtype: 'q8' },
    { modelId: 'Xenova/e5-small-v2', dims: 384, sizeMB: 33, dtype: 'q8' },
    { modelId: 'Xenova/jina-embeddings-v2-small-en', dims: 512, sizeMB: 33, dtype: 'q8' },
    { modelId: 'Xenova/all-MiniLM-L12-v2', dims: 384, sizeMB: 33, dtype: 'q8' },
    { modelId: 'Xenova/paraphrase-MiniLM-L6-v2', dims: 384, sizeMB: 22, dtype: 'q8' },
  ];
}

// ── Generic access (F183.1: the generation-model bench reuses this instead of a second client) ──

/** What the HF API returns for a model, as far as any bench here reads it. */
export interface HFRawModel {
  id: string;
  sha?: string;
  lastModified?: string;
  createdAt?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  gated?: boolean | string;
  private?: boolean;
  tags?: string[];
  cardData?: { license?: string; base_model?: string | string[]; [k: string]: unknown };
  gguf?: { total?: number; architecture?: string; totalFileSize?: number };
  siblings?: Array<{ rfilename: string; size?: number; lfs?: { sha256: string; size: number } }>;
}
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** List models for a pipeline tag (and optional tag filter), with the fields discovery needs. */
export async function hfListModels(
  opts: { pipelineTag: string; filter?: string; sort?: 'downloads' | 'likes' | 'lastModified'; limit?: number },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<HFRawModel[]> {
  const params = new URLSearchParams({
    pipeline_tag: opts.pipelineTag, sort: opts.sort ?? 'downloads', direction: '-1', limit: String(opts.limit ?? 50),
    ...(opts.filter ? { filter: opts.filter } : {}),
  });
  for (const f of ['downloads', 'likes', 'tags', 'lastModified', 'createdAt', 'sha', 'gguf', 'cardData', 'gated', 'pipeline_tag']) params.append('expand[]', f);
  const res = await fetchImpl(`${HF_API}?${params}`);
  if (!res.ok) throw new Error(`HF API ${res.status}: ${await res.text()}`);
  return (await res.json()) as HFRawModel[];
}

/** One repository with per-file sizes and LFS sha256 (`blobs=true`). */
export async function hfModelInfo(repo: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<HFRawModel> {
  const res = await fetchImpl(`${HF_API}/${repo}?blobs=true`);
  if (!res.ok) throw new Error(`HF API ${res.status} for ${repo}`);
  return (await res.json()) as HFRawModel;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith('hf-model-query.ts') || process.argv[1].endsWith('hf-model-query.js'))) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const topIdx = args.indexOf('--top');
  const top = topIdx >= 0 ? parseInt(args[topIdx + 1]) || 10 : 10;
  const sortIdx = args.indexOf('--sort');
  const sort = (sortIdx >= 0 ? args[sortIdx + 1] : 'downloads') as 'downloads' | 'likes';

  (async () => {
    console.log(`\nQuerying HuggingFace for top ${top} embedding models (sorted by ${sort})...\n`);

    try {
      const models = await queryEmbeddingModels({ top, sort });

      if (jsonMode) {
        console.log(JSON.stringify(models, null, 2));
      } else {
        console.log('  #  Model ID                                    Downloads     Likes  ONNX   Size');
        console.log('  ' + '-'.repeat(90));
        models.forEach((m, i) => {
          const onnx = m.hasOnnx ? 'yes' : ' - ';
          const size = m.onnxSizeMB ? `${m.onnxSizeMB}MB` : '   ?';
          console.log(
            `  ${String(i + 1).padStart(2)}  ${m.modelId.padEnd(44)} ${String(m.downloads).padStart(10)}  ${String(m.likes).padStart(7)}  ${onnx.padEnd(5)}  ${size}`
          );
        });
      }

      console.log(`\nCurated benchmark candidates:`);
      for (const c of getCuratedModels()) {
        console.log(`    ${c.modelId.padEnd(44)} ${c.dims}d  ${c.sizeMB}MB  ${c.dtype}`);
      }
    } catch (e) {
      console.error('HF API query failed:', (e as Error).message);
      console.log('\nFalling back to curated list:');
      for (const c of getCuratedModels()) {
        console.log(`    ${c.modelId.padEnd(44)} ${c.dims}d  ${c.sizeMB}MB  ${c.dtype}`);
      }
    }
  })();
}
