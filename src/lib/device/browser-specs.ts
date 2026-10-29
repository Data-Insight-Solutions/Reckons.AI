/**
 * Settings → This Device: what THIS browser can tell about the machine (F245). Works on a deployed
 * site and a phone, with no dev server: everything here comes from browser APIs.
 *
 * Browsers round or hide these on purpose (fingerprinting defences): deviceMemory is capped at 8 GB
 * and missing outside Chromium, the GPU name may be a generic "ANGLE" string or absent. So each
 * field may be undefined, and the page shows "not reported" rather than guessing.
 */

export type BrowserSpecs = {
  userAgent: string;
  platform?: string;
  cores?: number;
  /** GB, Chromium only, capped at 8. */
  memoryGb?: number;
  gpu?: string;
  webgpu: boolean;
  screen: string;
  pixelRatio: number;
  touch: boolean;
  online: boolean;
  /** Origin storage: used and quota, in bytes. */
  storage?: { usage: number; quota: number; persisted?: boolean };
  crossOriginIsolated: boolean;
};

function webglRenderer(): string | undefined {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return undefined;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) as string;
  } catch {
    return undefined;
  }
}

export async function browserSpecs(): Promise<BrowserSpecs> {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  let storage: BrowserSpecs['storage'];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) storage = { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted: await navigator.storage.persisted?.() };
  } catch { /* not reported */ }
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform || nav.platform || undefined,
    cores: nav.hardwareConcurrency || undefined,
    memoryGb: nav.deviceMemory,
    gpu: webglRenderer(),
    webgpu: 'gpu' in navigator,
    screen: `${screen.width}×${screen.height}`,
    pixelRatio: window.devicePixelRatio,
    touch: navigator.maxTouchPoints > 0,
    online: navigator.onLine,
    storage,
    crossOriginIsolated: window.crossOriginIsolated,
  };
}

/**
 * The extension's content script marks the page with its version, but only on the app origin it is
 * set to (src/extension/content-script.ts), and only after the page has loaded (document_idle).
 * So "not detected" can mean not installed, or installed but pointed at a different app URL.
 */
export const EXTENSION_ATTR = 'data-reckons-extension';

export function waitForExtension(timeoutMs = 1500): Promise<string | undefined> {
  const read = () => document.documentElement.getAttribute(EXTENSION_ATTR) ?? undefined;
  if (read()) return Promise.resolve(read());
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      if (read()) { obs.disconnect(); resolve(read()); }
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: [EXTENSION_ATTR] });
    setTimeout(() => { obs.disconnect(); resolve(read()); }, timeoutMs);
  });
}

export const bytes = (n: number): string =>
  n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} KB`;
