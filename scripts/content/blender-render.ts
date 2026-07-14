#!/usr/bin/env npx tsx
/**
 * Headless Blender render (F90 / kb:content-orchestration) — the scene is a GRAPH.
 *
 * Coding orchestration was the easy case: `done-when` is a command with an exit code. Content
 * generation is where that breaks, and this module is built around the break rather than
 * pretending it isn't there:
 *
 *   BLENDER WILL RENDER A BLACK FRAME AND EXIT 0.
 *
 * So a render is NOT done because Blender succeeded. It is done because an independent check
 * confirms the image is actually an image — non-empty, not a single flat colour. That check
 * (checkImage) is the whole point, and it is deterministic, script-tier, and cheap: it catches
 * the entire black-frame / empty-scene / 0-byte class before any VLM or human is troubled.
 *
 * THE SCENE IS DESCRIBED IN THE GRAPH, and the Blender .py is GENERATED from it. A generated
 * .blend or .py is a derived artifact; the scene entities are the source. That is what gives an
 * asset provenance — you can ask why a thing is the colour it is, diff two scenes, and
 * regenerate from something a human can read instead of a binary blob.
 *
 * LOCAL BY DEFAULT, and the reason is the thesis, not thrift: a cloud renderer means your
 * unreleased work sits on someone else's disk. Blender is free, offline, and on your machine.
 *
 * Usage:
 *   npx tsx scripts/content/blender-render.ts --scene scene.json --out render.png
 *   npx tsx scripts/content/blender-render.ts --check render.png     just run the acceptance check
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'fs';
import { inflateSync } from 'zlib';
import { tmpdir } from 'os';
import path from 'path';

// ── Scene model ──────────────────────────────────────────────────────────────
// A minimal, deterministic scene. This is what a graph's ktype:Scene subgraph resolves to;
// here it is the plain object so the renderer can be tested without the app.
export interface SceneObject {
  shape: 'cube' | 'sphere' | 'cylinder' | 'cone';
  /** [x, y, z] */
  location?: [number, number, number];
  /** [x, y, z] radians */
  rotation?: [number, number, number];
  scale?: number;
  /** [r, g, b] 0..1 */
  color?: [number, number, number];
}
export interface Scene {
  objects: SceneObject[];
  /** Solid background colour [r,g,b] 0..1. Default dark grey — NOT black, so a truly empty
   *  render is distinguishable from a black one. */
  background?: [number, number, number];
  camera?: { location?: [number, number, number]; look_at?: [number, number, number] };
  resolution?: [number, number];
  samples?: number;
}

/**
 * Generate the Blender Python from a scene. Deterministic: the same scene produces the same
 * script, byte for byte, so a render is reproducible and diffable.
 *
 * Cycles on CPU, low samples — headless-reliable everywhere, no GPU context needed. The point
 * is a correct picture fast, not a beauty shot.
 */
