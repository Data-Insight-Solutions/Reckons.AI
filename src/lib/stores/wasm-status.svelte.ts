/**
 * Reactive WASM model status store.
 * Tracks download/init progress so UI components can show a loading bar.
 */
import { onWasmProgress, onWasmFallback, ensureWasmReady } from '$lib/integrations/llm/wasm';
import { pushNotification } from '$lib/stores/notifications.svelte';

type WasmState = 'idle' | 'loading' | 'ready' | 'error';

let _status = $state<WasmState>('idle');
let pct = $state<number>(0);
let text = $state<string>('');

// Register progress callback once at module load (no worker created yet)
// transformers.js sends progress as 0–100 (a percentage), not 0–1
onWasmProgress((status, p) => {
  if (status === 'ready') {
    _status = 'ready';
    pct = 100;
    text = 'ready';
    return;
  }
  _status = 'loading';
  text = status;
  if (p !== undefined) pct = Math.min(100, Math.round(p));
});

// When the worker falls back to a different model, notify the user
onWasmFallback((requested, actual, reason) => {
  console.warn(`[wasm] Model "${requested}" unavailable (${reason}), fell back to "${actual}"`);
  pushNotification({
    id: 'wasm-model-fallback',
    type: 'warn',
    title: 'Switched to fallback model',
    body: `"${requested.split('/').pop()}" couldn't load — using "${actual.split('/').pop()}" instead. You can change this in Settings.`,
    action: { label: 'Settings', href: '/settings' },
  });
});

export function wasmStatus(): WasmState { return _status; }
export function wasmPct(): number { return pct; }
export function wasmStatusText(): string { return text; }

/**
 * Warm the WASM model in the background. Safe to call multiple times —
 * only creates the worker and starts the download if not already in progress.
 */
export async function warmWasm(model?: string): Promise<void> {
  if (_status === 'ready' || _status === 'loading') return;
  _status = 'loading';
  pct = 0;
  text = 'initializing…';
  try {
    await ensureWasmReady(model);
    _status = 'ready';
    pct = 100;
    text = 'ready';
  } catch (e) {
    _status = 'error';
    text = e instanceof Error ? e.message : String(e);
  }
}
