import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  clipFrozenSpans,
  interactionIsBlocking,
  measureClickToQuiet,
  performanceRunIsBlocking,
} from '../perf-interactions';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent('<button id="go">go</button><output id="result"></output>');
});

afterEach(async () => {
  await page?.close();
});

afterAll(async () => {
  await browser?.close();
});

describe('measureClickToQuiet', () => {
  it('includes synchronous click-handler time instead of starting the clock afterwards', async () => {
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

  it('observes delayed DOM work during the configured settle window', async () => {
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

  it('times out when the click handler alone exceeds the total budget', async () => {
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

  it('resumes the probe after a click replaces the document', async () => {
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

  it('disconnects and removes the probe when the click throws', async () => {
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

describe('interactionIsBlocking', () => {
  const quick = { settleMs: 50, longTasks: [] };

  it('keeps a genuinely quick interaction green', () => {
    expect(interactionIsBlocking(quick, 1_200)).toBe(false);
  });

  it('fails the run for budget overruns, measurement errors, and long tasks', () => {
    expect(interactionIsBlocking({ ...quick, settleMs: 1_200 }, 1_200)).toBe(true);
    expect(interactionIsBlocking({ ...quick, error: 'probe failed' }, 1_200)).toBe(true);
    expect(interactionIsBlocking({ ...quick, longTasks: [{ duration: 250 }] }, 1_200)).toBe(true);
  });
});

describe('performanceRunIsBlocking', () => {
  it('fails for either a page regression or a broken measurement harness', () => {
    expect(performanceRunIsBlocking([{ failures: ['slow'], harnessError: null }])).toBe(true);
    expect(performanceRunIsBlocking([{ failures: [], harnessError: 'capture failed' }])).toBe(true);
  });

  it('keeps a completely measured, failure-free run green', () => {
    expect(performanceRunIsBlocking([{ failures: [], harnessError: null }])).toBe(false);
  });
});

describe('clipFrozenSpans', () => {
  it('clips a still-frame run to the interaction pending window', () => {
    expect(clipFrozenSpans(
      [{ fromSec: 0, toSec: 8, frames: 33 }],
      2,
      5,
      1,
      4,
    )).toEqual([{ fromSec: 2, toSec: 5, frames: 13 }]);
  });

  it('drops stillness outside the pending window and clipped runs shorter than the threshold', () => {
    expect(clipFrozenSpans([
      { fromSec: 0, toSec: 2.5, frames: 11 },
      { fromSec: 3.2, toSec: 8, frames: 20 },
    ], 2, 3, 1, 4)).toEqual([]);
  });
});
