#!/usr/bin/env npx tsx
/**
 * Render comparable views of splat files with the SAME renderer the app ships (Gaussian-Splat-Lite
 * on three.js, WebGL2, headless Chromium with software GL), for judging detail between settings of one
 * subject (F58.9 / kb:showcase-splat).
 *
 *   npx tsx scripts/content/splat-shots.ts --out=DIR file1.ply file2.spz ...
 *
 * One PNG per file and view: DIR/<name>.<view>.png. Orientation matches the app (createNormalizedSplat):
 * TripoSplat's y-down, faces +x frame is turned so the picture's side faces the camera.
 * Software GL is slow and its blending is not a phone's, so this compares settings; it does not say how
 * the splat looks on a real GPU.
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const out = resolve(args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? '.');
const files = args.filter((a) => !a.startsWith('--')).map((f) => resolve(f));
mkdirSync(out, { recursive: true });
/** name, azimuth degrees, elevation degrees, camera distance as a multiple of the radius, look-at height (radius units) */
const VIEWS = [['threequarter', 30, 18, 3.3, 0], ['front', 0, 8, 3.3, 0], ['detail', 12, 22, 1.15, 0.28]] as const;

const dir = mkdtempSync(join(tmpdir(), 'splat-shots-'));
writeFileSync(join(dir, 'entry.js'), `
import * as THREE from 'three';
import { GaussianSplatRenderer, SplatMesh } from 'gaussian-splat-lite';
window.shoot = async (url, views) => {
  const W = 900;
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(W, W); renderer.setClearColor(0xe6e6e6); document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new GaussianSplatRenderer({ renderer }));
  const mesh = new SplatMesh({ url }); await mesh.initialized;
  const sphere = mesh.getBoundingBox(true, new THREE.Box3()).getBoundingSphere(new THREE.Sphere());
  const inner = new THREE.Group(); inner.rotation.set(Math.PI, Math.PI / 2, 0);
  mesh.position.copy(sphere.center).multiplyScalar(-1); inner.add(mesh);
  const group = new THREE.Group(); group.scale.setScalar(1 / sphere.radius); group.add(inner); scene.add(group);
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const shots = {};
  for (const [name, az, el, dist, lookY] of views) {
    const a = az * Math.PI / 180, e = el * Math.PI / 180;
    cam.position.set(Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist + lookY, Math.cos(a) * Math.cos(e) * dist);
    cam.lookAt(0, lookY, 0);
    for (let i = 0; i < 6; i++) { renderer.render(scene, cam); await new Promise((r) => setTimeout(r, 400)); }
    shots[name] = renderer.domElement.toDataURL('image/png');
  }
  const gl = renderer.getContext().getParameter(renderer.getContext().RENDERER);
  return { shots, gl };
};
`);
await build({ entryPoints: [join(dir, 'entry.js')], bundle: true, format: 'iife', outfile: join(dir, 'bundle.js'), nodePaths: [resolve(import.meta.dirname, '../../node_modules')], logLevel: 'error', minify: true });
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url ?? '/');
  if (u === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body style="margin:0"><script src="/bundle.js"></script>'); return; }
  if (u === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(join(dir, 'bundle.js'))); return; }
  const f = files.find((x) => `/f/${basename(x)}` === u);
  if (!f) { res.statusCode = 404; res.end(); return; }
  res.end(readFileSync(f));
}).listen(0);
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const f of files) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on('pageerror', (e) => console.error('page error', e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  const r = await page.evaluate(([u, v]) => (window as any).shoot(u, v), [`/f/${basename(f)}`, VIEWS] as const) as { shots: Record<string, string>; gl: string };
  for (const [name, data] of Object.entries(r.shots)) writeFileSync(join(out, `${basename(f).replace(/\.[^.]+$/, '')}.${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
  console.log(`${basename(f)} rendered (${r.gl})`);
  await page.close();
}
await browser.close(); server.close();
