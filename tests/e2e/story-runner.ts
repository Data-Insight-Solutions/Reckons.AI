import { expect, test, type Locator, type Page } from '@playwright/test';
import { checkAll, performAction, testIdOf, type CheckResult, type StoryPage } from '../../src/lib/rdf/story-ops';
import type { UnifiedStory, UnifiedStep } from '../../src/lib/rdf/story-steps';
import { demoRecorder, type DemoRecorder } from './demo-recorder';

/**
 * F300.3 (kb:story-recorder) — ONE RUNNER PLAYS A STORY.
 *
 * For each step: perform the actions, check every expectation, and, when recording is on, hold
 * the step while its line plays (the existing demo pipeline: tests/e2e/demo-recorder.ts, then
 * scripts/demo/render.ts for narration, captions and the mux). The e2e test and the demo recorder
 * are this same function; recording is only `record.active`, so a video cannot show a step the test
 * did not pass: a failed expectation throws here, the test fails, and render.ts refuses to mux.
 *
 * Order inside a step:
 *   1. the leading open-page actions;
 *   2. when recording, point at the step's focus (story:target, a data-testid) while the line plays;
 *   3. the remaining actions;
 *   4. the step's NAMED EXCEPTION, if it has one (see StepException);
 *   5. every expectation (a false one throws; a note is reported as human-judged, never skipped);
 *   6. the exception's `after` (clean-up such as closing a viewer).
 */

/**
 * Something a story cannot declare yet, kept as code and named. Each is listed in the PR and in
 * kb:story-recorder's progress note, so a gap in the vocabulary stays visible instead of hiding in a test.
 */
export interface StepException {
  /** Why this is code and not a story:action / story:expect. */
  why: string;
  /** Runs after the leading open-page actions, before the subject is pointed at. */
  before?: (page: Page) => Promise<void>;
  /** Runs after the declared actions. `snap` points at the step's subject and holds while the line plays. */
  perform?: (page: Page, snap: (target: Locator) => Promise<void>) => Promise<void>;
  /** Runs after the expectations pass. */
  after?: (page: Page) => Promise<void>;
}

export interface PlayOptions {
  /** Recording on or off. Defaults to demoRecorder(page): a no-op unless `npm run demo:story` set the env. */
  record?: DemoRecorder;
  exceptions?: Record<string, StepException>;
  /** Called at each step's key moment too (the screenshot capture, F34). */
  onSnap?: (step: UnifiedStep, target: Locator) => Promise<void>;
}

export interface StepOutcome { id: string; actions: number; checks: CheckResult[]; exception: string | null }

/** The Playwright side of StoryPage. */
export function playwrightPage(page: Page): StoryPage {
  const by = (id: string) => page.getByTestId(id);
  return {
    goto: async (path) => { await page.goto(path); },
    click: async (id) => { await by(id).click(); },
    fill: async (id, text) => { await by(id).fill(text); },
    expectVisible: async (id) => { await expect(by(id)).toBeVisible({ timeout: 15_000 }); },
    // Search finds an entity by its IRI slug; picking the row selects it (as openAsset in the generated-assets walk did).
    selectEntity: async (iri) => {
      const slug = iri.split(/[/#:]/).pop() ?? iri;
      await page.keyboard.press('Escape');
      await page.getByPlaceholder('search nodes or facts…').fill(slug);
      await page.locator('.sb-node-row').filter({ has: page.locator('.sb-node-iri') }).filter({ hasText: slug }).first().click();
    },
    // countEntities and hasStanding are left out on purpose: the page has no probe for the data yet, and
    // the runner fails loudly on a story that asks for one (story-ops.ts).
  };
}

export async function playStory(page: Page, story: UnifiedStory, opts: PlayOptions = {}): Promise<StepOutcome[]> {
  const record = opts.record ?? demoRecorder(page);
  const sp = playwrightPage(page);
  const outcomes: StepOutcome[] = [];
  for (const step of story.steps) {
    await test.step(`${step.order}. ${step.title}`, async () => {
      const ex = opts.exceptions?.[step.id];
      const snap = async (target: Locator) => {
        await record.hold(target);
        await opts.onSnap?.(step, target);
      };
      const run = async () => {
        const lead = step.actions.findIndex((a) => a.kind !== 'open-page');
        const leading = lead < 0 ? step.actions : step.actions.slice(0, lead);
        const rest = lead < 0 ? [] : step.actions.slice(lead);
        for (const a of leading) await performAction(sp, a);
        if (ex?.before) await ex.before(page);
        if (step.focus) await snap(page.getByTestId(testIdOf(step.focus.ref, 'focus')));
        for (const a of rest) await performAction(sp, a);
        if (ex?.perform) await ex.perform(page, snap);
        const checks = await checkAll(sp, step.expects);
        if (ex?.after) await ex.after(page);
        outcomes.push({ id: step.id, actions: step.actions.length, checks, exception: ex?.why ?? null });
      };
      await record.step(step.id, run);
    });
  }
  record.finish();
  return outcomes;
}
