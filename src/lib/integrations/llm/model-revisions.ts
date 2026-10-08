/**
 * THE EXACT VERSION OF EVERY HUGGING FACE MODEL THE APP DOWNLOADS (F253, F254).
 *
 * Until 2026-10-08 every model was fetched at revision 'main' — model-cache.ts built its URLs with
 * it and transformers.js defaults to it — so whatever a model's owner pushed next is what every
 * copy of Reckons.AI downloaded, and no change could say which version of a model made it.
 * A commit sha is the only exact answer: it cannot move.
 *
 * Pinned 2026-10-08 to each repo's then-current commit (https://huggingface.co/api/models/<repo>,
 * field `sha`). To move a pin, read the new sha the same way and change it here; the browser cache
 * is keyed by URL, so the next load downloads that version once.
 *
 * A model a person types into Settings that is not listed here still loads, at 'main', and
 * `isPinned` says so — it is their choice, but it is not a verified version and must not be
 * recorded as one.
 */
export const MODEL_REVISIONS: Readonly<Record<string, string>> = {
  // Embeddings (embed.ts MODEL_SIZES)
  'Xenova/bge-small-en-v1.5': 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
  'Xenova/all-MiniLM-L12-v2': 'beeb2e4b69e95f188a15cc2e90d09fd035dac229',
  'Xenova/paraphrase-MiniLM-L6-v2': '2bb9dc00941ae0b65da96d5dd95d4a4564161858',
  'Xenova/jina-embeddings-v2-small-en': '523cadcb9c2e71c7153fc46016e1fe79acb4f58f',
  'Xenova/gte-small': '5927d1727bb12db490052a1b33265ad78058de08',
  'Xenova/e5-small-v2': '02af79985278377e65c724a76275707cb0333c70',
  'nomic-ai/nomic-embed-text-v1.5': 'e9b6763023c676ca8431644204f50c2b100d9aab',
  // In-browser text generation (Settings WASM_MODELS, wasm.ts, device-capability.ts)
  'HuggingFaceTB/SmolLM2-135M-Instruct': '12fd25f77366fa6b3b4b768ec3050bf629380bac',
  'HuggingFaceTB/SmolLM2-360M-Instruct': 'a10cc1512eabd3dde888204e902eca88bddb4951',
  'onnx-community/Qwen2.5-0.5B-Instruct': '22942cb7d7ba4cc81bb4673549ca4d4614469b5e',
  'onnx-community/Qwen2.5-1.5B-Instruct': 'd54957e3af1be04546436e874a60fe386041b244',
  'HuggingFaceTB/SmolLM2-1.7B-Instruct': '31b70e2e869a7173562077fd711b654946d38674',
  // Speech
  'onnx-community/whisper-tiny': 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  'onnx-community/Kokoro-82M-v1.0-ONNX': '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
};

/**
 * Models whose loader cannot be told a revision, named so the gap is visible rather than assumed
 * closed. kokoro-js 1.x `KokoroTTS.from_pretrained` forwards only dtype, device and
 * progress_callback to transformers.js, so it always fetches 'main'. Its sha above records the
 * version that was current when pinned, for comparison; nothing fetches it, and `revisionFor`
 * returns 'main' so the cache inspector looks for the files the loader really downloads.
 */
export const UNPINNABLE_LOADERS: Readonly<Record<string, string>> = {
  'onnx-community/Kokoro-82M-v1.0-ONNX': 'kokoro-js from_pretrained drops the revision option',
};

/**
 * The revision a load of `repo` actually fetches: the pinned commit, or 'main' for a model this
 * file does not list or whose loader cannot be pinned.
 */
export function revisionFor(repo: string): string {
  return isPinned(repo) ? MODEL_REVISIONS[repo] : 'main';
}

/** True only when the load will fetch an exact, unmovable version. */
export function isPinned(repo: string): boolean {
  return repo in MODEL_REVISIONS && !(repo in UNPINNABLE_LOADERS);
}
