import { expect, test, type Locator, type Page } from '@playwright/test';
import { checkAll, performAction, testIdOf, type CheckResult, type JobStage, type StatementRow, type StoryPage } from '../../src/lib/rdf/story-ops';
import { advertiseRunner, finishJob, jobRequests, linkRunner } from './synthetic-runner';
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
 *   2. the step's focus (story:target, a data-testid) is pointed at just before the click that presses it,
 *      or, when no action presses it, at the end of the step after step 5;
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
  before?: (page: Page, snap: (target: Locator) => Promise<void>) => Promise<void>;
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
    press: async (key) => { await page.keyboard.press(key); },
    expectVisible: async (id) => { await expect(by(id)).toBeVisible({ timeout: 15_000 }); },
    // Search finds an entity by its IRI slug; picking the row selects it (as openAsset in the generated-assets walk did).
    selectEntity: async (iri) => {
      const slug = iri.split(/[/#:]/).pop() ?? iri;
      await page.keyboard.press('Escape');
      await page.getByPlaceholder('search nodes or facts…').fill(slug);
      await page.locator('.sb-node-row').filter({ has: page.locator('.sb-node-iri') }).filter({ hasText: slug }).first().click();
    },
    // THE PROBES (count, standing). They read the statements of the open space from the app's own database
    // through the dev server's module path (/src/lib/storage/db.ts), exactly as the specs already do. That path
    // exists only on `vite dev` (dev:test); a production build serves bundled assets, so this adds NO hook to
    // the shipped app. The UI has no counter for "N entities of a type" or a per-statement status to read, which
    // is why a probe is needed at all; story-ops.ts turns the rows into a count or a standing (pure, unit-tested).
    statementRows: () => page.evaluate(async () => {
      const path = '/src/lib/storage/db.ts';
      const { db } = await import(/* @vite-ignore */ path);
      const rows = (await db.statements.toArray()) as { s: { value: string }; p: { value: string }; o: { value: string }; status: string; needsObject?: boolean; proposalOption?: string }[];
      return rows.map((r) => ({ s: r.s.value, p: r.p.value, o: r.o.value, status: r.status, needsObject: r.needsObject, proposalOption: r.proposalOption }));
    }) as Promise<StatementRow[]>,
    // A missing element must fail the check quickly, not wait out the whole test timeout; the check itself retries (patience).
    patience: 15_000,
    // textContent, not innerText: the page uppercases some labels with CSS, and a story quotes the words as written.
    textOf: async (id) => (await by(id).first().textContent({ timeout: 1_000 })) ?? '',
    attrOf: async (id, name) => by(id).first().getAttribute(name, { timeout: 1_000 }),
    mediaWidth: (id) => by(id).first().evaluate((el) => {
      if (el instanceof HTMLImageElement) return el.complete ? el.naturalWidth : 0;
      if (el instanceof HTMLVideoElement) return el.readyState >= HTMLMediaElement.HAVE_METADATA ? el.videoWidth : 0;
      return 0;
    }, undefined, { timeout: 1_000 }),
    // Fetch the receipt and the served file in the page, hash it, and compare with what the receipt recorded.
    receiptOf: (slug, stage) => page.evaluate(async ({ slug, stage }) => {
      const receipt = await (await fetch(`/generated/${slug}/receipt.json`)).json();
      const r = receipt.stages[stage];
      const bytes = await (await fetch(`/generated/${slug}/${r.output.file}`)).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { accepted: r.check.pass as boolean, matches: hex === r.output.sha256, generated: receipt.generated as boolean, licenses: r.models.map((m: { license: string }) => m.license) as string[] };
    }, { slug, stage }),
    countElements: async (id, where) => {
      // Wait for the count to settle on what the page shows, rather than reading it mid-render.
      const sel = where ? `[data-testid="${id}"][${where.attr}="${where.is}"]` : `[data-testid="${id}"]`;
      return page.locator(sel).count();
    },
    runJob: (stage, params) => runSyntheticJob(page, stage, params),
  };
}

/**
 * run-job, in the browser: the synthetic file-queue runner (tests/e2e/synthetic-runner.ts) stands in for the GPU
 * tools. The job is started the way a person starts it, through the Shelly story's own controls, so the app writes
 * the request itself; the runner then completes that request with the committed, checked asset. A job kind is a
 * stage and typed parameters (story-ops.ts JOB_KINDS), never a command.
 */
async function runSyntheticJob(page: Page, stage: JobStage, params: Record<string, string | number | boolean>) {
  await advertiseRunner(page);
  await linkRunner(page);
  const heading = page.getByRole('heading', { name: 'Let’s create something' });
  if (!(await heading.isVisible().catch(() => false))) {
    await page.evaluate(async () => {
      const path = '/src/lib/stores/shelly-bridge.svelte.ts';
      const bridge = await import(/* @vite-ignore */ path);
      bridge.startExplore();
    });
    await page.getByRole('button', { name: /Create an asset with Shelly/ }).click();
    await expect(heading).toBeVisible();
    await linkRunner(page); // layout startup can restore an empty workspace after the first link
  }
  const reconnect = page.getByRole('button', { name: 'Reconnect runner', exact: true });
  if (await reconnect.isVisible().catch(() => false)) await reconnect.click();
  const before = (await jobRequests(page)).filter((j) => j.stage === stage).length;
  if (stage === 'image') {
    await page.getByLabel('What image would you like?').fill(String(params.prompt));
    await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  } else if (stage === 'video') {
    await page.getByRole('button', { name: 'Make a video', exact: true }).click();
    await page.getByLabel('How should the scene move?').fill(String(params.motion));
    await page.getByRole('button', { name: 'Generate video', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Make a Gaussian splat', exact: true }).click();
  }
  await expect.poll(async () => (await jobRequests(page)).filter((j) => j.stage === stage).length, { timeout: 15_000 }).toBe(before + 1);
  const job = (await jobRequests(page)).filter((j) => j.stage === stage).at(-1)!;
  await finishJob(page, job.id);
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
        if (ex?.before) await ex.before(page, snap);
        // The focus is pointed at where a person would look: just before the click that presses it (the card, the
        // button, after any typing), else at the end of the step, once its expectations have passed (the asset a
        // click opened, the row of labels that has settled).
        const focus = step.focus ? page.getByTestId(testIdOf(step.focus.ref, 'focus')) : null;
        let pointed = false;
        for (const a of rest) {
          if (focus && !pointed && a.kind === 'click' && a.target === step.focus!.ref) { await snap(focus); pointed = true; }
          await performAction(sp, a);
        }
        if (ex?.perform) await ex.perform(page, snap);
        const checks = await checkAll(sp, step.expects);
        if (focus && !pointed) await snap(focus);
        if (ex?.after) await ex.after(page);
        outcomes.push({ id: step.id, actions: step.actions.length, checks, exception: ex?.why ?? null });
      };
      await record.step(step.id, run);
    });
  }
  record.finish();
  return outcomes;
}