export function sceneToPython(scene: Scene, outPath: string): string {
  const bg = scene.background ?? [0.05, 0.05, 0.06];
  const [rw, rh] = scene.resolution ?? [256, 256];
  const cam = scene.camera?.location ?? [4, -4, 3];
  const look = scene.camera?.look_at ?? [0, 0, 0];
  const py = `
import bpy, math, mathutils

# Clean slate — an empty default scene, deterministically.
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = ${Math.max(1, Math.min(scene.samples ?? 16, 128))}
scene.render.resolution_x = ${rw}
scene.render.resolution_y = ${rh}
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = ${JSON.stringify(outPath)}

# World background — a solid colour we KNOW, so an empty render is not mistaken for a valid one.
world = bpy.data.worlds.new("W"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (${bg[0]}, ${bg[1]}, ${bg[2]}, 1.0)

def mat(rgb):
    m = bpy.data.materials.new("m"); m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf: bsdf.inputs[0].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    return m

${scene.objects
    .map((o, i) => {
      const loc = o.location ?? [0, 0, 0];
      const rot = o.rotation ?? [0, 0, 0];
      const s = o.scale ?? 1;
      const col = o.color ?? [0.8, 0.3, 0.2];
      const add =
        o.shape === 'sphere'
          ? 'bpy.ops.mesh.primitive_uv_sphere_add'
          : o.shape === 'cylinder'
            ? 'bpy.ops.mesh.primitive_cylinder_add'
            : o.shape === 'cone'
              ? 'bpy.ops.mesh.primitive_cone_add'
              : 'bpy.ops.mesh.primitive_cube_add';
      return `${add}(location=(${loc[0]}, ${loc[1]}, ${loc[2]}))
obj${i} = bpy.context.active_object
obj${i}.rotation_euler = (${rot[0]}, ${rot[1]}, ${rot[2]})
obj${i}.scale = (${s}, ${s}, ${s})
obj${i}.data.materials.append(mat((${col[0]}, ${col[1]}, ${col[2]})))`;
    })
    .join('\n')}

# Light
light_data = bpy.data.lights.new("L", type='SUN'); light_data.energy = 3.0
light = bpy.data.objects.new("L", light_data); scene.collection.objects.link(light)
light.location = (5, -5, 8); light.rotation_euler = (0.6, 0.1, 0.8)

# Camera, aimed at look_at.
cam_data = bpy.data.cameras.new("C")
cam = bpy.data.objects.new("C", cam_data); scene.collection.objects.link(cam)
cam.location = (${cam[0]}, ${cam[1]}, ${cam[2]})
d = mathutils.Vector((${look[0]}, ${look[1]}, ${look[2]})) - cam.location
cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam

bpy.ops.render.render(write_still=True)
`;
  return py;
}

