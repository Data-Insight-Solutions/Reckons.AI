/** Mock for $lib/stores/gif-overrides.svelte */
export function gifOverrides(): Map<string, string> { return new Map(); }
export async function loadGifOverrides(): Promise<void> {}
export async function setGif(_iri: string, _blob: Blob, _filename: string): Promise<void> {}
export async function clearGif(_iri: string): Promise<void> {}
