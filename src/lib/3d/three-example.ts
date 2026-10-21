import type { Statement } from '$lib/rdf/types';

/** Presentation metadata, never executable code in the graph renderer. */
export const THREE_EXAMPLE_PREDICATE = 'urn:kbase:meta/three-example';
export const THREE_EXAMPLE_LOAD_MS = 45_000;
export const THREE_EXAMPLE_HEARTBEAT_MS = 10_000;

/** Accept gallery links or individual WebGL/WebGPU examples on the official host only. */
export function threeExampleUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'threejs.org' || url.port || url.username || url.password || url.search) return null;
    let name: string;
    if (url.pathname === '/examples/' || url.pathname === '/examples/index.html') name = url.hash.slice(1);
    else {
      if (url.hash) return null;
      name = /^\/examples\/([^/]+)\.html$/.exec(url.pathname)?.[1] ?? '';
    }
    if (!/^(webgl|webgpu)_[a-z0-9_]+$/.test(name)) return null;
    return `https://threejs.org/examples/${name}.html`;
  } catch { return null; }
}

export function threeExampleMapFrom(statements: readonly Statement[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const s of statements) {
    if (s.p.value !== THREE_EXAMPLE_PREDICATE || s.s.kind !== 'iri' || s.o.kind !== 'literal'
      || ['rejected', 'superseded', 'pending-removal'].includes(s.status)) continue;
    const url = threeExampleUrl(s.o.value);
    if (url && !result.has(s.s.value)) result.set(s.s.value, url);
  }
  return result;
}

/**
 * The space's background example: one replaceable setting on the space subject, like the
 * background splat. Reading it never starts anything; the person loads it from the graph view.
 */
export const BACKGROUND_THREE_EXAMPLE_PREDICATE = 'urn:kbase:meta/background-three-example';

export function backgroundThreeExampleFrom(statements: readonly Statement[], space = 'urn:reckons:space'): string | null {
  for (const s of statements) {
    if (s.p.value !== BACKGROUND_THREE_EXAMPLE_PREDICATE || s.s.kind !== 'iri' || s.s.value !== space || s.o.kind !== 'literal'
      || ['rejected', 'superseded', 'pending-removal', 'pending'].includes(s.status)) continue;
    const url = threeExampleUrl(s.o.value);
    if (url) return url;
  }
  return null;
}
