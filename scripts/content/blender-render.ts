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
 * The same argument applies to GLB export, which is why it lives here rather than in its own
 * module: `bpy.ops.export_scene.gltf` will write a well-formed, entirely EMPTY .glb and exit 0.
 * So export has its own deterministic guard (checkGlb) that opens the container and counts real
 * vertices. Same rule as the black frame, different file format.
 *
 * Usage:
 *   npx tsx scripts/content/blender-render.ts --scene scene.json --out render.png
 *   npx tsx scripts/content/blender-render.ts --scene scene.json --out node.glb --format glb
 *   npx tsx scripts/content/blender-render.ts --check render.png     just run the acceptance check
 *   npx tsx scripts/content/blender-render.ts --check node.glb       (dispatches on extension)
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'fs';
import { inflateSync } from 'zlib';
import { tmpdir } from 'os';
import path from 'path';

// ── Scene model ──────────────────────────────────────────────────────────────
// A minimal, deterministic scene. This is what a graph's ktype:Scene subgraph resolves to;
// here it is the plain object so the renderer can be tested without the app.
export type SceneShape = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'ico';

export interface SceneObject {
  shape: SceneShape;
  /** [x, y, z] */
  location?: [number, number, number];
  /** [x, y, z] radians */
  rotation?: [number, number, number];
  scale?: number;
  /** [r, g, b] 0..1 */
  color?: [number, number, number];
  /** Subdivision level for `ico` (0 = 20 triangles). Clamped 0..3 — this is a NODE, not a hero
   *  asset, and every subdivision quadruples the vertex count the browser has to draw. */
  subdivisions?: number;
  /** Ring radii for `torus`. Defaults to a chunky, clearly-holed ring. */
  majorRadius?: number;
  minorRadius?: number;
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

export type OutputFormat = 'png' | 'glb';

/**
 * The Blender primitive op for a shape, with its shape-specific arguments baked in.
 *
 * Kept as one function so the shape vocabulary has exactly ONE definition. `location=` is
 * appended by the caller, which is why every branch ends mid-call.
 */
function primitiveCall(o: SceneObject): string {
  switch (o.shape) {
    case 'sphere':
      return 'bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, ';
    case 'cylinder':
      return 'bpy.ops.mesh.primitive_cylinder_add(vertices=12, ';
    case 'cone':
      return 'bpy.ops.mesh.primitive_cone_add(vertices=8, ';
    case 'torus':
      return `bpy.ops.mesh.primitive_torus_add(major_segments=16, minor_segments=8, major_radius=${o.majorRadius ?? 1}, minor_radius=${o.minorRadius ?? 0.35}, `;
    case 'ico':
      // Clamped: a node model is drawn hundreds of times in a live graph. Subdivision 3 is
      // already 1280 triangles per node.
      return `bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=${Math.max(0, Math.min(o.subdivisions ?? 1, 3))}, `;
    default:
      return 'bpy.ops.mesh.primitive_cube_add(';
  }
}

/**
 * Generate the Blender Python from a scene. Deterministic: the same scene produces the same
 * script, byte for byte, so a render is reproducible and diffable.
 *
 * Cycles on CPU, low samples — headless-reliable everywhere, no GPU context needed. The point
 * is a correct picture fast, not a beauty shot.
 */
export function sceneToPython(scene: Scene, outPath: string, format: OutputFormat = 'png'): string {
  const glb = format === 'glb';
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
      return `${primitiveCall(o)}location=(${loc[0]}, ${loc[1]}, ${loc[2]}))
obj${i} = bpy.context.active_object
obj${i}.rotation_euler = (${rot[0]}, ${rot[1]}, ${rot[2]})
obj${i}.scale = (${s}, ${s}, ${s})
obj${i}.data.materials.append(mat((${col[0]}, ${col[1]}, ${col[2]})))`;
    })
    .join('\n')}

${
  glb
    ? `# GLB export — NO camera and NO lights are added. This asset is a NODE in someone else's
# scene: the Reckons.AI 3D graph supplies its own lighting and camera, and an exported sun lamp
# would fight it. Materials are exported so the node keeps its type colour.
bpy.ops.export_scene.gltf(
    filepath=${JSON.stringify(outPath)},
    export_format='GLB',
    export_apply=True,
    export_cameras=False,
    export_lights=False,
)`
    : `# Light
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

bpy.ops.render.render(write_still=True)`
}
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

/** Run headless Blender on a generated script. Returns its exit code; never throws on failure —
 *  the exit code is evidence, not the verdict. The verdict is the acceptance check. */
function runBlender(scene: Scene, outPath: string, format: OutputFormat): number {
  const bin = blenderBin();
  const dir = mkdtempSync(path.join(tmpdir(), 'blender-'));
  const script = path.join(dir, 'scene.py');
  writeFileSync(script, sceneToPython(scene, outPath, format));

  try {
    execFileSync(bin, ['--background', '--factory-startup', '--python', script], {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
    });
    return 0;
  } catch (e: any) {
    return typeof e?.status === 'number' ? e.status : 1;
  }
}

/** Render a scene to a PNG, then VERIFY the PNG is a real image. */
export function render(scene: Scene, outPath: string): RenderResult {
  const blenderExit = runBlender(scene, outPath, 'png');
  // The acceptance criterion. Blender's exit code is NOT it — a black frame exits 0.
  const check = checkImage(outPath);
  return { ok: check.ok, outPath, check, blenderExit };
}

export interface GlbResult {
  ok: boolean;
  outPath: string;
  check: GlbCheck;
  blenderExit: number;
}

