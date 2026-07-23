import { test, expect } from '@playwright/test';
import { analyzePixels } from '../visual/vision-local';

/**
 * Deploy gate — smoke test for the "black graph" production bug (see PR #21 /
 * commit e19ebb3 "fix(3d): production black-graph crash").
 *
 * Root cause: Threlte's <T.BufferAttribute> resolves the underlying THREE
 * class via a function-name heuristic. Minification mangles function names,
 * so production builds attached the raw class (not an instance) to the
 * geometry — WebGLRenderer then threw a TypeError reading `.array.byteLength`
 * on every frame. The result was a black canvas with otherwise-working
 * hit-testing (labels/selection still worked), which made it easy to miss in
 * manual QA and impossible to catch with `vite dev`, which never minifies and
 * never reproduced the bug.
 *
 * CRITICAL: this spec must run against a MINIFIED PRODUCTION BUILD
 * (`vite build` + `vite preview`), never `vite dev`. See
 * `playwright.smoke.config.ts` and the `npm run test:e2e:smoke` script, which
 * is wired into CI as its own gate (`.github/workflows/ci.yml`, job `smoke`).
 */

test('documentation graph renders nodes without a WebGL/renderer crash', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message + '\n' + (err.stack ?? '')));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Clean slate.
  await page.goto('/');
  await page.evaluate(async () => {
    try {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((d) =>
          d.name
            ? new Promise<void>((res) => {
                const r = indexedDB.deleteDatabase(d.name!);
                r.onsuccess = () => res();
                r.onerror = () => res();
              })
            : Promise.resolve()
        )
      );
    } catch {
      /* indexedDB.databases() may not exist on all browsers */
    }
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });
  await page.reload();
  await page.locator('nav').waitFor({ timeout: 15_000 });

  // Open the Documentation Graph from the landing page — this is the exact
  // flow that shipped the black-graph bug to production.
  const openDocs = page.getByRole('button', { name: /documentation graph/i });
  await expect(openDocs).toBeVisible({ timeout: 10_000 });
  await openDocs.click();

  // Loading + activating the docs KB (fetch + parse + import) takes a moment.
  // Node labels are direct DOM evidence the graph actually laid out nodes —
  // this is the assertion that would have failed on the buggy build (the
  // graph crashed on the very first render frame, before layout settled).
  await expect
    .poll(async () => page.locator('.node-label').count(), {
      timeout: 30_000,
      message: 'expected .node-label elements to render (graph never laid out nodes)',
    })
    .toBeGreaterThan(0);

  // Let the renderer run a handful of animation frames — the crash fired on
  // every frame, so a short observation window is enough to catch it.
  await page.waitForTimeout(1_500);

  // This deploy gate is specifically a 3D guarantee. A 2D fallback still draws a
  // canvas and labels, so accepting either renderer let a broken/disabled WebGL
  // path report success. The route exposes its actual renderer choice as stable
  // DOM state so the assertion does not depend on implementation-only classes.
  await expect(page.locator('[data-graph-renderer="3d"][data-graph-ready="true"]')).toBeVisible();

  // A visible 3D canvas with a real, non-zero size must be present.
  const canvas = page.locator('[data-graph-renderer="3d"] canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
  const renderedFrame = await canvas.screenshot();
  await testInfo.attach('production-3d-canvas', { body: renderedFrame, contentType: 'image/png' });
  const framePixels = await analyzePixels(renderedFrame);
  expect(framePixels.isBlank, framePixels.anomalyDetails.join('; ')).toBe(false);
  expect(framePixels.uniqueColorCount).toBeGreaterThan(20);
  expect(framePixels.dominantColorRatio).toBeLessThan(0.995);

  // The 3D renderer's error boundary fallback (`.no-webgl`, the svelte:boundary
  // `failed` snippet in routes/(app)/+page.svelte) must never appear.
  await expect(page.locator('.no-webgl')).toHaveCount(0);

  // No uncaught JS errors at all, and specifically none matching the known
  // signature of this bug (byteLength / WebGLRenderer / "reading 'array'").
  const rendererErrorPattern = /byteLength|webglrenderer|reading 'array'/i;
  expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n---\n')}`).toHaveLength(0);
  const matchingConsoleErrors = consoleErrors.filter((e) => rendererErrorPattern.test(e));
  expect(matchingConsoleErrors, `Renderer errors in console:\n${matchingConsoleErrors.join('\n---\n')}`).toHaveLength(0);
});

test('documentation graph uses the intentional 2D fallback when WebGL is unavailable', async ({ page }, testInfo) => {
  // Remove only WebGL contexts before any application code runs. The ordinary
  // 2D canvas context remains available, making this a deterministic capability
  // fallback check rather than a browser/CI hardware accident.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      ...args: unknown[]
    ) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(contextId.toLowerCase())) return null;
      return (original as (...values: unknown[]) => RenderingContext | null).call(this, contextId, ...args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await page.locator('nav').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /documentation graph/i }).click();

  await expect(page.locator('[data-graph-renderer="2d"]')).toBeVisible({ timeout: 30_000 });
  const canvas = page.locator('[data-graph-renderer="2d"] canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
  const fallbackFrame = await canvas.screenshot();
  await testInfo.attach('production-2d-fallback-canvas', { body: fallbackFrame, contentType: 'image/png' });
  const fallbackPixels = await analyzePixels(fallbackFrame);
  expect(fallbackPixels.isBlank, fallbackPixels.anomalyDetails.join('; ')).toBe(false);
  expect(fallbackPixels.uniqueColorCount).toBeGreaterThan(20);
  await expect(page.locator('.no-webgl')).toHaveCount(0);
  expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n---\n')}`).toHaveLength(0);
});

/**
 * Landing-page regression guard — the hero "Getting started →" button.
 *
 * The smoke test above clicks the "Documentation Graph" *card*; this covers the
 * *hero* button (both call `openDocsKb`, but only the card was ever tested).
 * Regression origin: a stale/pre-guard `activateOfficialKb` returned before the
 * KB had statements, so the graph route's empty-KB fallback re-rendered the
 * landing page — the button appeared to do nothing. This asserts the docs graph
 * actually activates and lays out nodes. Runs against the MINIFIED build.
 */
test('hero "Getting started" button activates the docs graph (not a no-op)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    try {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((d) =>
          d.name
            ? new Promise<void>((res) => {
                const r = indexedDB.deleteDatabase(d.name!);
                r.onsuccess = () => res();
                r.onerror = () => res();
              })
            : Promise.resolve()
        )
      );
    } catch { /* indexedDB.databases() may not exist on all browsers */ }
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });
  await page.reload();
  await page.locator('nav').waitFor({ timeout: 15_000 });

  // The exact control the user reported: the hero primary CTA.
  const getStarted = page.getByRole('button', { name: /getting started/i });
  await expect(getStarted).toBeVisible({ timeout: 10_000 });
  await getStarted.click();

  // Docs KB must actually activate and lay out nodes. If activation no-ops, the
  // empty-KB guard re-renders the landing page and no .node-label ever appears.
  await expect
    .poll(async () => page.locator('.node-label').count(), {
      timeout: 30_000,
      message: 'Getting started was a no-op — docs graph never laid out nodes',
    })
    .toBeGreaterThan(0);

  // And the landing hero must be gone (graph route swapped in).
  await expect(page.getByRole('button', { name: /getting started/i })).toHaveCount(0);
});
