/** Mock for $lib/stores/glb-overrides.svelte */
export function glbOverrides(): Map<string, string> { return new Map(); }
export async function loadGlbOverrides(): Promise<void> {}
export async function setGlbOverride(_iri: string, _url: string): Promise<void> {}
export async function clearGlbOverride(_iri: string): Promise<void> {}
