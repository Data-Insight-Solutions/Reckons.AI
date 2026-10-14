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
/** Where a splat came from: 'reconstructed' (a real place, scanned), 'generated' (invented by a model) or 'synthetic'. */
export const SPLAT_ORIGIN_PREDICATE = 'urn:kbase:meta/splat-origin';
export type SplatOrigin = 'reconstructed' | 'generated' | 'synthetic';

/**
 * A splat file the person imported lives in the browser's IndexedDB (never as a data: URI in a
 * triple); the triple holds this resolvable reference, `asset:splat/<content-hash>.ply|spz`, which
 * the loader turns into the stored bytes. The same name is the file name in `assets/splats/` on export.
 */
export const LOCAL_SPLAT_PREFIX = 'asset:splat/';
export function isLocalSplatUrl(v: string): boolean {
  return /^asset:splat\/[A-Za-z0-9_-]+\.(ply|spz)$/.test(v);
}

/** A rooted path, http(s) URL, data: URI or local asset reference naming a PLY or SPZ file. */
export function isSplatUrl(v: string): boolean {
  if (isLocalSplatUrl(v)) return true;
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

/**
 * How to turn a file's own axes into the viewer's. TripoSplat writes y DOWN and faces its picture
 * along +x; a RECONSTRUCTED room (COLMAP/Brush, or a synthetic one) has no such convention, so it
 * gets none and the orientation comes from the space's settings instead (F58.9.8).
 */
export type SplatOrientation = 'triposplat' | 'none';

/** The origin recorded on the entity that carries `url`, or null. */
export function splatOriginOf(statements: readonly Statement[], url: string): SplatOrigin | null {
  const owners = new Set<string>();
  for (const s of statements) {
    if (s.p.value === SPLAT_PREDICATE && s.o.kind === 'literal' && s.o.value === url && s.s.kind === 'iri' && live(s)) owners.add(s.s.value);
  }
  for (const s of statements) {
    if (s.p.value === SPLAT_ORIGIN_PREDICATE && owners.has(s.s.value) && s.o.kind === 'literal' && live(s)
      && (s.o.value === 'reconstructed' || s.o.value === 'generated' || s.o.value === 'synthetic')) return s.o.value;
  }
  return null;
}

/** Only an explicitly (or, for older graphs, implicitly) generated splat gets TripoSplat's correction. */
export function splatOrientationFor(statements: readonly Statement[], url: string): SplatOrientation {
  const origin = splatOriginOf(statements, url);
  return origin === null || origin === 'generated' ? 'triposplat' : 'none';
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
  opts: { opacity?: number; orientation?: SplatOrientation } = {},
): Promise<{ group: THREE.Group; dispose: () => void }> {
  const { SplatMesh } = await loadSplatLib();
  let mesh: InstanceType<typeof SplatMesh>;
  if (isLocalSplatUrl(url)) {
    const { readSplatFile } = await import('$lib/storage/splat-files');
    const file = await readSplatFile(url);
    if (!file) throw new Error(`the imported splat ${url} is not in this browser's storage`);
    mesh = new SplatMesh({ fileBytes: file.bytes, fileType: file.kind as never, fileName: file.filename, raycastable: false });
  } else {
    mesh = new SplatMesh({ url, raycastable: false });
  }
  await mesh.initialized;
  if (opts.opacity !== undefined) mesh.opacity = opts.opacity;
  const box = mesh.getBoundingBox(true, new three.Box3());
  const sphere = box.getBoundingSphere(new three.Sphere());
  const inner = new three.Group();
  // TripoSplat writes y DOWN and looks at its input picture along +x (measured on both committed
  // splats by projecting their centres, 2026-10-14). Flip y up and turn +x toward a camera on +z,
  // so the splat first appears from the side its picture showed.
  if ((opts.orientation ?? 'triposplat') === 'triposplat') inner.rotation.set(Math.PI, Math.PI / 2, 0);
  mesh.position.copy(sphere.center).multiplyScalar(-1);
  inner.add(mesh);
  const group = new three.Group();
  group.scale.setScalar(sphere.radius > 0 ? radius / sphere.radius : 1);
  group.add(inner);
  return { group, dispose: () => { group.removeFromParent(); mesh.dispose(); } };
}

// ── Importing a scan (F58.9.7) ───────────────────────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const GAUSSIAN_SPLAT_TYPE = 'urn:kbase:type/GaussianSplat';

/** The entity an imported file becomes. Named from the file's content hash, so re-importing is idempotent. */
export function scanEntityIri(url: string): string {
  const id = url.replace(/^asset:splat\//, '').replace(/\.(ply|spz)$/, '');
  return `urn:kbase:concept/scan-${id.slice(0, 12)}`;
}

/**
 * The statements for an imported scan: a GaussianSplat entity with its label, the splat reference
 * and where it came from. Pure; the caller writes them.
 */
export function scanStatements(url: string, label: string, origin: SplatOrigin, newId: () => string, now = Date.now()): Statement[] {
  const iri = scanEntityIri(url);
  const base = { g: { kind: 'iri' as const, value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed' as const, createdAt: now, updatedAt: now };
  const s = { kind: 'iri' as const, value: iri };
  const lit = (value: string) => ({ kind: 'literal' as const, value });
  return [
    { id: newId(), s, p: { kind: 'iri', value: RDF_TYPE }, o: { kind: 'iri', value: GAUSSIAN_SPLAT_TYPE }, ...base },
    { id: newId(), s, p: { kind: 'iri', value: RDFS_LABEL }, o: lit(label), ...base },
    { id: newId(), s, p: { kind: 'iri', value: SPLAT_PREDICATE }, o: lit(url), ...base },
    { id: newId(), s, p: { kind: 'iri', value: SPLAT_ORIGIN_PREDICATE }, o: lit(origin), ...base },
  ];
}
