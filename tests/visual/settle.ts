/**
 * WAIT FOR THE VIEW TO STOP MOVING, then shoot. A shared helper for visual tests.
 *
 * WHY THIS EXISTS. The graph views run a cooling force simulation: nodes keep moving for a second
 * or two after load and then come to rest deterministically (SIM_ALPHA_DECAY in
 * KnowledgeGraph2D.svelte). A screenshot taken before that is a photograph of one arbitrary frame
 * of an animation, and two such screenshots differ for reasons that have nothing to do with the
 * change under test.
 *
 * That is not hypothetical. On 2026-09-18 a session compared a landing screenshot before and after
 * a physics edit, concluded the edit had spaced the nodes out, and was wrong twice over: the nodes
 * had merely drifted, and the file it had edited was not even the one rendering that view. Matt:
 * "Visual testing needs to take multiple screenshots over time, to capture the state a few seconds
 * after load?" — yes, and better still, wait for the signal the app already emits.
 *
 * THE APP ALREADY SAYS WHEN IT IS DONE. `data-graph-settled` is rendered on the graph container by
 * src/routes/(app)/+page.svelte and the review page. Four e2e tests already wait on it. The VISUAL
 * suite did not: it held 37 fixed `waitForTimeout` calls (10 of them 1500ms) and zero references to
 * the signal, so every visual baseline it produced was timing-dependent.
 *
 * TWO GUARDS, because either alone is insufficient:
 *   1. the settle ATTRIBUTE — cheap, exact, and the app's own claim about itself. PRIMARY.
 *   2. PIXEL STABILITY across consecutive frames — because a view can also move for reasons the
 *      simulation knows nothing about (images decoding, fonts swapping, a lazy panel mounting),
 *      and a settled simulation does not mean a settled picture. ADVISORY.
 *
 * PIXEL STABILITY CANNOT BE REQUIRED, and finding that out cost a probe run. The camping starter
 * ships an animated campfire GIF as its mixed-asset sample, so consecutive frames NEVER match and
 * a pixel-equality wait runs until the test times out. Demanding stillness from a page that is
 * legitimately animated turns a correct page into a failing test. So the attribute decides, pixel
 * stability is reported alongside it, and `mask` exists for regions known to animate forever.
 *
 * It returns the elapsed time so a test can assert the view settles at all rather than merely
 * timing out into a screenshot, which is how a hang becomes a passing baseline.
 */
import type { Page } from '@playwright/test';

export interface SettleOptions {
  /** Give up after this long and report it, rather than shooting a moving target silently. */
  timeoutMs?: number;
  /** Consecutive identical frames required before the view is called still. */
  stableFrames?: number;
  /** Gap between comparison frames. */
  intervalMs?: number;
  /** Skip the attribute wait for views that never render a graph container. */
  requireGraphSettled?: boolean;
  /** Selectors for regions that animate forever (GIF assets, spinners) — masked before comparing. */
  mask?: string[];
  /** How long to spend looking for pixel stillness once the attribute is satisfied. */
  pixelBudgetMs?: number;
}

export interface SettleResult {
  elapsedMs: number;
  settledAttribute: boolean;
  stableFrames: number;
  /** True when we gave up rather than observed stillness. The caller should fail on this. */
  timedOut: boolean;
}

/**
 * Resolve once the page has stopped changing. Never throws on timeout — it reports, so the caller
 * decides whether a still-moving view is a failure or merely a slow machine.
 */
export async function waitForSettled(page: Page, opts: SettleOptions = {}): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const need = opts.stableFrames ?? 3;
  const interval = opts.intervalMs ?? 400;
  const started = Date.now();

  let settledAttribute = false;
  if (opts.requireGraphSettled !== false) {
    try {
      await page.waitForSelector('[data-graph-settled="true"]', { timeout: Math.min(timeoutMs, 12_000) });
      settledAttribute = true;
    } catch {
      // A view with no graph container is legitimate; pixel stability still applies below.
      settledAttribute = false;
    }
  }

  const masks = (opts.mask ?? []).map((sel) => page.locator(sel));
  let previous: Buffer | null = null;
  let stable = 0;
  const pixelBudget = Math.min(timeoutMs - (Date.now() - started), opts.pixelBudgetMs ?? 4_000);
  const pixelDeadline = Date.now() + Math.max(0, pixelBudget);
  while (Date.now() < pixelDeadline) {
    const shot = await page.screenshot({ animations: 'allow', mask: masks });
    if (previous && shot.equals(previous)) {
      if (++stable >= need) break;
    } else {
      stable = 0;
    }
    previous = shot;
    await page.waitForTimeout(interval);
  }
  // The ATTRIBUTE decides. Pixel stillness is reported, never required — see the note above about
  // the campfire GIF. A page that animates by design is not a page that failed to settle.
  return {
    elapsedMs: Date.now() - started,
    settledAttribute,
    stableFrames: stable,
    timedOut: !settledAttribute && stable < need,
  };
}

/**
 * Shoot a burst across the settling window and keep them all.
 *
 * For diagnosing MOTION rather than asserting a final state: when a view will not settle, the
 * sequence shows what is still moving, which a single timed-out screenshot cannot. Returns the
 * frames in order so a caller can diff them.
 */
export async function burst(
  page: Page,
  atMs: number[] = [500, 2000, 5000, 9000],
  name?: string,
): Promise<{ atMs: number; bytes: Buffer; changedFromPrevious: boolean }[]> {
  const frames: { atMs: number; bytes: Buffer; changedFromPrevious: boolean }[] = [];
  let elapsed = 0;
  let previous: Buffer | null = null;
  for (const t of [...atMs].sort((a, b) => a - b)) {
    await page.waitForTimeout(Math.max(0, t - elapsed));
    elapsed = t;
    const bytes = await page.screenshot({
      animations: 'allow',
      ...(name ? { path: `tests/visual/screenshots/${name}-${t}ms.png` } : {}),
    });
    frames.push({ atMs: t, bytes, changedFromPrevious: previous ? !bytes.equals(previous) : true });
    previous = bytes;
  }
  return frames;
}
