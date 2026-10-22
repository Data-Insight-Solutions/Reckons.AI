import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F58.9.13 (kb:splat-occlusion): a marker behind a node's splat is not drawn through it.
 *
 * On the Generated assets example, put a bright test sphere directly behind one splat node, as seen from
 * the camera, and probe the canvas for its colour with the depth proxies off (control: the sphere shows
 * through the translucent splat) and on (the sphere is hidden). Frame time is logged for both, but it is
 * measured by headless Chromium on SwiftShader (software GL), so it is a relative number only.
 */
test('a marker behind a node splat is hidden by the splat\'s depth proxy', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await page.goto('/about');
  await expect(page.locator('.starter-card', { hasText: /generated assets/i })).toBeVisible({ timeout: 10_000 });
  await page.locator('.starter-card', { hasText: /generated assets/i }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  const canvas = page.locator('main canvas[data-splats]').first();
  // The showcase music box is over the startup budget, so it is not counted until asked for.
  await expect(canvas).toHaveAttribute('data-splats', '2/0', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const c = document.querySelector('main canvas[data-splats]') as unknown as { __rk?: { scene: { userData: { splatOccluders?: Record<string, unknown> } } } };
    return (c?.__rk?.scene.userData.splatOccluders ? Object.keys(c.__rk.scene.userData.splatOccluders).length : 0) >= 1;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2_000);

  const result = await page.evaluate(async () => {
    const c = document.querySelector('main canvas[data-splats]') as unknown as HTMLCanvasElement & { __rk: any };
    const { scene, getCamera, renderer } = c.__rk;
    const camera = getCamera();
    const proxies: any[] = Object.values(scene.userData.splatOccluders);
    const frame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));
    const avgFrameMs = async (n: number) => { let last = await frame(); const t0 = last; for (let i = 0; i < n; i++) last = await frame(); return (last - t0) / n; };

    camera.updateMatrixWorld();
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const Mesh = proxies[0].constructor as any, Geo = proxies[0].geometry.constructor as any, Mat = proxies[0].material.constructor as any;

    /** Hide a magenta sphere directly behind one splat node, as the camera sees it, and count what changes. */
    const trial = (best: any) => {
      const P = best.position.clone();
      const R = best.scale.x / 0.8; // the splat's bounding radius
      const dir = P.clone().sub(camera.position).normalize();
      const ball = new Mesh(new Geo(1, 16, 12), new Mat({ color: 0xff00ff }));
      ball.scale.setScalar(Math.max(0.5, R * 0.3));
      ball.position.copy(P).addScaledVector(dir, R * 0.8 + ball.scale.x + 0.1); // just beyond the proxy's far shell
      ball.raycast = () => {};
      const s = P.clone().project(camera);
      const cx = Math.round((s.x * 0.5 + 0.5) * W), cy = Math.round((s.y * 0.5 + 0.5) * H);
      const half = Math.max(8, Math.round(Math.min(W, H) * 0.06));
      const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half), w = Math.min(W - x0, half * 2), h = Math.min(H - y0, half * 2);
      const snap = () => {
        renderer.render(scene, camera);
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      /** Pixels that differ visibly from the picture without the ball. */
      const changed = (a: Uint8Array, b: Uint8Array) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++;
        return n;
      };
      // Rendered back to back in this one task, so nothing (the splat's slow spin, its depth sort) moves between them.
      proxies.forEach((p) => (p.visible = true));
      const clean = snap();
      scene.add(ball);
      proxies.forEach((p) => (p.visible = false));
      const withoutProxy = changed(clean, snap());
      proxies.forEach((p) => (p.visible = true));
      const withProxy = changed(clean, snap());
      scene.remove(ball);
      return { withoutProxy, withProxy, onScreen: Math.abs(s.x) < 1 && Math.abs(s.y) < 1 && s.z < 1 };
    };

    // Which node splats the ball is visible behind (proxy off) depends on the force layout and on how
    // opaque each splat is, so try every one on screen and report all of them.
    const trials = proxies.map(trial).filter((t) => t.onScreen);
    proxies.forEach((p) => (p.visible = false));
    const proxiesOffMs = await avgFrameMs(60);
    proxies.forEach((p) => (p.visible = true));
    const proxiesOnMs = await avgFrameMs(60);
    return { trials, proxiesOffMs, proxiesOnMs, renderer: (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? (gl.getParameter(e.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string); })() };
  });

  console.log('splat-occlusion probe:', JSON.stringify(result));
  expect(result.trials.length, 'a node splat is on screen').toBeGreaterThan(0);
  const best = result.trials.reduce((m, t) => (t.withoutProxy > m.withoutProxy ? t : m));
  expect(best.withoutProxy, 'control: with the proxy off, the sphere shows through the splat').toBeGreaterThan(20);
  for (const t of result.trials) expect(t.withProxy, 'with the proxy on, the sphere behind the splat is hidden').toBeLessThanOrEqual(2);
});
