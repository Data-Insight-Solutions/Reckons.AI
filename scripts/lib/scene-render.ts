/**
 * SCENE RENDERING (F190) — three.js in a generated page, without shipping three.js.
 *
 * Matt, 2026-09-08, choosing both halves: a BUILD-TIME RENDER for backgrounds and stills, and an
 * IFRAME ISLAND for the cases that genuinely need to be interactive.
 *
 * WHY THIS SHAPE. `src/routes/docs/+layout.ts` sets `csr = false` for the whole docs route group,
 * and kb:journey-docs records the reasoning from the other side: loading a ~500 KB runtime to draw
 * a picture reverses a real performance decision for decoration. That decision stands. So a scene
 * declared with `kpred:scene` is rendered ONCE here, against the same headless Chromium that
 * already renders the mermaid diagrams, and the page receives a finished image. A reader
 * downloads a PNG; they never download three.js.
 *
 * A PNG ON DISK, NOT A DATA URI IN THE MARKDOWN. The diagram cache can hold SVG inline because SVG
 * is text and compresses; a rendered frame is tens of kilobytes of base64 that would land inside
 * `content/*.md` and be diffed byte-for-byte by `md-align` on every run. So frames are written to
 * `static/scenes/<key>.png` and the page references `/scenes/<key>.png` — static assets serve from
 * the site root, never from `/static/`.
 *
 * THE CACHE IS KEYED ON SOURCE PLUS CONTRACT, exactly as diagrams are, and for the same reason:
 * without the contract bump every rendering fix would be a silent no-op against stale entries.
 * That already caught this project once — RENDER_CONTRACT v1 to v2 on 2026-09-06.
 *
 * WHAT THIS IS NOT. It is not an interactive viewer. A scene that must respond to a pointer is the
 * OTHER half of Matt's answer and belongs in an iframe island, which charges only the pages that
 * ask for it; `sceneIframe()` below emits that, and the two are deliberately separate functions so
 * a page author has to choose which cost they are paying.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const THREE_DIR = join(ROOT, 'node_modules', 'three', 'build');
const THREE_DIST = join(THREE_DIR, 'three.module.js');
export const SCENE_DIR = join(ROOT, 'static', 'scenes');
export const SCENE_CACHE = join(ROOT, 'static', 'scene-cache.json');

/**
 * Bump when the rendering pipeline changes in a way that should invalidate committed frames.
 * The cache keys on source alone otherwise, so a fix would leave every existing scene stale.
 */
const SCENE_CONTRACT = 'v1';

/** key -> { width, height, alt } for every rendered frame. The PNG itself is on disk. */
export type SceneCache = Record<string, { width: number; height: number }>;

export function loadSceneCache(): SceneCache {
  if (!existsSync(SCENE_CACHE)) return {};
  return JSON.parse(readFileSync(SCENE_CACHE, 'utf8')) as SceneCache;
}

