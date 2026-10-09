import { test, expect } from '@playwright/test';

/**
 * F248: Getting started arrives with sample sources and a review history, so a first visit shows
 * provenance and review instead of an empty Sources view and an empty Review tab.
 */
for (const width of [1280, 390]) {
  test(`Getting started shows its sample sources, their passages, and three facts to review at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });

    await page.goto('/');
    await page.getByRole('button', { name: /getting started/i }).click();
    await expect(page.getByRole('group', { name: 'Graph perspective' })).toBeVisible({ timeout: 30_000 });
    // Shelly's tour opens over the graph; this test is about what the space holds, so close it.
    const shelly = page.getByRole('dialog', { name: 'Shelly' });
    if (await shelly.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) {
      await page.keyboard.press('Escape');
      await expect(shelly).toBeHidden();
    }

    // Sources: every sample is listed, and its text was kept, so it opens as a document.
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page).toHaveURL(/perspective=sources/);
    if (width < 600) await page.locator('.source-picker > summary').click();
    await expect(page.getByRole('checkbox', { name: /^Sample: / })).toHaveCount(7);
    await expect(page.getByText(/Source details unavailable/)).toHaveCount(0);
    const routeNotes = page.getByRole('checkbox', { name: /^Sample: route notes/ });
    if (!(await routeNotes.isChecked())) await routeNotes.check();
    await page.getByRole('button', { name: 'Inspect source Sample: route notes' }).click();
    const details = page.getByRole('region', { name: 'Source details' });
    const document = details.getByRole('region', { name: 'Source document' });
    await expect(document).toContainText('327 mi');
    await expect(document).not.toContainText('was not kept');
    await page.screenshot({ path: testInfo.outputPath(`starter-sources-${width}.png`) });

    // Review: the three facts the sample review left open are the person's first decision.
    await page.goto('/review');
    await expect(page.getByTestId('review-pending-count')).toHaveText(/\b3\b/, { timeout: 20_000 });
    // They are the person's to decide. A reviewing agent does not exist on a first visit.
    await expect(page.getByText(/3 to review — all of them yours to decide/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`starter-review-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
