/** Pure helpers for scripts/site/splat-embed.ts: argument parsing and the page/CSP text (no I/O, unit-tested). */

export interface EmbedArgs { splat: string; out: string; title: string; poster?: string; bg?: string }

export function parseEmbedArgs(argv: string[]): EmbedArgs {
  const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const splat = opt('splat');
  const out = opt('out');
  if (!splat) throw new Error('--splat=<file.spz|ply|splat> is required');
  if (!out) throw new Error('--out=<dir> is required');
  if (!/\.(spz|ply|splat|ksplat)$/i.test(splat)) throw new Error('--splat must be a .spz, .ply, .splat or .ksplat file');
  const bg = opt('bg');
  if (bg !== undefined && !/^#[0-9a-f]{3,8}$/i.test(bg)) throw new Error('--bg must be a hex colour such as #101010');
  return { splat, out, title: opt('title') ?? 'Gaussian splat viewer', poster: opt('poster'), bg };
}

/** Everything is same-origin; nothing may load from elsewhere. wasm-unsafe-eval is for the splat decoder worker. */
export const EMBED_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "style-src 'self'",
].join('; ');

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderEmbedHtml(o: { title: string; splatFile: string; posterFile?: string }): string {
  const poster = o.posterFile ? `<img id="poster" src="${esc(o.posterFile)}" alt="${esc(o.title)}">` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">
<title>${esc(o.title)}</title>
<link rel="stylesheet" href="viewer.css">
</head>
<body>
<div id="frame" role="img" aria-label="${esc(o.title)}. Drag to rotate." data-splat="${esc(o.splatFile)}">
${poster}
<p id="fallback" hidden>${esc(o.title)} (the 3D view needs WebGL, which is not available here).</p>
</div>
<script src="loader.js"></script>
</body>
</html>
`;
}

export function renderEmbedCss(bg?: string): string {
  return `html,body{margin:0;height:100%;background:${bg ?? 'transparent'};overflow:hidden}
#frame{position:relative;width:100%;height:100%;touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
#frame.dragging{cursor:grabbing}
#frame canvas,#frame #poster{position:absolute;inset:0;width:100%;height:100%;display:block}
#poster{object-fit:contain}
#fallback[hidden]{display:none}
#fallback{position:absolute;inset:0;margin:0;display:flex;align-items:center;justify-content:center;padding:1rem;text-align:center;font:14px/1.4 system-ui,sans-serif;color:#777}
`;
}

/** The browser-side viewer. Kept as source text so esbuild can bundle three + gaussian-splat-lite into one IIFE. */
export const VIEWER_ENTRY = `
import * as THREE from 'three';
import { GaussianSplatRenderer, SplatMesh } from 'gaussian-splat-lite';

const frame = document.getElementById('frame');
const poster = document.getElementById('poster');
const fail = () => {
  const f = document.getElementById('fallback');
  if (!poster && f) f.hidden = false;
  window.__splatEmbed = { failed: true };
};

async function main() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  frame.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new GaussianSplatRenderer({ renderer }));
  const mesh = new SplatMesh({ url: frame.dataset.splat });
  await mesh.initialized;
  const sphere = mesh.getBoundingBox(true, new THREE.Box3()).getBoundingSphere(new THREE.Sphere());
  // The object stays FIXED; the camera orbits and bobs. The library re-sorts its Gaussians by depth only when the
  // camera moves, so moving the object under a still camera leaves a stale sort and renders wrongly.
  const model = new THREE.Group(); mesh.position.copy(sphere.center).multiplyScalar(-1); model.add(mesh);
  model.scale.setScalar(1 / sphere.radius);
  scene.add(model);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const DIST = 3.6, target = new THREE.Vector3();

  const resize = () => {
    const w = frame.clientWidth || 1, h = frame.clientHeight || 1;
    renderer.setSize(w, h, false); cam.aspect = w / h;
    // keep the whole object in frame whichever way the frame is shaped
    cam.fov = w >= h ? 30 : 2 * Math.atan(Math.tan(15 * Math.PI / 180) / (w / h)) * 180 / Math.PI;
    cam.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(frame); resize();

  let yaw = 0, dragging = false, lastX = 0, resumeAt = 0, visible = true, last = performance.now(), t = 0, drawn = 0;
  frame.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; frame.classList.add('dragging'); try { frame.setPointerCapture(e.pointerId); } catch {} });
  frame.addEventListener('pointermove', (e) => { if (!dragging) return; yaw -= (e.clientX - lastX) * 0.012; lastX = e.clientX; });
  const up = () => { if (!dragging) return; dragging = false; frame.classList.remove('dragging'); resumeAt = performance.now() + 3000; };
  frame.addEventListener('pointerup', up); frame.addEventListener('pointercancel', up);
  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) last = performance.now(); }).observe(frame);

  let paused = false;
  const place = () => {
    const bob = reduce ? 0 : Math.sin(t * 2 * Math.PI * 0.4) * 0.08;
    cam.position.set(Math.sin(yaw) * DIST, bob, Math.cos(yaw) * DIST);
    target.set(0, bob, 0); cam.lookAt(target);
  };
  const tick = (now) => {
    requestAnimationFrame(tick);
    if (!visible || document.hidden) return;
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (!reduce && !paused) {
      t += dt;
      if (!dragging && now >= resumeAt) yaw -= dt * 0.35;
    }
    place();
    renderer.render(scene, cam);
    if (++drawn === 6) { if (poster) poster.remove(); window.__splatEmbed = { ready: true, setYaw: (v) => { yaw = v; }, getYaw: () => yaw, pause: (p) => { paused = p; } }; }
  };
  requestAnimationFrame(tick);
  window.__splatEmbed = { ready: false, setYaw: (v) => { yaw = v; }, getYaw: () => yaw, pause: (p) => { paused = p; } };
}
try { main().catch(fail); } catch { fail(); }
`;

/** Tiny loader: shows the poster now, and fetches the 2.9 MB viewer only when the frame is near the viewport. */
export const LOADER_SOURCE = `(function () {
  var frame = document.getElementById('frame');
  var started = false;
  function start() {
    if (started) return; started = true;
    var s = document.createElement('script'); s.src = 'viewer.js';
    s.onerror = function () { var f = document.getElementById('fallback'); if (f && !document.getElementById('poster')) f.hidden = false; };
    document.body.appendChild(s);
  }
  if (!('IntersectionObserver' in window)) return start();
  var io = new IntersectionObserver(function (es) {
    for (var i = 0; i < es.length; i++) if (es[i].isIntersecting) { io.disconnect(); start(); return; }
  }, { rootMargin: '200px' });
  io.observe(frame);
})();
`;