export function saveSceneCache(cache: SceneCache): void {
  const sorted: SceneCache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  writeFileSync(SCENE_CACHE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

export function sceneKey(source: string): string {
  return createHash('sha256').update(`${SCENE_CONTRACT}\n${source.trim()}`).digest('hex').slice(0, 16);
}

export interface SceneSpec {
  /** The scene body: JavaScript run with `THREE`, `scene`, `camera` and `renderer` in scope. */
  source: string;
  width?: number;
  height?: number;
}

/**
 * Render each scene to `static/scenes/<key>.png`.
 *
 * The author's source is evaluated INSIDE the page with three.js already imported and a scene,
 * camera and renderer already made. That is a deliberate narrowing: a scene in a TTL file should
 * be a description of what to draw, not a full program with its own boilerplate and its own
 * chances to differ from every other scene.
 */
export async function renderScenes(specs: Map<string, SceneSpec>): Promise<Map<string, { width: number; height: number }>> {
  const out = new Map<string, { width: number; height: number }>();
  if (specs.size === 0) return out;
  if (!existsSync(THREE_DIST)) {
    throw new Error(`three.js is not installed (${THREE_DIST} missing). It is a dependency — run \`npm install\`.`);
  }

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  mkdirSync(SCENE_DIR, { recursive: true });

  try {
    for (const [key, spec] of specs) {
      const width = spec.width ?? 1200;
      const height = spec.height ?? 600;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      /*
       * three.js ships ES modules only — the UMD build is gone, so there is no global to attach
       * and `addScriptTag({ content })` cannot expose one. The module is therefore SERVED over an
       * intercepted route and imported for real, which also resolves its own internal import of
       * three.core.js. Nothing leaves the machine: the route answers from node_modules.
       */
      await page.route('https://three.local/**', (route) => {
        const name = new URL(route.request().url()).pathname.replace(/^\//, '');
        const file = join(THREE_DIR, name);
        if (!/^[\w.-]+\.js$/.test(name) || !existsSync(file)) return route.abort();
        return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file, 'utf8') });
      });
      // A transparent body: the page's own background shows through, so a scene can sit behind
      // prose in either theme without carrying a baked-in colour that only suits one of them.
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;background:transparent}`
        + `canvas{display:block}</style></head><body></body></html>`,
      );
      await page.addScriptTag({
        content: `import * as THREE from 'https://three.local/three.module.js'; window.THREE = THREE;`,
        type: 'module',
      });
      await page.waitForFunction(() => Boolean((window as unknown as { THREE?: unknown }).THREE));

      await page.evaluate(async ([src, w, h]) => {
        const T = (window as unknown as { THREE: Record<string, new (...a: never[]) => unknown> }).THREE;
        const scene = new (T.Scene as new () => Record<string, unknown>)();
        const camera = new (T.PerspectiveCamera as new (...a: unknown[]) => Record<string, unknown>)(
          50, (w as number) / (h as number), 0.1, 1000,
        );
        const renderer = new (T.WebGLRenderer as new (...a: unknown[]) => Record<string, unknown>)({
          antialias: true, alpha: true,
        });
        (renderer.setSize as (a: number, b: number) => void)(w as number, h as number);
        (renderer.setPixelRatio as (r: number) => void)(2);
        document.body.appendChild(renderer.domElement as unknown as Node);
        /*
         * ┌─ THE SCENE SOURCE IS EXECUTED, SO WHERE IT COMES FROM IS THE WHOLE SAFETY ARGUMENT ─┐
         * │                                                                                    │
         * │ This runs JavaScript out of a graph. That is fine for a graph in THIS REPOSITORY —  │
         * │ anyone who can write static/*.ttl can already commit code, so it opens no new door. │
         * │ It would be CATASTROPHIC for a graph a user imported from someone else: "here is an │
         * │ interesting knowledge base" would become code execution on their machine.           │
         * │                                                                                    │
         * │ The boundary that makes it safe is in docs-scenes.ts, which collects scenes ONLY    │
         * │ from static/*.ttl and never from an imported graph, the app's IndexedDB, or         │
         * │ anything a user could have been handed. That boundary must not be widened without a │
         * │ better argument than convenience — the same rule scripts/agent/runner.ts states for │
         * │ executing a task's shell command.                                                   │
         * │                                                                                    │
         * │ Raised by the local code review on 2026-09-08, which was right that this is         │
         * │ unsanitised execution and could not see where the input comes from.                 │
         * └────────────────────────────────────────────────────────────────────────────────────┘
         * Kept as a Function rather than eval so the scoped names are explicit and a scene
         * cannot quietly reach for anything else in the page.
         */
        // eslint-disable-next-line no-new-func
        const run = new Function('THREE', 'scene', 'camera', 'renderer', src as string);
        run(T, scene, camera, renderer);
        (renderer.render as (s: unknown, c: unknown) => void)(scene, camera);
      }, [spec.source, width, height] as const);

      const buf = await page.locator('canvas').screenshot({ omitBackground: true });
      writeFileSync(join(SCENE_DIR, `${key}.png`), buf);
      out.set(key, { width, height });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

/**
 * A rendered scene, as a figure. No script, no canvas — an image the reader already has.
 *
 * `loading="lazy"` and explicit dimensions are not decoration: without them a scene below the fold
 * is fetched immediately and the page reflows when it lands, which is the cost this whole approach
 * exists to avoid paying.
 */
export function sceneFigure(key: string, size: { width: number; height: number }, alt: string, caption?: string): string {
  const img = `<img src="/scenes/${key}.png" width="${size.width}" height="${size.height}" `
    + `alt="${escapeAttr(alt)}" loading="lazy" decoding="async" />`;
  return caption
    ? `<figure class="scene" role="group" aria-label="${escapeAttr(caption)}">${img}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
    : `<figure class="scene">${img}</figure>`;
}

/**
 * An INTERACTIVE scene, as an iframe island — the second half of Matt's answer.
 *
 * The document stays JavaScript-free; the frame is a separate document that loads three.js and is
 * the only thing that pays for it. `loading="lazy"` means a reader who never scrolls to it never
 * downloads it at all, which is what makes this affordable on a page that also has prose.
 *
 * `title` is required rather than optional because an iframe without one is announced to a screen
 * reader as "frame", and a generated page cannot be asked for a better name later.
 */
export function sceneIframe(sceneId: string, title: string, size: { width: number; height: number }, caption?: string): string {
  const frame = `<iframe src="/scenes/live/${encodeURIComponent(sceneId)}" title="${escapeAttr(title)}" `
    + `width="${size.width}" height="${size.height}" loading="lazy" `
    + `style="border:0;max-width:100%;aspect-ratio:${size.width}/${size.height}"></iframe>`;
  return caption
    ? `<figure class="scene scene-live" role="group" aria-label="${escapeAttr(caption)}">${frame}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
    : `<figure class="scene scene-live">${frame}</figure>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
