/**
 * Browser stub for onnxruntime-node.
 *
 * @xenova/transformers statically imports both onnxruntime-node and onnxruntime-web
 * and selects between them at runtime via `process?.release?.name === 'node'`.
 * In a browser/worker context Vite would otherwise try to bundle the real Node.js
 * native addon, whose module-level initialisation calls registerBackend() on APIs
 * that don't exist in the browser — crashing the worker before pipeline() is reached.
 *
 * This stub is aliased in vite.config.ts so that the static import resolves to an
 * empty object. The environment branch inside onnx.js that uses ONNX_NODE is never
 * reached in a browser (process.release.name !== 'node'), so the stub is harmless.
 */
export default {};
