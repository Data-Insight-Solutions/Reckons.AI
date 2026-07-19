/**
 * Execution-provider selection for in-browser inference (ONNX Runtime Web).
 *
 * ONNX Runtime is the ENGINE; WASM, WebGPU and WebNN are its execution providers. They are not
 * alternatives at different size ceilings — WASM is the SMALLEST ceiling:
 *
 *   - wasm32 linear memory is bounded by a 32-bit address space (4 GB architectural max), and
 *     browsers land well below that in practice. Weights, activations and the runtime itself all
 *     share one heap.
 *   - iOS/WebKit is tighter still (see device-capability.ts, CONSTRAINED_MODEL_MB_CAP).
 *
 * WebGPU escapes that: weights live in GPU buffers OUTSIDE wasm linear memory, so it is both the
 * route to larger models and materially faster. This module picks it when it genuinely works.
 *
 * WHY THIS IS NOT JUST `'gpu' in navigator`: WebGPU is routinely PRESENT BUT UNUSABLE — no adapter
 * (headless browsers, blocklisted drivers, VMs), or an adapter that appears and then fails when the
 * pipeline actually builds. A feature check alone would route those users to a backend that cannot
 * run, which is worse than never trying. So selection is two-stage: probe for a real adapter, and
 * still wrap construction in a fallback, because the only proof a provider works is a model that
 * loaded on it.
 *
 * Until 2026-07-18 `wasm.ts` CLAIMED "on WebGPU-capable browsers the worker will switch to the
 * WebGPU backend automatically" — no such switching existed anywhere; both paths silently used
 * single-threaded WASM. This module is that claim made true.
 */

export type InferenceDevice = 'webgpu' | 'wasm';

/** Minimal shape of the WebGPU entry point, injectable so this is testable without a GPU. */
export interface GpuCapableNavigator {
  gpu?: { requestAdapter: () => Promise<unknown | null> };
}

function currentNavigator(): GpuCapableNavigator | undefined {
  // `navigator` exists on both the window and worker globals; absent under SSR/node.
  return typeof navigator !== 'undefined' ? (navigator as GpuCapableNavigator) : undefined;
}

/**
 * Is WebGPU actually usable here? Requires an ADAPTER, not merely the API being present.
 *
 * `requestAdapter()` resolves to null on machines with no compatible GPU — the normal outcome in
 * headless CI and many VMs — and can also throw outright. Both mean "no", and neither should
 * propagate to the caller: failing to detect a GPU is not an error, it is an answer.
 */
export async function hasUsableWebGPU(nav: GpuCapableNavigator | undefined = currentNavigator()): Promise<boolean> {
  if (!nav?.gpu) return false;
  try {
    const adapter = await nav.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/** The provider to try first. */
export async function pickDevice(nav?: GpuCapableNavigator): Promise<InferenceDevice> {
  return (await hasUsableWebGPU(nav)) ? 'webgpu' : 'wasm';
}

export interface DeviceLoadResult<T> {
  value: T;
  /** The provider the model actually loaded on — report this, never the one we hoped for. */
  device: InferenceDevice;
  /** Present when WebGPU was attempted and failed; the reason we fell back. */
  fallbackReason?: string;
}

/**
 * Build a pipeline on the best available provider, falling back to WASM if WebGPU fails.
 *
 * `build` is called with the device to use and must construct the pipeline. If a WebGPU attempt
 * throws — driver fault, OOM, an unsupported op in this particular model — we retry once on WASM.
 * A model that runs slowly is strictly better than a model that does not run.
 *
 * The returned `device` is what SUCCEEDED, so callers and the UI can report the truth rather than
 * the intent. Claiming WebGPU while silently running on WASM is the exact failure this replaces.
 */
export async function loadWithDeviceFallback<T>(
  build: (device: InferenceDevice) => Promise<T>,
  nav?: GpuCapableNavigator,
): Promise<DeviceLoadResult<T>> {
  const first = await pickDevice(nav);
  if (first === 'wasm') {
    return { value: await build('wasm'), device: 'wasm' };
  }

  try {
    return { value: await build('webgpu'), device: 'webgpu' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Deliberately loud: a silent downgrade hides why inference got slow.
    console.warn('[device-select] WebGPU failed, falling back to WASM:', reason);
    return { value: await build('wasm'), device: 'wasm', fallbackReason: reason };
  }
}
