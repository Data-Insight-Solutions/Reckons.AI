/**
 * Gaussian splats on nodes and behind a space (F58.9.2, F58.9.3 / kb:splat-node-view,
 * kb:splat-space-background).
 *
 * A node's splat is PRESENTATION, like p:photo and p:video: `<node> p:splat "/generated/x/splat.ply"`.
 * A space's background is a SETTING, not a fact: one meta triple on a graph-level subject,
 * `<urn:reckons:space> kmeta:background-splat "…"`, so it travels with an export of the space and is
 * never drawn as an edge (isMetaPredicate covers urn:kbase:meta/).
 *
 * Rendering is Gaussian-Splat-Lite (Apache-2.0). It is about 0.75 MB compressed, so it is imported
 * only when a splat is actually on screen, and a splat that fails to load leaves the ordinary
 * marker in place.
 */
import type * as THREE from 'three';
import type { Statement } from '$lib/rdf/types';

export const SPLAT_PREDICATE = 'urn:kbase:predicate/splat';
export const SPACE_SUBJECT = 'urn:reckons:space';
export const BACKGROUND_SPLAT_PREDICATE = 'urn:kbase:meta/background-splat';

/** A rooted path, http(s) URL or data: URI naming a PLY or SPZ file. */
export function isSplatUrl(v: string): boolean {
  if (!(v.startsWith('/') || v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:'))) return false;
  if (v.startsWith('data:')) return true;
  return /\.(ply|spz)([?#].*)?$/i.test(v);
}

const live = (s: Statement) => s.status !== 'rejected' && s.status !== 'superseded' && s.status !== 'pending-removal';

/** Entity IRI → splat URL, from p:splat literals. */
export function splatMapFrom(statements: readonly Statement[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of statements) {
    if (s.p.value === SPLAT_PREDICATE && s.s.kind === 'iri' && s.o.kind === 'literal' && live(s) && isSplatUrl(s.o.value)) {
      if (!m.has(s.s.value)) m.set(s.s.value, s.o.value);
    }
  }
  return m;
}

/** The space's background splat, or null. The newest live setting wins. */
export function backgroundSplatFrom(statements: readonly Statement[]): string | null {
  let best: Statement | null = null;
  for (const s of statements) {
    if (s.s.value !== SPACE_SUBJECT || s.p.value !== BACKGROUND_SPLAT_PREDICATE || s.o.kind !== 'literal' || !live(s)) continue;
    if (!isSplatUrl(s.o.value)) continue;
    if (!best || (s.updatedAt ?? 0) >= (best.updatedAt ?? 0)) best = s;
  }
  return best?.o.value ?? null;
}

type SplatLib = typeof import('gaussian-splat-lite');
let lib: Promise<SplatLib> | null = null;
export function loadSplatLib(): Promise<SplatLib> {
  return (lib ??= import('gaussian-splat-lite'));
}

/**
 * Load one splat and wrap it in a group normalised to `radius` world units around its own centre,
 * so a node's splat is node-sized whatever scale the file was written at.
 */
export async function createNormalizedSplat(
  three: typeof THREE,
  url: string,
  radius: number,
  opts: { opacity?: number } = {},
): Promise<{ group: THREE.Group; dispose: () => void }> {
  const { SplatMesh } = await loadSplatLib();
  const mesh = new SplatMesh({ url, raycastable: false });
  await mesh.initialized;
  if (opts.opacity !== undefined) mesh.opacity = opts.opacity;
  const box = mesh.getBoundingBox(true, new three.Box3());
  const sphere = box.getBoundingSphere(new three.Sphere());
  const inner = new three.Group();
  // TripoSplat writes y DOWN and looks at its input picture along +x (measured on both committed
  // splats by projecting their centres, 2026-10-14). Flip y up and turn +x toward a camera on +z,
  // so the splat first appears from the side its picture showed.
  inner.rotation.set(Math.PI, Math.PI / 2, 0);
  mesh.position.copy(sphere.center).multiplyScalar(-1);
  inner.add(mesh);
  const group = new three.Group();
  group.scale.setScalar(sphere.radius > 0 ? radius / sphere.radius : 1);
  group.add(inner);
  return { group, dispose: () => { group.removeFromParent(); mesh.dispose(); } };
}
