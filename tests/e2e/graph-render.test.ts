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

  // Playwright gives every test a fresh browser context, including IndexedDB,
  // localStorage, and sessionStorage. Do not navigate and then clear/reload:
  // that aborts the landing page's bundled-KB preload and creates a false
  // console error before the actual evidence flow starts.
  await page.goto('/');
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

  // Any console or page error invalidates visual evidence. A narrow renderer
  // filter would let unrelated runtime failures normalize into a green gate.
  expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n---\n')}`).toHaveLength(0);
  expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n---\n')}`).toHaveLength(0);
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
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

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
  expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n---\n')}`).toHaveLength(0);
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
test('hero "Getting started" button activates the starter graph (not a no-op)', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/');
  await page.locator('nav').waitFor({ timeout: 15_000 });

  // The exact control the user reported: the hero primary CTA.
  const getStarted = page.getByRole('button', { name: /getting started/i });
  await expect(getStarted).toBeVisible({ timeout: 10_000 });
  await getStarted.click();

  // The saved renderer preference is authoritative. The default is 3D, so the starter must not
  // silently paint 2D while Settings still says 3D.
  const starterGraph = page.locator('[data-graph-renderer="3d"][data-graph-ready="true"]');
  await expect(starterGraph).toBeVisible({ timeout: 30_000 });
  const starterCanvas = starterGraph.locator('canvas').first();
  await expect(starterCanvas).toBeVisible();
  const starterFrame = await starterCanvas.screenshot();
  const starterPixels = await analyzePixels(starterFrame);
  expect(starterPixels.isBlank, starterPixels.anomalyDetails.join('; ')).toBe(false);
  expect(starterPixels.uniqueColorCount).toBeGreaterThan(20);

  // And the landing hero must be gone (graph route swapped in).
  await expect(page.getByRole('button', { name: /getting started/i })).toHaveCount(0);
  expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n---\n')}`).toHaveLength(0);
  expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n---\n')}`).toHaveLength(0);
});

test('Getting started + Preview all demonstrates GIF, video, and GLB assets', async ({ page }, testInfo) => {
  const failedAssets: string[] = [];
  page.on('response', (response) => {
    const url = response.url();
    if (
      response.status() >= 400 &&
      ['/gif/starter/', '/video/starter/', '/glb/starter/'].some((part) => url.includes(part))
    ) failedAssets.push(`${response.status()} ${url}`);
  });

  await page.goto('/');
  await page.locator('nav').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /getting started/i }).click();
  await expect(page.locator('[data-graph-renderer="3d"][data-graph-ready="true"]')).toBeVisible({ timeout: 30_000 });

  // A fresh browser profile shows the first-run Shelly notification over the
  // asset viewer's top-right controls. Clear it as a user would before opening
  // the large viewers below.
  const dismissNotification = page.getByRole('button', { name: 'dismiss', exact: true });
  if (await dismissNotification.isVisible()) await dismissNotification.click();

  const previews = page.locator('.overlay-group', { hasText: /previews/i });
  await previews.locator('button.chip').first().click();
  // The popover is portaled to <body>, so it is intentionally not a descendant
  // of the previews overlay group that owns the trigger.
  await page.getByRole('button', { name: 'preview all', exact: true }).click();

  const gifThumb = page.getByRole('button', { name: /open asset for first night, fire and catching up/i });
  const videoThumb = page.getByRole('button', { name: /open asset for jordan's sunrise shoot/i });
  const glbThumb = page.getByRole('button', { name: /open asset for pitch camp before dark/i });

  await expect(gifThumb).toBeVisible({ timeout: 15_000 });
  await expect(videoThumb).toBeVisible();
  await expect(glbThumb).toBeVisible();
  await expect(gifThumb.locator('img')).toHaveAttribute('src', '/gif/starter/campfire.gif');
  await expect(videoThumb.locator('video')).toHaveAttribute('src', '/video/starter/sunrise-shoot.webm');
  await expect(glbThumb).toContainText('3D');

  await expect.poll(
    () => gifThumb.locator('img').evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0),
    { message: 'the animated GIF should decode into a real image' },
  ).toBe(true);
  await expect.poll(
    () => videoThumb.locator('video').evaluate((video) => ({
      ready: (video as HTMLVideoElement).readyState >= HTMLMediaElement.HAVE_METADATA,
      duration: (video as HTMLVideoElement).duration,
      width: (video as HTMLVideoElement).videoWidth,
    })),
    { message: 'the WebM should load metadata and dimensions' },
  ).toMatchObject({ ready: true, duration: 4, width: 640 });

  // Exercise the kind-specific large viewers, not merely three asset URLs in the Turtle file.
  await gifThumb.click();
  await expect(page.locator('.asset-large img')).toHaveAttribute('src', '/gif/starter/campfire.gif');
  await page.locator('.asset-large .asset-controls button[title="Close"]').click();

  await videoThumb.click();
  await expect(page.locator('.asset-large video.asset-media')).toHaveAttribute('src', '/video/starter/sunrise-shoot.webm');
  await page.locator('.asset-large .asset-controls button[title="Close"]').click();

  await glbThumb.click();
  const glbCanvas = page.locator('.asset-large .asset-glb canvas');
  await expect(glbCanvas).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_500); // allow the async GLB loader to frame and paint the model
  const glbFrame = await glbCanvas.screenshot();
  await testInfo.attach('starter-glb-viewer', { body: glbFrame, contentType: 'image/png' });
  const glbPixels = await analyzePixels(glbFrame);
  expect(glbPixels.isBlank, glbPixels.anomalyDetails.join('; ')).toBe(false);
  expect(glbPixels.uniqueColorCount).toBeGreaterThan(10);

  expect(failedAssets, `Starter assets failed to load:\n${failedAssets.join('\n')}`).toHaveLength(0);
});
