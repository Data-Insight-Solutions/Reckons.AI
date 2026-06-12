/**
 * Model cache inspector + sideload helper.
 *
 * transformers.js stores model files in the browser Cache API under the
 * cache name `'transformers-cache'`, keyed by the full HuggingFace URL.
 * Kokoro voices use `'kokoro-voices'`.
 *
 * This module lets us:
 *  1. List which models are already cached (and how much space they use).
 *  2. Sideload model files from disk into the cache so the app works
 *     offline without ever having fetched from HuggingFace.
 *  3. Purge cached models to free space.
 */

const HF_HOST = 'https://huggingface.co';
const TRANSFORMERS_CACHE = 'transformers-cache';
const KOKORO_CACHE = 'kokoro-voices';

// ── Known model manifests ──────────────────────────────────────────────────
// Each entry describes the files needed for a model + the cache URL pattern.

export interface ModelFile {
  /** Path relative to the model repo (e.g. "onnx/model_q4.onnx") */
  path: string;
  /** Approximate size in bytes (for progress display) */
  approxBytes: number;
  /** Which Cache API bucket this file lives in */
  cacheName: typeof TRANSFORMERS_CACHE | typeof KOKORO_CACHE;
}

export interface ModelManifest {
  id: string;
  label: string;
  description: string;
  /** HuggingFace model repo ID */
  repo: string;
  files: ModelFile[];
  /** Total approximate size */
  totalBytes: number;
}

function hfUrl(repo: string, path: string, revision = 'main'): string {
  return `${HF_HOST}/${repo}/resolve/${revision}/${path}`;
}

// SmolLM2-360M q4 — the default WASM LLM
const SMOLLM2_360M: ModelManifest = {
  id: 'smollm2-360m',
  label: 'SmolLM2-360M (LLM)',
  description: 'Default local LLM for extraction and chat. ~370 MB.',
  repo: 'HuggingFaceTB/SmolLM2-360M-Instruct',
  totalBytes: 370_000_000,
  files: [
    { path: 'onnx/model_q4.onnx', approxBytes: 370_000_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'config.json', approxBytes: 900, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer.json', approxBytes: 2_100_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer_config.json', approxBytes: 4_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'generation_config.json', approxBytes: 200, cacheName: TRANSFORMERS_CACHE },
  ],
};

// all-MiniLM-L6-v2 q8 — embedding model
const MINILM: ModelManifest = {
  id: 'minilm-l6-v2',
  label: 'MiniLM-L6-v2 (embeddings)',
  description: 'Semantic search & entity clustering. ~22 MB.',
  repo: 'Xenova/all-MiniLM-L6-v2',
  totalBytes: 22_000_000,
  files: [
    { path: 'onnx/model_quantized.onnx', approxBytes: 22_000_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'config.json', approxBytes: 600, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer.json', approxBytes: 700_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer_config.json', approxBytes: 1_200, cacheName: TRANSFORMERS_CACHE },
  ],
};

// Kokoro 82M quantized — TTS
const KOKORO: ModelManifest = {
  id: 'kokoro-82m',
  label: 'Kokoro 82M (TTS voice)',
  description: 'Offline text-to-speech. ~88 MB + voice files.',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  totalBytes: 93_000_000,
  files: [
    { path: 'onnx/model_quantized.onnx', approxBytes: 88_000_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'config.json', approxBytes: 2_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer.json', approxBytes: 3_500, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer_config.json', approxBytes: 600, cacheName: TRANSFORMERS_CACHE },
    { path: 'voices/af_heart.bin', approxBytes: 522_240, cacheName: KOKORO_CACHE },
    { path: 'voices/af_bella.bin', approxBytes: 522_240, cacheName: KOKORO_CACHE },
    { path: 'voices/am_michael.bin', approxBytes: 522_240, cacheName: KOKORO_CACHE },
    { path: 'voices/bf_emma.bin', approxBytes: 522_240, cacheName: KOKORO_CACHE },
    { path: 'voices/bm_george.bin', approxBytes: 522_240, cacheName: KOKORO_CACHE },
  ],
};

// Whisper tiny — STT (if/when added)
const WHISPER_TINY: ModelManifest = {
  id: 'whisper-tiny',
  label: 'Whisper Tiny (STT)',
  description: 'Offline speech-to-text. ~42 MB.',
  repo: 'onnx-community/whisper-tiny',
  totalBytes: 43_400_000,
  files: [
    { path: 'onnx/encoder_model_quantized.onnx', approxBytes: 10_125_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'onnx/decoder_model_merged_quantized.onnx', approxBytes: 30_720_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'config.json', approxBytes: 2_300, cacheName: TRANSFORMERS_CACHE },
    { path: 'tokenizer.json', approxBytes: 2_480_000, cacheName: TRANSFORMERS_CACHE },
    { path: 'generation_config.json', approxBytes: 3_800, cacheName: TRANSFORMERS_CACHE },
    { path: 'preprocessor_config.json', approxBytes: 400, cacheName: TRANSFORMERS_CACHE },
  ],
};

