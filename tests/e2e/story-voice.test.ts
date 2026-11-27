import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Story narration, end to end (Matt, 2026-11-25: "audio output seems broken ... Seemed like a full page refresh to
 * enable audio, but then it didn't work ... we obviously need audio tests improved").
 *
 * What this proves: the WIRING. A step is handed to the voice and played; after a reload, when the browser refuses
 * sound until the page is clicked, the reader is shown "tap to hear" and the tap plays it. The voice is the stand-in
 * (kokoro-tts.ts testVoiceOn: silent WAVs, mock build plus the reckons-test-voice flag), and play() is replaced by
 * one that follows the browser rule: refused (NotAllowedError) until the page has had a click or key press.
 * What it does NOT prove: that the real ~87 MB model downloads, loads and sounds right in a real browser. That
 * needs a person listening, and is marked for a human recheck in the graph rather than claimed here.
 */
async function standInVoice(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('reckons-test-voice', '1');
    const w = window as unknown as { __plays: number; __refused: number };
    w.__plays = 0; w.__refused = 0;
    // The strict rule (Firefox, Safari): sound only after a click or key press IN THIS DOCUMENT. Playwright's own
    // navigations count as a gesture for navigator.userActivation, so that flag cannot stand in for the rule here.
    let gestured = false;
    for (const t of ['pointerdown', 'keydown']) addEventListener(t, (e) => { if (e.isTrusted) gestured = true; }, true);
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!gestured) {
        w.__refused++;
        return Promise.reject(new DOMException('play() can only be initiated by a user gesture', 'NotAllowedError'));
      }
      w.__plays++;
      setTimeout(() => this.dispatchEvent(new Event('ended')), 30);
      return Promise.resolve();
    };
  });
}
const plays = (page: Page) => page.evaluate(() => (window as unknown as { __plays: number }).__plays);
const refused = (page: Page) => page.evaluate(() => (window as unknown as { __refused: number }).__refused);

test('narration plays after "Enable voice"; a new tab with no click yet gets "tap to hear", not silence', async ({ page, context }) => {
  await clearStorage(page);
  await standInVoice(context);
  await waitForApp(page);

  await page.goto('/about?example=data-insight-solutions&story=1&autoplay=1');
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.locator('.story-step-label').first()).toHaveText('1 / 10');

  // The voice gate; the click on it is the gesture that lets sound play.
  await page.getByRole('button', { name: 'Enable voice', exact: true }).click();
  await expect.poll(() => plays(page), { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Tap to hear Shelly' })).toHaveCount(0);

  // Voice is now on, and saved. The same story in a NEW TAB has had no click: the browser refuses sound there,
  // as Firefox and Safari do after a reload and every browser does for a tab a link opened.
  await page.waitForTimeout(1500); // the settings save is debounced
  const fresh = await context.newPage();
  await fresh.goto(page.url());
  await expect(fresh.locator('.story-step-label').first()).toBeVisible({ timeout: 30000 });
  // Autoplay with voice on, straight away (voice was chosen already, so no gate) — and refused:
  const tap = fresh.getByRole('button', { name: 'Tap to hear Shelly' });
  await expect(tap).toBeVisible({ timeout: 15000 });
  expect(await refused(fresh)).toBeGreaterThan(0);
  expect(await plays(fresh)).toBe(0); // the refused sentence was not counted as spoken

  // The tap is the gesture; this time it plays.
  await tap.click();
  await expect.poll(() => plays(fresh), { timeout: 15000 }).toBeGreaterThan(0);
  await expect(tap).toHaveCount(0);
});
