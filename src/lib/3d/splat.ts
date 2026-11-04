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
 * triple); the triple holds this resolvable reference, `asset:splat/<content-hash>.ply|spz|sog`, which
 * the loader turns into the stored bytes. The same name is the file name in `assets/splats/` on export.
 */
export const LOCAL_SPLAT_PREFIX = 'asset:splat/';
export function isLocalSplatUrl(v: string): boolean {
  return /^asset:splat\/[A-Za-z0-9_-]+\.(ply|spz|sog)$/.test(v);
}

/** A rooted path, http(s) URL, data: URI or local asset reference naming a PLY, SPZ or SOG file. */
export function isSplatUrl(v: string): boolean {
  if (isLocalSplatUrl(v)) return true;
  if (!(v.startsWith('/') || v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:'))) return false;
  if (v.startsWith('data:')) return true;
  return /\.(ply|spz|sog)([?#].*)?$/i.test(v);
}

const live = (s: Statement) => s.status !== 'rejected' && s.status !== 'superseded' && s.status !== 'pending-removal';

/** Entity IRI → splat URL, from p:splat literals. */
/**
 * Bundled files that were replaced by a different file name. A copy saved in the browser keeps the
 * address it was written with, so after a replacement it points at a file that is gone (404) and no
 * room appears. Reading maps the old address to the current one; the saved copy is untouched.
 */
const MOVED_BUNDLED_SPLATS: Readonly<Record<string, string>> = {
  '/generated/synthetic-room/splat.ply': '/generated/synthetic-room/splat.spz',
};
export function currentSplatUrl(url: string): string {
  return MOVED_BUNDLED_SPLATS[url] ?? url;
}

export function splatMapFrom(statements: readonly Statement[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of statements) {
    if (s.p.value === SPLAT_PREDICATE && s.s.kind === 'iri' && s.o.kind === 'literal' && live(s) && isSplatUrl(s.o.value)) {
      if (!m.has(s.s.value)) m.set(s.s.value, currentSplatUrl(s.o.value));
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
  return best ? currentSplatUrl(best.o.value) : null;
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
    if (s.p.value === SPLAT_PREDICATE && s.o.kind === 'literal' && currentSplatUrl(s.o.value) === url && s.s.kind === 'iri' && live(s)) owners.add(s.s.value);
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
 * so a node's splat is node-sized whatever scale the file was written at (unless `keepScale`).
 */
export async function createNormalizedSplat(
  three: typeof THREE,
  url: string,
  radius: number,
  opts: { opacity?: number; orientation?: SplatOrientation; keepScale?: boolean } = {},
): Promise<{ group: THREE.Group; inner: THREE.Group; mesh: { opacity: number }; baseQuaternion: THREE.Quaternion; dispose: () => void }> {
  const { SplatMesh } = await loadSplatLib();
  let mesh: InstanceType<typeof SplatMesh>;
  if (isLocalSplatUrl(url)) {
    const { readSplatFile } = await import('$lib/storage/splat-files');
    const file = await readSplatFile(url);
    if (!file) throw new Error(`the imported splat ${url} is not in this browser's storage`);
    mesh = new SplatMesh({ file: file.blob, fileType: file.kind as never, fileName: file.filename, raycastable: false });
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
  // keepScale (a surround room): one file unit stays one world unit (times the space's scale setting).
  group.scale.setScalar(!opts.keepScale && sphere.radius > 0 ? radius / sphere.radius : 1);
  group.add(inner);
  return { group, inner, mesh, baseQuaternion: inner.quaternion.clone(), dispose: () => { group.removeFromParent(); mesh.dispose(); } };
}

// ── Importing a scan (F58.9.7) ───────────────────────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const GAUSSIAN_SPLAT_TYPE = 'urn:kbase:type/GaussianSplat';

/** The entity an imported file becomes. Named from the file's content hash, so re-importing is idempotent. */
export function scanEntityIri(url: string): string {
  const id = url.replace(/^asset:splat\//, '').replace(/\.(ply|spz|sog)$/, '');
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

// ── Background settings (F58.9.8) ────────────────────────────────────────────
//
// Settings, not facts: meta triples on <urn:reckons:space>, never edges, so they travel with an
// export of the space. Unset means the default, so a space made before F58.9.8 looks as it did.

const META = 'urn:kbase:meta/';
export const BG_MODE_PREDICATE = META + 'background-mode';
export const BG_UP_PREDICATE = META + 'background-up';
export const BG_YAW_PREDICATE = META + 'background-yaw';
export const BG_LEVEL_PREDICATE = META + 'background-level';
export const BG_SCALE_PREDICATE = META + 'background-scale';
export const BG_OFFSET_PREDICATE = META + 'background-offset';
export const BG_OPACITY_PREDICATE = META + 'background-opacity';
/**
 * The measured extent (longest bounding-box side, in the file's own units) of the imported scan.
 * Informational and used for ONE thing: the default surround scale. COLMAP's scale is arbitrary (a
 * 5 m room measured 38.7 units on the scan:room lane), so a surround room is never assumed to be
 * in metres: unless the person sets a scale, the room's longest side is fitted to ROOM_FIT_UNITS.
 */
export const BG_EXTENT_PREDICATE = META + 'background-extent';
/** F58.9.16: the room's focal point, "x y z" in room units from its centre. */
export const BG_FOCAL_PREDICATE = META + 'background-focal';
export const ROOM_FIT_UNITS = 10;

/** backdrop: a dimmed scene behind the graph, sized to it. surround: the graph sits INSIDE the room, which keeps its own scale. */
export type BackgroundMode = 'backdrop' | 'surround';
export const UP_AXES = ['+y', '-y', '+z', '-z', '+x', '-x'] as const;
export type UpAxis = (typeof UP_AXES)[number];
export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export interface BackgroundSettings {
  mode: BackgroundMode;
  /** Which of the FILE's axes points up. */
  up: UpAxis;
  /** Degrees about the vertical, after levelling. */
  yaw: number;
  /** Floor-levelling correction (a quaternion), or null. Set by Level the floor, never typed. */
  level: Quat | null;
  /** Backdrop: multiplier on the automatic size. Surround: world units per file unit. */
  scale: number;
  /** World offset of the room's centre from the graph's centre. */
  offset: Vec3;
  opacity: number;
  /** Height of the levelled floor above the room centre, in room units; null until Level the floor finds one. */
  floor: number | null;
  /** Measured extent of the scan in file units, or null (null when the file could not be measured). */
  extent: number | null;
  /**
   * The focal point (F58.9.16): the point of the room, in room units from its centre, that sits at the
   * graph's centre. [0,0,0] is the room's own centre. Set by clicking in the 3D view, never typed.
   */
  focal: Vec3;
}

export const BACKGROUND_DEFAULTS: BackgroundSettings = { mode: 'backdrop', up: '+y', yaw: 0, level: null, scale: 1, offset: [0, 0, 0], opacity: 0.5, floor: null, extent: null, focal: [0, 0, 0] };

const nums = (v: string, n: number): number[] | null => {
  const a = v.trim().split(/[\s,]+/).map(Number);
  return a.length === n && a.every(Number.isFinite) ? a : null;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The space's background settings. The newest live value of each wins; anything malformed falls back to its default. */
export function backgroundSettingsFrom(statements: readonly Statement[]): BackgroundSettings {
  const newest = new Map<string, Statement>();
  const wanted = new Set([BG_MODE_PREDICATE, BG_UP_PREDICATE, BG_YAW_PREDICATE, BG_LEVEL_PREDICATE, BG_SCALE_PREDICATE, BG_OFFSET_PREDICATE, BG_OPACITY_PREDICATE, BG_FLOOR_PREDICATE, BG_EXTENT_PREDICATE, BG_FOCAL_PREDICATE]);
  for (const s of statements) {
    if (s.s.value !== SPACE_SUBJECT || !wanted.has(s.p.value) || s.o.kind !== 'literal' || !live(s)) continue;
    const prev = newest.get(s.p.value);
    if (!prev || (s.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) newest.set(s.p.value, s);
  }
  const val = (p: string) => newest.get(p)?.o.value;
  const d = BACKGROUND_DEFAULTS;
  const mode = val(BG_MODE_PREDICATE);
  const up = val(BG_UP_PREDICATE);
  const yaw = Number(val(BG_YAW_PREDICATE));
  const scale = Number(val(BG_SCALE_PREDICATE));
  const opacity = Number(val(BG_OPACITY_PREDICATE));
  const offset = nums(val(BG_OFFSET_PREDICATE) ?? '', 3);
  const level = nums(val(BG_LEVEL_PREDICATE) ?? '', 4);
  const focal = nums(val(BG_FOCAL_PREDICATE) ?? '', 3);
  const extentRaw = val(BG_EXTENT_PREDICATE) === undefined ? NaN : Number(val(BG_EXTENT_PREDICATE));
  const extent = Number.isFinite(extentRaw) && extentRaw > 0 ? extentRaw : null;
  const floor = val(BG_FLOOR_PREDICATE) === undefined ? NaN : Number(val(BG_FLOOR_PREDICATE));
  const resolvedMode: BackgroundMode = mode === 'surround' || mode === 'backdrop' ? mode : d.mode;
  return {
    mode: resolvedMode,
    up: (UP_AXES as readonly string[]).includes(up ?? '') ? (up as UpAxis) : d.up,
    yaw: Number.isFinite(yaw) && val(BG_YAW_PREDICATE) !== undefined ? yaw : d.yaw,
    level: level ? qNormalize(level as Quat) : null,
    floor: Number.isFinite(floor) ? clamp(floor, -1e4, 1e4) : null,
    // Unset scale: a surround room is fitted to ROOM_FIT_UNITS by its measured extent; never assumed to be metres.
    scale: Number.isFinite(scale) && scale > 0 && val(BG_SCALE_PREDICATE) !== undefined ? clamp(scale, 0.001, 1000) : resolvedMode === 'surround' && extent ? clamp(ROOM_FIT_UNITS / extent, 0.001, 1000) : d.scale,
    extent,
    offset: offset ? (offset.map((x) => clamp(x, -1e4, 1e4)) as Vec3) : d.offset,
    focal: focal ? (focal.map((x) => clamp(x, -1e4, 1e4)) as Vec3) : d.focal,
    // Unset opacity: a backdrop is dimmed so labels stay readable; a room you are inside is not.
    opacity: Number.isFinite(opacity) && val(BG_OPACITY_PREDICATE) !== undefined ? clamp(opacity, 0, 1) : resolvedMode === 'surround' ? 1 : d.opacity,
  };
}

// Quaternions are [x, y, z, w]. Only what the settings need; THREE does the rendering.
export function qNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}
export function qAboutY(degrees: number): Quat {
  const h = (degrees * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}
/** The shortest rotation taking unit vector `a` to unit vector `b`. */
export function qBetween(a: Vec3, b: Vec3): Quat {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot > 0.999999) return [0, 0, 0, 1];
  if (dot < -0.999999) {
    // Antiparallel: a half turn about any axis perpendicular to a.
    const perp: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ax = [a[1] * perp[2] - a[2] * perp[1], a[2] * perp[0] - a[0] * perp[2], a[0] * perp[1] - a[1] * perp[0]];
    const n = Math.hypot(ax[0], ax[1], ax[2]);
    return [ax[0] / n, ax[1] / n, ax[2] / n, 0];
  }
  return qNormalize([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + dot]);
}

const AXIS_VECTORS: Record<UpAxis, Vec3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
/** The rotation that makes the file's chosen up axis point up (+y). */
export const upAxisQuaternion = (up: UpAxis): Quat => qBetween(AXIS_VECTORS[up], [0, 1, 0]);

/** The fixed turn createNormalizedSplat gives a TripoSplat file (Euler XYZ: pi about x, then pi/2 about y). */
export const TRIPOSPLAT_BASE: Quat = qMul([1, 0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]);

/** The whole orientation of the room: up axis first, then the floor level, then the yaw about the vertical. */
export function backgroundQuaternion(s: Pick<BackgroundSettings, 'up' | 'level' | 'yaw'>): Quat {
  let q = upAxisQuaternion(s.up);
  if (s.level) q = qMul(s.level, q);
  return qNormalize(qMul(qAboutY(s.yaw), q));
}

export interface FloorFit {
  /** Unit normal of the dominant near-horizontal plane, pointing up (y >= 0). */
  normal: Vec3;
  /** Plane offset: normal · p = offset. */
  offset: number;
  /** Sampled points within the threshold of the plane. */
  inliers: number;
  /** inliers / points sampled. */
  fraction: number;
  /** Degrees between the plane normal and +y: what levelling removes. */
  tiltDeg: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Smallest-eigenvalue eigenvector of a symmetric 3x3 (cyclic Jacobi). */
function smallestEigenvector(m: number[][]): Vec3 {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best]];
}

/**
 * Fit the dominant near-horizontal plane to Gaussian centres already expressed with y up (RANSAC on
 * three-point planes whose normal is within `maxTiltDeg` of +y, refined by PCA of the inliers).
 * A floor, or a ceiling: both are horizontal, and levelling only needs the tilt. Deterministic for
 * a given seed. Returns null when there are too few points or no plane holds a tenth of them.
 */
export function fitFloor(points: ArrayLike<number>, opts: { iterations?: number; maxTiltDeg?: number; seed?: number; threshold?: number } = {}): FloorFit | null {
  const n = Math.floor(points.length / 3);
  if (n < 30) return null;
  const maxTilt = opts.maxTiltDeg ?? 35;
  const minCos = Math.cos((maxTilt * Math.PI) / 180);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const x = points[i * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(diag > 0)) return null;
  const thr = opts.threshold ?? diag * 0.01;
  const rand = rng(opts.seed ?? 1);
  const count = (nx: number, ny: number, nz: number, d: number) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (Math.abs(nx * points[i * 3] + ny * points[i * 3 + 1] + nz * points[i * 3 + 2] - d) < thr) c++;
    return c;
  };
  let best: { n: Vec3; d: number; c: number } | null = null;
  for (let it = 0; it < (opts.iterations ?? 300); it++) {
    const i = Math.floor(rand() * n), j = Math.floor(rand() * n), k = Math.floor(rand() * n);
    if (i === j || j === k || i === k) continue;
    const ux = points[j * 3] - points[i * 3], uy = points[j * 3 + 1] - points[i * 3 + 1], uz = points[j * 3 + 2] - points[i * 3 + 2];
    const vx = points[k * 3] - points[i * 3], vy = points[k * 3 + 1] - points[i * 3 + 1], vz = points[k * 3 + 2] - points[i * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny < minCos) continue;
    const d = nx * points[i * 3] + ny * points[i * 3 + 1] + nz * points[i * 3 + 2];
    const c = count(nx, ny, nz, d);
    if (!best || c > best.c) best = { n: [nx, ny, nz], d, c };
  }
  if (!best) return null;
  // Refine: PCA of the inliers (the normal is the direction of least variance).
  const inl: number[] = [];
  for (let i = 0; i < n; i++) if (Math.abs(best.n[0] * points[i * 3] + best.n[1] * points[i * 3 + 1] + best.n[2] * points[i * 3 + 2] - best.d) < thr) inl.push(i);
  if (inl.length >= 3) {
    const mean = [0, 0, 0];
    for (const i of inl) for (let k = 0; k < 3; k++) mean[k] += points[i * 3 + k] / inl.length;
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of inl) {
      const dv = [points[i * 3] - mean[0], points[i * 3 + 1] - mean[1], points[i * 3 + 2] - mean[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += dv[r] * dv[c];
    }
    let [nx, ny, nz] = smallestEigenvector(cov);
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny >= minCos) {
      const d = nx * mean[0] + ny * mean[1] + nz * mean[2];
      const c = count(nx, ny, nz, d);
      if (c >= best.c) best = { n: [nx, ny, nz], d, c };
    }
  }
  const fraction = best.c / n;
  if (fraction < 0.1) return null;
  return { normal: best.n, offset: best.d, inliers: best.c, fraction, tiltDeg: (Math.acos(clamp(best.n[1], -1, 1)) * 180) / Math.PI };
}

/** Rotate a flat xyz array by `q` (new array). */
export function rotatePoints(points: ArrayLike<number>, q: Quat): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    const r = qRotate(q, [points[i], points[i + 1], points[i + 2]]);
    out[i] = r[0]; out[i + 1] = r[1]; out[i + 2] = r[2];
  }
  return out;
}

/** The levelling correction for a fitted floor: the rotation that takes its normal to +y. */
export const levelQuaternion = (fit: Pick<FloorFit, 'normal'>): Quat => qBetween(fit.normal, [0, 1, 0]);

// ── Placement (F58.9.9) ──────────────────────────────────────────────────────
//
// A node with a splat can be put at a place in the room. Coordinates are ROOM units in the room's
// own frame: up is +y (after the up axis and the floor level), the origin is the room's centre, and
// the frame turns with the space's yaw setting, so changing the yaw carries placed things with it.
// World = room centre + yaw(at * scale). Placement is a setting of the space, not a fact about the
// thing, so these are meta predicates on the node and never edges. Only a SURROUND room has a fixed
// scale to place in; a backdrop is resized to the graph every frame.

export const PLACED_AT_PREDICATE = META + 'placed-at';
export const PLACED_SCALE_PREDICATE = META + 'placed-scale';
export const PLACED_YAW_PREDICATE = META + 'placed-yaw';
/** Height of the levelled floor above the room's centre, in room units (negative = below). Set by Level the floor. */
export const BG_FLOOR_PREDICATE = META + 'background-floor';

export interface Placement {
  at: Vec3;
  /** The placed splat's radius, in room units. */
  scale: number;
  /** Degrees about the vertical, in the room's frame. */
  yaw: number;
}

export const DEFAULT_PLACED_SCALE = 1;

/** Node IRI to placement, from the node's live placed-at (with its optional scale and yaw). */
export function placementsFrom(statements: readonly Statement[]): Map<string, Placement> {
  const newest = new Map<string, Statement>();
  const keep = (s: Statement) => { const k = s.s.value + '|' + s.p.value; const prev = newest.get(k); if (!prev || (s.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) newest.set(k, s); };
  for (const s of statements) {
    if (s.s.kind !== 'iri' || s.o.kind !== 'literal' || !live(s)) continue;
    if (s.p.value === PLACED_AT_PREDICATE || s.p.value === PLACED_SCALE_PREDICATE || s.p.value === PLACED_YAW_PREDICATE) keep(s);
  }
  const out = new Map<string, Placement>();
  for (const s of newest.values()) {
    if (s.p.value !== PLACED_AT_PREDICATE) continue;
    const at = nums(s.o.value, 3);
    if (!at) continue;
    const sc = Number(newest.get(s.s.value + '|' + PLACED_SCALE_PREDICATE)?.o.value);
    const yaw = Number(newest.get(s.s.value + '|' + PLACED_YAW_PREDICATE)?.o.value);
    out.set(s.s.value, {
      at: at.map((x) => clamp(x, -1e4, 1e4)) as Vec3,
      scale: Number.isFinite(sc) && sc > 0 ? clamp(sc, 0.02, 1000) : DEFAULT_PLACED_SCALE,
      yaw: Number.isFinite(yaw) ? yaw : 0,
    });
  }
  return out;
}

export interface RoomFrame {
  /** World position of the room's centre. */
  centre: Vec3;
  /** World units per room unit (the space's scale setting). */
  scale: number;
  /** The space's yaw setting, degrees. */
  yaw: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Where a placement is in the world, how big its splat is drawn, and how it is turned. */
export function placementWorld(p: Placement, room: RoomFrame): { pos: Vec3; radius: number; yaw: number } {
  const r = qRotate(qAboutY(room.yaw), [p.at[0] * room.scale, p.at[1] * room.scale, p.at[2] * room.scale]);
  return { pos: [room.centre[0] + r[0], room.centre[1] + r[1], room.centre[2] + r[2]], radius: p.scale * room.scale, yaw: p.yaw + room.yaw };
}

/** The inverse of placementWorld's position: a world point in room coordinates. */
export function worldToRoom(world: Vec3, room: RoomFrame): Vec3 {
  const d: Vec3 = [world[0] - room.centre[0], world[1] - room.centre[1], world[2] - room.centre[2]];
  const r = qRotate(qAboutY(-room.yaw), d);
  return [round3(r[0] / room.scale), round3(r[1] / room.scale), round3(r[2] / room.scale)];
}

export interface RoomView {
  camera: Vec3;
  target: Vec3;
  /** Floor height above the room centre in room units, or null when Level the floor has not found one. */
  floor: number | null;
}

/**
 * Where "Place in room" puts a new thing: half way from the camera toward what it looks at, on the
 * floor (its radius above it, so it stands rather than sinks). Without a known floor it sits at the
 * room's mid height, and the caller says so.
 */
export function defaultPlacement(view: RoomView, room: RoomFrame, scale = DEFAULT_PLACED_SCALE): Placement {
  const mid: Vec3 = [(view.camera[0] + view.target[0]) / 2, room.centre[1], (view.camera[2] + view.target[2]) / 2];
  const local = worldToRoom(mid, room);
  return { at: [local[0], round3(view.floor === null ? 0 : view.floor + scale), local[2]], scale, yaw: 0 };
}

export type PlacementOp =
  | { kind: 'move'; dx?: number; dy?: number; dz?: number }
  | { kind: 'turn'; degrees: number }
  | { kind: 'scale'; factor: number };

/** One adjustment step, pure. Rounded so the stored triple stays readable. */
export function adjustPlacement(p: Placement, op: PlacementOp): Placement {
  if (op.kind === 'move') return { ...p, at: [round3(p.at[0] + (op.dx ?? 0)), round3(p.at[1] + (op.dy ?? 0)), round3(p.at[2] + (op.dz ?? 0))] };
  if (op.kind === 'turn') return { ...p, yaw: round3((((p.yaw + op.degrees + 180) % 360) + 360) % 360 - 180) };
  return { ...p, scale: round3(clamp(p.scale * op.factor, 0.02, 1000)) };
}

export const formatPlacementAt = (at: Vec3): string => at.map(round3).join(' ');
