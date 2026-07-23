import type { Page } from '@playwright/test';

/**
 * `page.evaluate` that survives a navigation racing it.
 *
 * WHY THIS EXISTS: Reckons.AI is a SvelteKit SPA, so a click — or a late redirect during
 * hydration — swaps the execution context out from under an in-flight evaluate. Playwright then
 * throws "Execution context was destroyed, most likely because of a navigation".
 *
 * On 2026-07-18 that single error was failing 10 of 47 user-story workflow tests AND 4 of the 6
 * routes in the button crawler. The crawler's damage was the worse kind: it caught the per-route
 * failure, skipped the route, and still printed "crashes: 0" — a green report that had never
 * tested two thirds of the app. A log that is always green is not a record.
 *
 * The fix is to treat a destroyed context as RETRYABLE rather than fatal: wait for the new
 * document to settle, then run once more. A second failure is a real failure and propagates.
 *
 * This does NOT paper over genuine errors — it matches only the navigation-race message. Anything
 * else (a thrown TypeError inside the callback, a bad selector) rethrows immediately.
 */

const NAV_RACE = /Execution context was destroyed|Most likely the page has been closed|frame was detached/i;

export async function evalStable<R>(page: Page, fn: () => R): Promise<R>;
export async function evalStable<A, R>(page: Page, fn: (arg: A) => R, arg: A): Promise<R>;
export async function evalStable(page: Page, fn: unknown, arg?: unknown): Promise<unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (page.evaluate as any)(fn, arg);
  } catch (err) {
    if (!NAV_RACE.test(String((err as Error)?.message ?? ''))) throw err;

    // The context died mid-flight. Let the replacement document finish arriving, then retry once.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(250);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (page.evaluate as any)(fn, arg);
  }
}
