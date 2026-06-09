/** Mock for $lib/stores/perf-monitor.svelte */
export function recordFrame(_delta: number): void {}
export function displayFps(): number { return 60; }
export function suggestLowerFidelity(): boolean { return false; }
export function dismissLowFpsSuggestion(): void {}
