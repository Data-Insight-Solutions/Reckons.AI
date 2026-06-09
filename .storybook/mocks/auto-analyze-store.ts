/** Mock for $lib/stores/auto-analyze.svelte */
export function analysisRunning(): boolean { return false; }
export function lastAnalysisAt(): number | null { return null; }
export function lastAnalysisError(): string | null { return null; }

export async function runAndStoreAnalysis(_trigger?: string, _type?: string): Promise<string | null> { return null; }
export function startAutoAnalyzeScheduler(): void {}
export function stopAutoAnalyzeScheduler(): void {}
// Legacy alias
export const runAnalysis = runAndStoreAnalysis;
