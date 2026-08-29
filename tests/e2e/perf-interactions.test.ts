import { expect, test } from '@playwright/test';
import { measureClickToQuiet } from '../../scripts/offline/lib/perf-interactions';

test.beforeEach(async ({ page }) => {
  await page.setContent('<button id="go">go</button><output id="result"></output>');
});

test.describe('measureClickToQuiet', () => {
  test('includes synchronous click-handler time instead of starting the clock afterwards', async ({ page }) => {
    await page.locator('#go').evaluate((button) => {
      button.addEventListener('click', () => {
        const until = performance.now() + 90;
        while (performance.now() < until) { /* deliberate main-thread block */ }
        document.querySelector('#result')!.textContent = 'done';
      });
    });

    const result = await measureClickToQuiet(page, () => page.locator('#go').click(), {
      budgetMs: 500,
      minimumObserveMs: 20,
      quietMs: 10,
    });

    expect(result.timedOut).toBe(false);
    expect(result.responseMs).toBeGreaterThanOrEqual(75);
  });

  test('observes delayed DOM work during the configured settle window', async ({ page }) => {
    await page.locator('#go').evaluate((button) => {
      button.addEventListener('click', () => {
        setTimeout(() => { document.querySelector('#result')!.textContent = 'late'; }, 70);
      });
    });

    const result = await measureClickToQuiet(page, () => page.locator('#go').click(), {
      budgetMs: 500,
      minimumObserveMs: 120,
      quietMs: 10,
    });

    expect(result.timedOut).toBe(false);
    expect(result.responseMs).toBeGreaterThanOrEqual(55);
  });

  test('times out when the click handler alone exceeds the total budget', async ({ page }) => {
    await page.locator('#go').evaluate((button) => {
      button.addEventListener('click', () => {
        const until = performance.now() + 80;
        while (performance.now() < until) { /* deliberate main-thread block */ }
      });
    });

    const result = await measureClickToQuiet(page, () => page.locator('#go').click(), {
      budgetMs: 40,
      minimumObserveMs: 10,
      quietMs: 5,
    });

    expect(result.timedOut).toBe(true);
    expect(result.responseMs).toBeGreaterThanOrEqual(40);
  });

  test('resumes the probe after a click replaces the document', async ({ page }) => {
    await page.locator('#go').evaluate((button) => {
      button.addEventListener('click', () => { window.location.href = 'about:blank?destination'; });
    });

    const result = await measureClickToQuiet(page, () => page.locator('#go').click(), {
      budgetMs: 1_000,
      minimumObserveMs: 20,
      quietMs: 10,
    });

    expect(result.timedOut).toBe(false);
    expect(result.probeReset).toBe(true);
    expect(page.url()).toContain('destination');
  });

  test('disconnects and removes the probe when the click throws', async ({ page }) => {
    await expect(measureClickToQuiet(page, async () => {
      throw new Error('synthetic click failure');
    }, {
      budgetMs: 500,
      minimumObserveMs: 20,
      quietMs: 10,
    })).rejects.toThrow('synthetic click failure');

    expect(await page.evaluate(() => '__perfInteractionProbe' in window)).toBe(false);
  });
});