export const MODEL_MANIFESTS: ModelManifest[] = [SMOLLM2_360M, MINILM, KOKORO, WHISPER_TINY];

// ── Cache inspection ───────────────────────────────────────────────────────

export interface CachedModelStatus {
  manifest: ModelManifest;
  /** Number of files found in cache */
  cachedCount: number;
  /** Number of files expected */
  totalCount: number;
  /** Sum of cached response body sizes */
  cachedBytes: number;
  /** True if all required files are in cache */
  complete: boolean;
}

export async function inspectModelCache(): Promise<CachedModelStatus[]> {
  const results: CachedModelStatus[] = [];

  for (const manifest of MODEL_MANIFESTS) {
    let cachedCount = 0;
    let cachedBytes = 0;

    for (const file of manifest.files) {
      try {
        const cache = await caches.open(file.cacheName);
        const url = hfUrl(manifest.repo, file.path);
        const resp = await cache.match(url);
        if (resp) {
          cachedCount++;
          // Try to read Content-Length; if not available, use approxBytes
          const cl = resp.headers.get('Content-Length');
          cachedBytes += cl ? parseInt(cl, 10) : file.approxBytes;
        }
      } catch {
        // Cache API not available or permission denied
      }
    }

    results.push({
      manifest,
      cachedCount,
      totalCount: manifest.files.length,
      cachedBytes,
      complete: cachedCount === manifest.files.length,
    });
  }

  return results;
}

// ── Sideload ───────────────────────────────────────────────────────────────

export interface SideloadProgress {
  file: string;
  index: number;
  total: number;
  bytes: number;
}

/**
 * Sideload model files from the user's disk into the browser Cache API.
 *
 * The user provides a FileList (from <input type="file" webkitdirectory>)
 * containing the model repo files. We match them against the manifest and
 * write them into the cache with the correct HuggingFace URL keys.
 *
 * @param manifestId - Which model manifest to sideload for
 * @param files - FileList from a directory picker
 * @param onProgress - Optional progress callback
 * @returns Number of files successfully cached
 */
export async function sideloadModel(
  manifestId: string,
  files: FileList | File[],
  onProgress?: (p: SideloadProgress) => void
): Promise<number> {
  const manifest = MODEL_MANIFESTS.find(m => m.id === manifestId);
  if (!manifest) throw new Error(`Unknown model: ${manifestId}`);

  // Build a map of filename → File for quick lookup
  const fileMap = new Map<string, File>();
  for (const f of files) {
    // Handle both flat file names and directory-relative paths
    // e.g. "model_q4.onnx" or "onnx/model_q4.onnx" or "SmolLM2-360M-Instruct/onnx/model_q4.onnx"
    const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    fileMap.set(name, f);
    // Also index by just the filename and by tail segments
    const segments = name.split('/');
    for (let i = 0; i < segments.length; i++) {
      const tail = segments.slice(i).join('/');
      if (!fileMap.has(tail)) fileMap.set(tail, f);
    }
  }

  let loaded = 0;

  for (let i = 0; i < manifest.files.length; i++) {
    const mf = manifest.files[i];
    const file = fileMap.get(mf.path) || fileMap.get(mf.path.split('/').pop()!);
    if (!file) continue;

    const cache = await caches.open(mf.cacheName);
    const url = hfUrl(manifest.repo, mf.path);

    // Read the file and store as a Response in the cache
    const buffer = await file.arrayBuffer();
    const contentType = mf.path.endsWith('.json') ? 'application/json'
      : mf.path.endsWith('.onnx') ? 'application/octet-stream'
      : 'application/octet-stream';

    await cache.put(url, new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.byteLength),
      }
    }));

    loaded++;
    onProgress?.({ file: mf.path, index: i, total: manifest.files.length, bytes: buffer.byteLength });
  }

  return loaded;
}

// ── Purge ──────────────────────────────────────────────────────────────────

/**
 * Remove all cached files for a given model.
 */
export async function purgeModelCache(manifestId: string): Promise<number> {
  const manifest = MODEL_MANIFESTS.find(m => m.id === manifestId);
  if (!manifest) return 0;

  let deleted = 0;
  for (const mf of manifest.files) {
    try {
      const cache = await caches.open(mf.cacheName);
      const url = hfUrl(manifest.repo, mf.path);
      if (await cache.delete(url)) deleted++;
    } catch { /* ignore */ }
  }
  return deleted;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
