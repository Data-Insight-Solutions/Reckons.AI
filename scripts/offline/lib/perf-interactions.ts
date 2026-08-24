import type { Page } from '@playwright/test';

export interface InteractionMeasurement {
  /** End-to-end time from immediately before the click through the last observed DOM activity. */
  responseMs: number;
  /** True when the interaction had not gone quiet before the total interaction budget expired. */
  timedOut: boolean;
  /** True when navigation replaced the document and the probe had to resume on the new page. */
  probeReset: boolean;
}

export interface BlockingInteraction {
  settleMs: number;
  longTasks: unknown[];
  error?: string;
}

export interface PerformanceResult {
  failures: readonly unknown[];
  harnessError?: string | null;
}

export interface FrozenSpan {
  fromSec: number;
  toSec: number;
  frames: number;
}

/**
 * Limit detected still-frame runs to the interval in which the UI claimed work was pending.
 *
 * A run can begin while a flow is idle and continue through the click, or continue after the
 * result is usable. Returning that whole run overstates the freeze and can even fail a flow for
 * healthy stillness outside the interaction. Clipping first makes both the duration and reported
 * frame count describe only the pending window.
 */
export function clipFrozenSpans(
  spans: FrozenSpan[],
  pendingFromSec: number,
  pendingUntilSec: number,
  minimumDurationSec = 1,
  framesPerSecond = 4,
): FrozenSpan[] {
  const windowFrom = Math.max(0, pendingFromSec);
  const windowUntil = Math.max(windowFrom, pendingUntilSec);

  return spans.flatMap((span) => {
    const fromSec = Math.max(span.fromSec, windowFrom);
    const toSec = Math.min(span.toSec, windowUntil);
    const durationSec = toSec - fromSec;
    if (durationSec < minimumDurationSec) return [];
    return [{
      fromSec,
      toSec,
      frames: Math.floor(durationSec * framesPerSecond) + 1,
    }];
  });
}

interface ProbeWindow extends Window {
  __perfInteractionProbe?: {
    startedAt: number;
    lastActivityAt: number;
    observer: MutationObserver;
  };
}

/**
 * Measure a click from BEFORE its handler starts until the DOM is quiet.
 *
 * The probe must exist before `click`: a MutationObserver installed afterwards cannot see
 * synchronous mutations, and a timer started afterwards omits the click handler itself. The
 * minimum observation window catches reactions that start shortly after the handler returns
 * without charging that fixed wait to a fast interaction.
 */
export async function measureClickToQuiet(
  page: Page,
  click: () => Promise<unknown>,
  options: { budgetMs: number; minimumObserveMs: number; quietMs?: number },
): Promise<InteractionMeasurement> {
  const budgetMs = Math.max(1, options.budgetMs);
  const minimumObserveMs = Math.max(0, options.minimumObserveMs);
  const quietMs = Math.max(0, options.quietMs ?? 250);
  const hostStartedAt = Date.now();

  await page.evaluate(() => {
    const target = window as ProbeWindow;
    target.__perfInteractionProbe?.observer.disconnect();
    const startedAt = Date.now();
    const probe = {
      startedAt,
      lastActivityAt: startedAt,
      observer: new MutationObserver(() => {
        probe.lastActivityAt = Date.now();
      }),
    };
    probe.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    target.__perfInteractionProbe = probe;
  });

  try {
    await click();
  } catch (error) {
    await page.evaluate(() => {
      const target = window as ProbeWindow;
      target.__perfInteractionProbe?.observer.disconnect();
      delete target.__perfInteractionProbe;
    }).catch(() => {});
    throw error;
  }

  const sameDocument = await page.evaluate(
    async ({ budget, minimumObserve, quiet }) => {
      const target = window as ProbeWindow;
      const probe = target.__perfInteractionProbe;
      if (!probe) return null;

      const clickCompletedAt = Date.now();
      return await new Promise<InteractionMeasurement>((resolve) => {
        const finish = (timedOut: boolean) => {
          clearInterval(timer);
          probe.observer.disconnect();
          delete target.__perfInteractionProbe;
          const lastResponseAt = Math.max(probe.lastActivityAt, clickCompletedAt);
          resolve({
            responseMs: Math.max(0, Math.round(lastResponseAt - probe.startedAt)),
            timedOut,
            probeReset: false,
          });
        };
        const timer = setInterval(() => {
          const now = Date.now();
          if (now - probe.startedAt >= budget) finish(true);
          else if (now - clickCompletedAt >= minimumObserve && now - probe.lastActivityAt >= quiet) finish(false);
        }, Math.min(50, Math.max(5, quiet || 5)));
      });
    },
    { budget: budgetMs, minimumObserve: minimumObserveMs, quiet: quietMs },
  ).catch(() => null);

  if (sameDocument) return sameDocument;

  /*
   * Navigation replaces `window` and therefore the pre-click observer. Preserve the elapsed
   * navigation/click time, then observe the destination for the remaining budget. This is less
   * detailed than the same-document path but still never reports a navigation as a zero-ms click.
   */
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const elapsedBeforeProbe = Date.now() - hostStartedAt;
  return page.evaluate(
    async ({ elapsed, budget, minimumObserve, quiet }) => {
      if (elapsed >= budget) return { responseMs: elapsed, timedOut: true, probeReset: true };
      const observedAt = Date.now();
      let lastActivityAt = observedAt;
      const observer = new MutationObserver(() => { lastActivityAt = Date.now(); });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

      return await new Promise<InteractionMeasurement>((resolve) => {
        const timer = setInterval(() => {
          const now = Date.now();
          if (elapsed + (now - observedAt) >= budget) {
            clearInterval(timer);
            observer.disconnect();
            resolve({ responseMs: Math.max(elapsed, budget), timedOut: true, probeReset: true });
          } else if (now - observedAt >= minimumObserve && now - lastActivityAt >= quiet) {
            clearInterval(timer);
            observer.disconnect();
            resolve({
              responseMs: Math.max(0, Math.round(elapsed + lastActivityAt - observedAt)),
              timedOut: false,
              probeReset: true,
            });
          }
        }, Math.min(50, Math.max(5, quiet || 5)));
      });
    },
    { elapsed: elapsedBeforeProbe, budget: budgetMs, minimumObserve: minimumObserveMs, quiet: quietMs },
  );
}

/** One definition of failure for the console summary and the process exit status. */
export function interactionIsBlocking(result: BlockingInteraction, budgetMs: number): boolean {
  return Boolean(result.error) || result.settleMs >= budgetMs || result.longTasks.length > 0;
}

/** A broken measurement is a failed run, even when it gathered no page-level budget failures. */
export function performanceRunIsBlocking(results: readonly PerformanceResult[]): boolean {
  return results.some((result) => Boolean(result.harnessError) || result.failures.length > 0);
}
