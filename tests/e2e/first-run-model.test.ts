import { test, expect, type Page } from '@playwright/test';
import { clearStorage } from './helpers';

/**
 * FIRST RUN — the path a real new user takes, with no API key and no cached model.
 *
 * This is the app's least-tested and highest-stakes surface. Every other suite runs on mock
 * backends AND installs a consent dismisser (helpers.ts startConsentDismisser) that clicks
 * "Not now" the moment a model-download prompt appears — so the entire model-loading experience,
 * the thing a first-time user meets before anything else works, has been systematically stepped
 * around by the tests that were supposed to cover it.
 *
 * These tests deliberately do NOT use waitForApp(): they drive the dialog instead of dismissing it.
 *
 * The WASM backend is forced via localStorage['__reckons_test_backend__'] (db.ts:375), the existing
 * test-only override, so no IndexedDB or settings mutation is needed.
 *
 * NETWORK: none of these download a model. They exercise the CONSENT GATE, which is pure UI and
 * runs offline. An opt-in test that performs a real download lives at the bottom, behind
 * RECKONS_TEST_WASM=1, because a 500 MB fetch from a CDN is not something a default test run
 * should do.
 */

/** Load the app WITHOUT the consent auto-dismisser, forcing a given backend. */
async function firstRun(page: Page, backend = 'wasm'): Promise<void> {
  await page.goto('/');
  await clearStorage(page);
  await page.addInitScript((b) => {
    localStorage.setItem('__reckons_test_backend__', b);
  }, backend);
  await gotoRetry(page, '/');
  await page.locator('nav').waitFor({ timeout: 20_000 });
}

/** goto that retries the vite/service-worker net::ERR_ABORTED flake (see tests/e2e/helpers.ts). */
async function gotoRetry(page: Page, url: string) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); return; }
    catch (e) { if (i >= 2) throw e; await page.waitForTimeout(400); }
  }
}

/**
 * Decline every consent the pipeline raises, in order, and return how many there were.
 *
 * A keyless first run asks TWICE — the ~500 MB extraction LLM, then the ~33 MB embedding model
 * (verified 2026-07-18: Qwen2.5-0.5B-Instruct, then bge-small-en-v1.5). Each is a separate model
 * with its own consent, which is correct; a single "download everything?" would be less honest.
 * Tests must therefore drain the QUEUE, not assume one dialog.
 */
async function declineAllConsents(page: Page, max = 4): Promise<number> {
  let n = 0;
  for (let i = 0; i < max; i++) {
    const dialog = page.locator('.consent-dialog');
    if (!(await dialog.isVisible().catch(() => false))) break;
    await page.getByRole('button', { name: /not now/i }).click().catch(() => {});
    await page.waitForTimeout(1200);
    n++;
  }
  return n;
}

/** Start an ingest, which is what pulls an in-browser model on a keyless first run. */
async function startIngest(page: Page, title = 'First Run Co', body = 'First Run Co has 12 employees and was founded in 2021 in Leeds.') {
  await gotoRetry(page, '/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(body);
  const submit = page.getByRole('button', { name: /extract facts/i });
  await expect(submit).not.toBeDisabled({ timeout: 10_000 });
  await submit.click();
}

const consentDialog = (page: Page) => page.locator('.consent-dialog');

test.describe('first run — the model-download consent gate', () => {
  test('a keyless first ingest ASKS before downloading anything', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);

    // The gate must appear. Downloading hundreds of MB without asking would be the real defect.
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });
  });

  test('the prompt states WHICH model and HOW BIG before asking for a yes', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    const dialog = consentDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Informed consent means naming the cost. A bare "download?" is not a fair question.
    await expect(dialog).toContainText(/MB/i);
    await expect(dialog.getByRole('button', { name: /download/i }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: /not now/i })).toBeVisible();
  });

  test('declining does not hang the pipeline or crash the app', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    // A keyless first run asks twice (extraction LLM, then embedding model), so drain the queue.
    const asked = await declineAllConsents(page);
    expect(asked).toBeGreaterThan(0);

    // Every consent promise must resolve — an unresolved one parks the awaited pipeline forever.
    await expect(consentDialog(page)).toBeHidden({ timeout: 15_000 });

    // And the app must still be usable rather than wedged behind a dead await.
    await gotoRetry(page, '/');
    await expect(page.locator('nav')).toBeVisible({ timeout: 15_000 });
    expect(pageErrors.join('\n')).not.toMatch(/undefined is not|cannot read/i);
  });

  test('dismissing with Escape also resolves the gate', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    // onOpenChange(false) → resolveConsent(false). If Escape did NOT resolve, the awaited
    // promise would never settle and the ingest would hang forever with no UI to recover it.
    //
    // Asserting "the dialog is gone" is WRONG here and was flaky (2 pass / 1 fail over 3 runs):
    // resolving the first consent immediately raises the second one, so the shared
    // `.consent-dialog` selector is visible again almost at once. What proves Escape worked is
    // that the FIRST model's prompt is no longer showing — the queue advanced.
    const firstModel = (await page.locator('.consent-body').textContent())?.trim() ?? '';
    expect(firstModel).not.toBe('');

    await page.keyboard.press('Escape');
    await expect
      .poll(async () => {
        if (!(await consentDialog(page).isVisible().catch(() => false))) return 'gone';
        return (await page.locator('.consent-body').textContent())?.trim() ?? '';
      }, { timeout: 15_000 })
      .not.toBe(firstModel);
  });

  test('the sideload escape hatch is offered, not just download-or-nothing', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    const dialog = consentDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // A user on a metered connection needs a third option to exist at all.
    await expect(dialog.getByRole('link', { name: /settings/i })).toBeVisible();
  });
});