/**
 * Export a scene to GLB, then VERIFY the GLB actually contains geometry.
 *
 * Same failure shape as the black frame: `export_scene.gltf` writes a valid, parseable,
 * completely empty .glb and exits 0 whenever the scene it was pointed at had no meshes. An
 * empty node model is worse than none — it renders as an invisible node the user cannot click.
 */
export function exportGlb(scene: Scene, outPath: string): GlbResult {
  const blenderExit = runBlender(scene, outPath, 'glb');
  const check = checkGlb(outPath);
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

// ── The empty-export guard — checkImage's counterpart for GLB ─────────────────
export interface GlbCheck {
  ok: boolean;
  reason: string;
  bytes: number;
  /** Meshes declared in the glTF JSON chunk. */
  meshes: number;
  /** Total POSITION accessor count — the actual vertices a viewer would draw. */
  vertices: number;
}

/**
 * Is this file actually a 3D model, and does it actually contain geometry?
 *
 *   1. no file / empty        → Blender never wrote it.
 *   2. bad magic / version    → not a GLB 2.0 container.
 *   3. truncated             → the header's declared length exceeds the bytes on disk. A
 *                               half-written export from a killed process passes every other
 *                               check, because the JSON chunk comes FIRST.
 *   4. no meshes / no verts   → THE EMPTY EXPORT. Exits 0, opens fine, draws nothing. This is
 *                               the GLB equivalent of the black frame and the reason this exists.
 *
 * Deterministic, container-level, no dependency: it reads the glTF JSON chunk, which is plain
 * JSON at a known offset. It does NOT validate the binary buffer contents — an accessor could
 * still lie about its data. That is a real limit of this check, not an oversight: it catches the
 * empty and truncated classes, which are the ones Blender actually produces.
 */
export function checkGlb(file: string): GlbCheck {
  const empty = { meshes: 0, vertices: 0 };
  if (!existsSync(file)) return { ok: false, reason: 'no file — Blender never wrote an export', bytes: 0, ...empty };
  const buf = readFileSync(file);
  const bytes = buf.length;
  if (bytes < 20) return { ok: false, reason: `file is ${bytes} bytes — effectively empty`, bytes, ...empty };

  if (buf.readUInt32LE(0) !== 0x46546c67) return { ok: false, reason: 'not a GLB — bad magic (expected "glTF")', bytes, ...empty };
  const version = buf.readUInt32LE(4);
  if (version !== 2) return { ok: false, reason: `GLB version ${version} — only 2.0 is supported`, bytes, ...empty };
  const declared = buf.readUInt32LE(8);
  if (declared > bytes) {
    return { ok: false, reason: `truncated — header declares ${declared} bytes, file has ${bytes}`, bytes, ...empty };
  }

  // First chunk must be JSON per the GLB 2.0 spec.
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) return { ok: false, reason: 'first GLB chunk is not JSON — malformed container', bytes, ...empty };
  if (20 + chunkLen > bytes) return { ok: false, reason: 'JSON chunk runs past end of file — truncated export', bytes, ...empty };

  let gltf: any;
  try {
    gltf = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen));
  } catch {
    return { ok: false, reason: 'GLB JSON chunk does not parse', bytes, ...empty };
  }

  const meshes: any[] = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  if (meshes.length === 0) {
    return { ok: false, reason: 'no meshes — an EMPTY export that wrote successfully and draws nothing', bytes, ...empty };
  }

  const accessors: any[] = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  let vertices = 0;
  for (const m of meshes) {
    for (const prim of m.primitives ?? []) {
      const idx = prim.attributes?.POSITION;
      if (typeof idx === 'number' && accessors[idx]) vertices += accessors[idx].count ?? 0;
    }
  }
  if (vertices === 0) {
    return { ok: false, reason: `${meshes.length} mesh(es) but 0 vertices — nothing to draw`, bytes, meshes: meshes.length, vertices };
  }

  return {
    ok: true,
    reason: `real model (${bytes} bytes, ${meshes.length} mesh(es), ${vertices} vertices)`,
    bytes,
    meshes: meshes.length,
    vertices,
  };
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
    const c = checkOnly.toLowerCase().endsWith('.glb') ? checkGlb(checkOnly) : checkImage(checkOnly);
    console.log(`${c.ok ? '✓' : '✗'} ${c.reason}`);
    process.exit(c.ok ? 0 : 1);
  }

  const sceneFile = flag('scene');
  const explicitFormat = flag('format');
  const out = flag('out') ?? (explicitFormat === 'glb' ? 'model.glb' : 'render.png');
  // Extension decides unless --format says otherwise, so `--out node.glb` just works.
  const format: OutputFormat = explicitFormat === 'glb' || (!explicitFormat && out.toLowerCase().endsWith('.glb')) ? 'glb' : 'png';
  if (!sceneFile) {
    console.error('Usage: --scene scene.json --out render.png [--format glb]   (or --check <file>)');
    process.exit(2);
  }
  const scene: Scene = JSON.parse(readFileSync(sceneFile, 'utf8'));
  console.log(`${format === 'glb' ? 'Exporting' : 'Rendering'} ${scene.objects.length} object(s) → ${out} …`);
  const r = format === 'glb' ? exportGlb(scene, out) : render(scene, out);
  console.log(`  Blender exit: ${r.blenderExit}`);
  console.log(`  ${r.check.ok ? '✓' : '✗'} ${r.check.reason}`);
  if (!r.ok) {
    console.log(
      format === 'glb'
        ? `  A green Blender exit is not a real model — this failed the acceptance check.`
        : `  A green Blender exit is not a good image — this failed the acceptance check.`
    );
  }
  process.exit(r.ok ? 0 : 1);
}
