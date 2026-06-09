/**
 * Reactive WASM model status store.
 * Tracks download/init progress so UI components can show a loading bar.
 */
import { onWasmProgress, ensureWasmReady } from '$lib/integrations/llm/wasm';

type WasmState = 'idle' | 'loading' | 'ready' | 'error';

let _status = $state<WasmState>('idle');
let _pct = $state<number>(0);
let _text = $state<string>('');

// Register progress callback once at module load (no worker created yet)
// transformers.js sends progress as 0–100 (a percentage), not 0–1
onWasmProgress((status, p) => {
  _status = 'loading';
  _text = status;
  if (p !== undefined) _pct = Math.min(100, Math.round(p));
});

export function wasmStatus(): WasmState { return _status; }
export function wasmPct(): number { return _pct; }
export function wasmStatusText(): string { return _text; }

/**
 * Warm the WASM model in the background. Safe to call multiple times —
 * only creates the worker and starts the download if not already in progress.
 */
export async function warmWasm(model?: string): Promise<void> {
  if (_status === 'ready' || _status === 'loading') return;
  _status = 'loading';
  _pct = 0;
  _text = 'initializing…';
  try {
    await ensureWasmReady(model);
    _status = 'ready';
    _pct = 100;
    _text = 'ready';
  } catch (e) {
    _status = 'error';
    _text = e instanceof Error ? e.message : String(e);
  }
}