test.describe('first run on a memory-constrained device (iOS)', () => {
  // Every iOS browser is WebKit and shares a tight per-tab memory ceiling, so a ~500MB in-browser
  // model can OOM-crash the tab — an error that CANNOT be caught in JS. device-capability.ts
  // detects this from the user agent, so a spoofed UA drives the same branch.
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });

  test('offers graceful alternatives INSTEAD of a download that may crash the tab', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    const dialog = consentDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // The constrained branch leads with routes that cannot crash the device.
    await expect(dialog).toContainText(/may not fit this device/i);
    await expect(dialog.getByRole('button', { name: /ollama/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /api key/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /tiny model/i })).toBeVisible();
  });

  test('the risky option is available but honestly labelled', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    const dialog = consentDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // The user is not prevented from proceeding — they are told the truth first. "may crash" in
    // the button text is the honest-status rule applied to a control.
    const anyway = dialog.getByRole('button', { name: /download anyway/i });
    await expect(anyway).toBeVisible();
    await expect(anyway).toContainText(/crash/i);
  });

  test('warns that a tiny in-browser model will not reliably extract facts', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    const dialog = consentDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Overselling the tiny model would send users down a path that quietly fails at the app's
    // core job. The warning has to be present BEFORE they choose it.
    await expect(dialog).toContainText(/chat only|won.t reliably extract|basic chat/i);
  });

  test('"try a tiny model" switches the model and tells the user what changed', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /tiny model/i }).click();
    await page.waitForTimeout(1500);

    // The LLM consent resolved: what follows is the SEPARATE embedding-model prompt, not the
    // constrained-device offer again. That is how we know the choice took effect.
    const dialog = consentDialog(page);
    if (await dialog.isVisible().catch(() => false)) {
      await expect(dialog).not.toContainText(/may not fit this device/i);
    }
    await declineAllConsents(page);
    await expect(consentDialog(page)).toBeHidden({ timeout: 15_000 });
  });

  /**
   * KNOWN UX DEFECT, found 2026-07-18 by this suite.
   *
   * `tryTiny()` (DownloadConsentDialog.svelte) pushes a notification explaining that the model was
   * switched and that a tiny model is chat-only — genuinely important guidance, since the user just
   * chose a model that will not extract facts. But resolving the consent immediately raises the
   * NEXT consent (the embedding model), whose modal covers the notification. The user is told
   * something they cannot read.
   *
   * Marked test.fail() so it is recorded rather than lost, and flags the moment it is fixed.
   * A fix would defer the notification until no consent is pending, or fold the guidance into the
   * next dialog.
   */
  test('DEFECT — the "switched to tiny model" guidance is readable, not buried by the next modal', async ({ page }) => {
    test.fail();
    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /tiny model/i }).click();
    await expect(page.getByText(/switched to the tiny model/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('"connect Ollama" routes to the integrations settings', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /ollama/i }).click();
    await page.waitForURL(/\/settings\/integrations/, { timeout: 15_000 });
  });

  test('"add an API key" routes to settings', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /api key/i }).click();
    await page.waitForURL(/\/settings/, { timeout: 15_000 });
  });
});

/**
 * REAL download + inference. Opt-in only:
 *   RECKONS_TEST_WASM=1 npx playwright test first-run-model --project=desktop-chrome
 *
 * Skipped by default because it fetches hundreds of MB from a CDN — a default `npm test` that
 * silently pulls that much is a bad neighbour, and a CI job that depends on huggingface.co is
 * flaky by construction. But the path needs to be exercised SOMETIME, and a test that exists and
 * is skipped is honest; pretending the consent gate proves the download works would not be.
 */
test.describe('real WASM model load (opt-in)', () => {
  test.skip(!process.env.RECKONS_TEST_WASM, 'set RECKONS_TEST_WASM=1 to run a real model download');
  test.setTimeout(15 * 60_000);

  test('accepting the download actually loads a model and produces facts', async ({ page }) => {
    await firstRun(page);
    await startIngest(page);
    await expect(consentDialog(page)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /^download/i }).first().click();
    await expect(consentDialog(page)).toBeHidden({ timeout: 30_000 });

    // The whole point: after consenting, the pipeline completes and facts land for review.
    await page.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 13 * 60_000 });
    await page.goto('/review');
    await expect(page.getByText(/first run co/i).first()).toBeVisible({ timeout: 60_000 });
  });
});
