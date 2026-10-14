/**
 * A SYNTHETIC room as a Gaussian splat (F58.9.10 / kb:room-scene-space).
 *
 * This is not a scan of anywhere. It is a made-up room, written by this script from arithmetic: a
 * wooden floor, three walls (the fourth side is open so the camera can look in), and four coloured
 * blocks standing for a sofa, a table, a shelf and a rug. It exists so the "Your room" space works
 * before anyone has scanned theirs, and so the import, surround, level and place paths have a room
 * to be tested against. It is labelled synthetic in its receipt, in the space, and in the node.
 *
 * Deterministic: the same seed writes the same bytes. Y is up, one unit is one metre, the floor is
 * at y = 0, the room is 5 m wide (x), 4 m deep (z, open at +z) and 2.6 m high.
 *
 *   npx tsx scripts/content/synthetic-room.ts          write static/generated/synthetic-room/
 *   npx tsx scripts/content/synthetic-room.ts --check  verify the committed file is what this writes
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeSplatPly, REQUIRED_SPLAT_PROPS } from '../../src/lib/3d/splat-check';

export const SEED = 7;
const SH_C0 = 0.28209479177387814;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type RGB = [number, number, number];
interface G { p: [number, number, number]; s: [number, number, number]; c: RGB }

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The Gaussians of the room, in a fixed order. */
export function roomGaussians(seed = SEED): G[] {
  const rand = mulberry32(seed);
  const out: G[] = [];
  const jitter = (c: RGB, amount = 0.05): RGB => c.map((v) => Math.min(1, Math.max(0, v + (rand() - 0.5) * amount))) as RGB;

  // A flat patch of Gaussians: n of them over a rectangle, each a thin disc lying in the patch.
  const patch = (n: number, origin: [number, number, number], u: [number, number, number], v: [number, number, number], normal: 'x' | 'y' | 'z', colour: (a: number, b: number) => RGB) => {
    const area = Math.hypot(...u) * Math.hypot(...v);
    const r = Math.sqrt(area / n) * 0.75;
    const thin = 0.01;
    for (let i = 0; i < n; i++) {
      const a = rand(), b = rand();
      out.push({
        p: [origin[0] + u[0] * a + v[0] * b, origin[1] + u[1] * a + v[1] * b, origin[2] + u[2] * a + v[2] * b],
        s: normal === 'x' ? [thin, r, r] : normal === 'y' ? [r, thin, r] : [r, r, thin],
        c: colour(a, b),
      });
    }
  };

  const W = 5, D = 4, H = 2.6;
  const wood: RGB = [0.62, 0.45, 0.28], woodDark: RGB = [0.5, 0.35, 0.21];
  // Floor: planks running along z.
  patch(3400, [-W / 2, 0, -D / 2], [W, 0, 0], [0, 0, D], 'y', (a) => jitter(mix(wood, woodDark, Math.floor(a * 14) % 2 ? 0.8 : 0.1), 0.06));
  // Walls: warm plaster, a darker skirting along the bottom.
  const plaster: RGB = [0.88, 0.84, 0.76], skirt: RGB = [0.45, 0.4, 0.34];
  patch(1500, [-W / 2, 0, -D / 2], [W, 0, 0], [0, H, 0], 'z', (_, b) => jitter(b < 0.06 ? skirt : plaster, 0.04)); // back wall
  patch(1100, [-W / 2, 0, -D / 2], [0, 0, D], [0, H, 0], 'x', (_, b) => jitter(b < 0.06 ? skirt : mix(plaster, [0.78, 0.84, 0.88], 0.5), 0.04)); // left wall
  patch(1100, [W / 2, 0, -D / 2], [0, 0, D], [0, H, 0], 'x', (_, b) => jitter(b < 0.06 ? skirt : mix(plaster, [0.78, 0.84, 0.88], 0.5), 0.04)); // right wall

  // A solid block: Gaussians on its five visible faces (no underside), in proportion to area.
  const block = (n: number, c: [number, number, number], size: [number, number, number], colour: RGB) => {
    const [cx, cy, cz] = c, [sx, sy, sz] = size;
    const faces: { area: number; make: (a: number, b: number) => [number, number, number]; normal: 'x' | 'y' | 'z' }[] = [
      { area: sx * sz, normal: 'y', make: (a, b) => [cx - sx / 2 + a * sx, cy + sy / 2, cz - sz / 2 + b * sz] },
      { area: sy * sz, normal: 'x', make: (a, b) => [cx - sx / 2, cy - sy / 2 + a * sy, cz - sz / 2 + b * sz] },
      { area: sy * sz, normal: 'x', make: (a, b) => [cx + sx / 2, cy - sy / 2 + a * sy, cz - sz / 2 + b * sz] },
      { area: sx * sy, normal: 'z', make: (a, b) => [cx - sx / 2 + a * sx, cy - sy / 2 + b * sy, cz - sz / 2] },
      { area: sx * sy, normal: 'z', make: (a, b) => [cx - sx / 2 + a * sx, cy - sy / 2 + b * sy, cz + sz / 2] },
    ];
    const total = faces.reduce((t, f) => t + f.area, 0);
    for (const f of faces) {
      const count = Math.max(8, Math.round((n * f.area) / total));
      const r = Math.sqrt(f.area / count) * 0.75;
      for (let i = 0; i < count; i++) {
        const shade = f.normal === 'y' ? 1 : f.normal === 'x' ? 0.82 : 0.9; // the top is lit, the sides are not
        out.push({
          p: f.make(rand(), rand()),
          s: f.normal === 'x' ? [0.01, r, r] : f.normal === 'y' ? [r, 0.01, r] : [r, r, 0.01],
          c: jitter(colour.map((v) => v * shade) as RGB, 0.05),
        });
      }
    }
  };
  block(760, [-1.3, 0.25, -1.45], [1.7, 0.5, 0.75], [0.2, 0.52, 0.55]); // sofa (teal)
  block(520, [1.0, 0.2, -0.3], [0.9, 0.4, 0.9], [0.86, 0.5, 0.18]); // low table (orange)
  block(640, [2.25, 0.9, -1.0], [0.4, 1.8, 1.3], [0.45, 0.3, 0.6]); // shelf (purple)
  // A rug: a flat patch just above the floor.
  patch(520, [-0.9, 0.012, 0.2], [1.8, 0, 0], [0, 0, 1.3], 'y', (a, b) => jitter(Math.floor(a * 8) % 2 === Math.floor(b * 6) % 2 ? [0.7, 0.2, 0.22] : [0.85, 0.7, 0.55], 0.04));
  return out;
}

