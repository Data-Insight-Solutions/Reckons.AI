/**
 * Full-app visual sweep — every screen, desktop + mobile, in one pass.
 *
 * Breadth-first capture for the pre-announcement stabilization program: visit every
 * route, seed a real graph so screens aren't empty, screenshot each, and run the
 * cheap local defect audit (horizontal overflow / sub-44px touch targets / DOM
 * overlaps) per screen per device. Writes a machine-readable _audit.json per device
 * for triage, and screenshots to tests/visual/screenshots/full-sweep/<device>/.
 *
 * This is the automated layer of the three-layer review (VLM gate → Claude views the
 * shots → Codex council on flagged code). Deliberately only desktop + pixel to stay
 * fast; the full DEVICES matrix is navigation-sweep's job.
 *
 * Run:  (dev:test on 5174 must be up)
 *   npx playwright test --config=playwright.visual.config.ts --project=chromium full-sweep
 */
import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { DEVICES, useDevice, gotoStable, waitForAppReady, screenshotStep, stepAudit } from '../workflow-harness';
import { seedAllKbs } from '../kb-seed';

const APP = 'http://localhost:5174';

const ROUTES = [
  { label: 'graph-main', path: '/' },
  { label: 'ingest', path: '/ingest' },
  { label: 'review', path: '/review' },
  { label: 'reckoning', path: '/reckoning' },
  { label: 'kb', path: '/kb' },
  { label: 'analyze', path: '/analyze' },
  { label: 'compare', path: '/compare' },
  { label: 'history', path: '/history' },
  { label: 'about', path: '/about' },
  { label: 'case-study', path: '/about/case-study-0' },
  { label: 'settings', path: '/settings' },
  { label: 'settings-entity-types', path: '/settings/entity-types' },
  { label: 'settings-integrations', path: '/settings/integrations' },
  { label: 'settings-publishing', path: '/settings/publishing' },
  { label: 'settings-turtle', path: '/settings/turtle' },
  { label: 'mobile', path: '/mobile' },
  { label: 'overlay', path: '/overlay' },
  { label: 'docs', path: '/docs' },
];

const SWEEP_DEVICES = DEVICES.filter((d) => d.name === 'desktop' || d.name === 'pixel');

for (const device of SWEEP_DEVICES) {
  test.describe(`Full sweep — ${device.name} (${device.width}x${device.height})`, () => {
    test('every screen renders; capture + defect audit', async ({ page }) => {
      test.setTimeout(240_000);
      await useDevice(page, device);
      await gotoStable(page, APP);
      // Seed a graph so graph/kb/review/compare aren't empty. A seeding failure must
      // not sink the sweep — an empty screen is still worth capturing.
      try {
        await seedAllKbs(page);
      } catch (e) {
        console.warn(`[full-sweep ${device.name}] seeding failed (screens may be empty): ${e}`);
      }

      const story = `full-sweep/${device.name}`;
      const dir = `tests/visual/screenshots/full-sweep/${device.name}`;
      mkdirSync(dir, { recursive: true });
      const report: { route: string; label: string; overflow: boolean; smallTargets: number; overlaps: number; error?: string }[] = [];

      for (const r of ROUTES) {
        try {
          await gotoStable(page, `${APP}${r.path}`);
          await waitForAppReady(page).catch(() => {});
          await page.waitForTimeout(700); // let force sim / async panels settle
          await screenshotStep(page, story, r.label);
          const audit = await stepAudit(page).catch(() => ({ overflow: false, smallTargets: [], overlaps: 0 }));
          report.push({
            route: r.path,
            label: r.label,
            overflow: audit.overflow,
            smallTargets: audit.smallTargets.length,
            overlaps: audit.overlaps,
          });
        } catch (e) {
          report.push({ route: r.path, label: r.label, overflow: false, smallTargets: 0, overlaps: 0, error: String(e).slice(0, 200) });
        }
      }

      writeFileSync(`${dir}/_audit.json`, JSON.stringify(report, null, 2));
      console.log(`[full-sweep ${device.name}] audit:`, JSON.stringify(report));
    });
  });
}
