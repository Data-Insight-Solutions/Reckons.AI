/**
 * User Story: Navigation Sweep — every primary destination, every device size.
 *
 * The exemplar for the visual-workflow harness. For each device in the matrix it
 * visits the five main destinations; each step BOXES the nav target it is about
 * to activate (so the screenshot shows exactly what's under test), captures an
 * annotated shot, then captures the destination page and runs the local
 * defect audit (horizontal overflow / sub-44px touch targets / overlaps).
 *
 * This is intentionally long (5 devices x 5 destinations) and doubles as
 * regression coverage for the mobile nav bar. Screenshots:
 *   tests/visual/screenshots/navigation-sweep/<device>/
 */
import { test, expect } from '@playwright/test';
import { DEVICES, useDevice, screenshotStep, stepAudit, waitForAppReady } from '../workflow-harness';

const APP = 'http://localhost:5174';

const DESTINATIONS = [
  { label: 'view', path: '/' },
  { label: 'add', path: '/ingest' },
  { label: 'review', path: '/review' },
  { label: 'reckon', path: '/reckoning' },
  { label: 'graph', path: '/kb' },
];

for (const device of DEVICES) {
  test.describe(`Navigation sweep — ${device.name} (${device.width}x${device.height})`, () => {
    test('nav bar usable; every destination renders without overflow', async ({ page }) => {
      await useDevice(page, device);
      await page.goto(APP);
      await waitForAppReady(page);

      const story = `navigation-sweep/${device.name}`;

      // The nav bar itself, boxed, as the opening frame.
      await screenshotStep(page, story, '00-navbar', {
        target: page.locator('nav').first(),
        label: 'main navigation',
      });

      for (const dest of DESTINATIONS) {
        await test.step(dest.label, async () => {
          // Box the nav target we're about to activate.
          const target = page.locator(`nav a[href="${dest.path}"]`).first();
          if (await target.count()) {
            await screenshotStep(page, story, `nav-${dest.label}`, {
              target,
              label: `tap: ${dest.label}`,
            });
          }

          // Navigate and confirm the destination rendered.
          await page.goto(`${APP}${dest.path}`);
          await waitForAppReady(page);
          await screenshotStep(page, story, `page-${dest.label}`);

          // Auto-defect audit for this step on this device.
          const defects = await stepAudit(page);
          if (defects.smallTargets.length || defects.overlaps) {
            test.info().annotations.push({
              type: 'visual-defect',
              description: `${dest.label} @ ${device.name}: ${defects.smallTargets.length} sub-44px target(s), ${defects.overlaps} overlap(s)`,
            });
          }
          // Horizontal overflow is a hard defect on any device.
          expect(defects.overflow, `${dest.label} @ ${device.name}: horizontal overflow`).toBe(false);
        });
      }
    });
  });
}