/** Serialise as a binary little-endian 3DGS PLY with exactly the required properties. */
export function writePly(gs: G[]): Uint8Array {
  const props = REQUIRED_SPLAT_PROPS;
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${gs.length}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const head = new TextEncoder().encode(header);
  const body = new DataView(new ArrayBuffer(gs.length * props.length * 4));
  const opacity = Math.log(0.97 / 0.03); // logit of 0.97
  gs.forEach((g, i) => {
    const v = [
      g.p[0], g.p[1], g.p[2],
      (g.c[0] - 0.5) / SH_C0, (g.c[1] - 0.5) / SH_C0, (g.c[2] - 0.5) / SH_C0,
      opacity,
      Math.log(g.s[0]), Math.log(g.s[1]), Math.log(g.s[2]),
      1, 0, 0, 0,
    ];
    v.forEach((x, k) => body.setFloat32((i * props.length + k) * 4, x, true));
  });
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head, 0);
  bytes.set(new Uint8Array(body.buffer), head.length);
  return bytes;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'static/generated/synthetic-room');

export function buildRoom(seed = SEED) {
  const bytes = writePly(roomGaussians(seed));
  const check = judgeSplatPly(bytes);
  const receipt = {
    slug: 'synthetic-room',
    kind: 'synthetic',
    label: 'A made-up room (synthetic)',
    generated: false,
    note: 'Written from arithmetic by scripts/content/synthetic-room.ts. Not a scan of any place, and not made by a model.',
    generator: 'scripts/content/synthetic-room.ts',
    seed,
    units: 'metres, y up, floor at y = 0, open at +z',
    output: { file: 'splat.ply', sha256: sha256(bytes), bytes: bytes.length },
    check: { pass: check.pass, problems: check.problems, measured: check.measured },
  };
  return { bytes, receipt, check };
}

function main() {
  const { bytes, receipt, check } = buildRoom();
  if (!check.pass) { console.error('synthetic room failed its own check:', check.problems.join('; ')); process.exit(1); }
  if (process.argv.includes('--check')) {
    const file = join(OUT, 'splat.ply');
    const same = existsSync(file) && sha256(readFileSync(file)) === receipt.output.sha256;
    console.log(same ? `✓ synthetic-room/splat.ply is what this script writes (${receipt.output.bytes} bytes)` : '✗ synthetic-room/splat.ply differs from what this script writes');
    process.exit(same ? 0 : 1);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'splat.ply'), bytes);
  writeFileSync(join(OUT, 'synthetic.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`wrote ${OUT}: ${JSON.stringify(check.measured)}, ${bytes.length} bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
