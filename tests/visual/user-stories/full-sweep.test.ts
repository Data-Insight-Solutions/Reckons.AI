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
import { test, expect } from '@playwright/test';
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
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await useDevice(page, device);
      await gotoStable(page, APP);
      // A green populated sweep must prove setup succeeded. Capturing an empty
      // fallback after a swallowed seed failure is not evidence for the claim.
      await seedAllKbs(page);

      const story = `full-sweep/${device.name}`;
      const dir = `tests/visual/screenshots/full-sweep/${device.name}`;
      mkdirSync(dir, { recursive: true });
      const report: { route: string; label: string; overflow: boolean; smallTargets: number; overlaps: number; error?: string }[] = [];

      for (const r of ROUTES) {
        await gotoStable(page, `${APP}${r.path}`);
        await waitForAppReady(page);
        await page.waitForTimeout(700); // let force sim / async panels settle
        await screenshotStep(page, story, r.label);
        const audit = await stepAudit(page);
        report.push({
          route: r.path,
          label: r.label,
          overflow: audit.overflow,
          smallTargets: audit.smallTargets.length,
          overlaps: audit.overlaps,
        });
      }

      writeFileSync(`${dir}/_audit.json`, JSON.stringify(report, null, 2));
      console.log(`[full-sweep ${device.name}] audit:`, JSON.stringify(report));
      const auditFailures = report.filter(
        (route) => route.overflow || route.smallTargets > 0 || route.overlaps > 0 || route.error,
      );
      expect(auditFailures, 'visual audit failures').toEqual([]);
      expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n---\n')}`).toEqual([]);
      expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n---\n')}`).toEqual([]);
    });
  });
}