function blenderBin(): string {
  for (const c of ['blender', '/snap/bin/blender', '/usr/bin/blender']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('Blender not found. Install it (snap install blender) — it is local and free.');
}

export interface RenderResult {
  ok: boolean;
  outPath: string;
  check: ImageCheck;
  blenderExit: number;
}

/** Render a scene to a PNG, then VERIFY the PNG is a real image. */
export function render(scene: Scene, outPath: string): RenderResult {
  const bin = blenderBin();
  const dir = mkdtempSync(path.join(tmpdir(), 'blender-'));
  const script = path.join(dir, 'scene.py');
  writeFileSync(script, sceneToPython(scene, outPath));

  let blenderExit = 0;
  try {
    execFileSync(bin, ['--background', '--factory-startup', '--python', script], {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
    });
  } catch (e: any) {
    blenderExit = typeof e?.status === 'number' ? e.status : 1;
  }

  // The acceptance criterion. Blender's exit code is NOT it — a black frame exits 0.
  const check = checkImage(outPath);
  return { ok: check.ok, outPath, check, blenderExit };
}

// ── The black-frame guard — this is the F88 verifiability piece ────────────────
export interface ImageCheck {
  ok: boolean;
  reason: string;
  bytes: number;
  /** Fraction of ACTUAL PIXELS that differ from the first — 0 means one flat colour. */
  variation: number;
}

/**
 * Decode a PNG to raw pixel bytes (dependency-free, node:zlib). Supports the 8-bit RGB / RGBA
 * / grayscale that Blender writes. Returns null for anything it does not understand — better
 * to say "cannot verify" than to guess.
 *
 * THIS EXISTS BECAUSE THE FIRST VERSION SAMPLED COMPRESSED BYTES and called that "variation".
 * A flat black PNG still has varied zlib/filter bytes, so the guard reported a black frame as
 * "✓ real image (variation 0.984)". It measured compression, not content — the exact
 * confidently-wrong-checker failure it was built to prevent. You cannot check the picture
 * without decoding the picture.
 */
function decodePngPixels(buf: Buffer): { pixels: Buffer; channels: number } | null {
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;

  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  if (bitDepth !== 8 || width === 0 || height === 0) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (channels === 0) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  // Un-filter scanlines. Each row is prefixed by a filter-type byte (0=None,1=Sub,2=Up,3=Avg,4=Paeth).
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = rowIn[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { pixels: out, channels };
}

/**
 * Is this file actually an image, and does it actually show something?
 *
 *   1. no file / empty      → Blender never wrote it.
 *   2. not a decodable PNG   → not the render we asked for (or a format we cannot verify).
 *   3. one flat colour       → the BLACK FRAME. Rendered "successfully", shows nothing. This is
 *                              the one an exit code cannot catch, and the reason this exists.
 *
 * Deterministic, decodes real pixels, no library. "variation" is the fraction of sampled
 * pixels whose luminance differs from the first — a real render is ~1.0, a flat frame ~0.
 */
export function checkImage(file: string): ImageCheck {
  if (!existsSync(file)) return { ok: false, reason: 'no file — Blender never wrote a render', bytes: 0, variation: 0 };
  const buf = readFileSync(file);
  const bytes = buf.length;
  if (bytes < 100) return { ok: false, reason: `file is ${bytes} bytes — effectively empty`, bytes, variation: 0 };

  const decoded = decodePngPixels(buf);
  if (!decoded) return { ok: false, reason: 'not a decodable 8-bit PNG — cannot verify it is a real image', bytes, variation: 0 };

  const { pixels, channels } = decoded;
  const lum = (i: number) => pixels[i] * 0.3 + pixels[i + Math.min(1, channels - 1)] * 0.59 + pixels[i + Math.min(2, channels - 1)] * 0.11;

  // "variation" = the fraction of pixels that are NOT the dominant colour. Measured against the
  // DOMINANT value, not the first pixel — the first-pixel version had a real bug: a black frame
  // with a single stray white pixel in the top-left corner read as "everything differs from the
  // (white) first pixel", i.e. 100% varied, i.e. a pass. The question is "does the image show
  // something", and a lone bright pixel on black does not. Bucket luminance, find the biggest
  // bucket, and see how much lies outside it.
  const BINS = 16;
  const hist = new Array(BINS).fill(0);
  let sampled = 0;
  const step = channels * Math.max(1, Math.floor(pixels.length / channels / 4000));
  for (let i = 0; i + channels <= pixels.length; i += step) {
    sampled++;
    hist[Math.min(BINS - 1, Math.floor((lum(i) / 256) * BINS))]++;
  }
  const dominant = Math.max(...hist);
  const variation = sampled ? 1 - dominant / sampled : 0;

  // A genuine render varies substantially. A flat colour barely varies. Threshold is low so a
  // real-but-simple image is never rejected — only the truly flat frame.
  if (variation < 0.02) {
    return { ok: false, reason: `nearly uniform (variation ${variation.toFixed(3)}) — a flat/black frame that rendered "successfully" and shows nothing`, bytes, variation };
  }
  return { ok: true, reason: `real image (${bytes} bytes, ${(variation * 100).toFixed(0)}% of pixels vary)`, bytes, variation };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('blender-render.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const checkOnly = flag('check');
  if (checkOnly) {
    const c = checkImage(checkOnly);
    console.log(`${c.ok ? '✓' : '✗'} ${c.reason}`);
    process.exit(c.ok ? 0 : 1);
  }

  const sceneFile = flag('scene');
  const out = flag('out') ?? 'render.png';
  if (!sceneFile) {
    console.error('Usage: --scene scene.json --out render.png   (or --check image.png)');
    process.exit(2);
  }
  const scene: Scene = JSON.parse(readFileSync(sceneFile, 'utf8'));
  console.log(`Rendering ${scene.objects.length} object(s) → ${out} …`);
  const r = render(scene, out);
  console.log(`  Blender exit: ${r.blenderExit}`);
  console.log(`  ${r.check.ok ? '✓' : '✗'} ${r.check.reason}`);
  if (!r.ok) console.log(`  A green Blender exit is not a good image — this failed the acceptance check.`);
  process.exit(r.ok ? 0 : 1);
}
