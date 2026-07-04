import { test, expect } from '@playwright/test';

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

test('documentation graph renders nodes without a WebGL/renderer crash', async ({ page }) => {
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

  // A visible canvas with a real, non-zero size must be present (2D or 3D
  // renderer — either way there is a <canvas>).
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

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
