import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { demoRecorder, isDemoRender } from './demo-recorder';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * TEST WORKFLOW: GUIDED WALK (F275.22.3 / kb:docs-video-new-workflows) — open a story, step through it
 * with Next and Back, watch each step light its own items and dim the rest, and come back to a step
 * from its link. It documents content/features/guided-walks.md (F292.2, kb:story-walk-player).
 *
 * THE STEPS ARE NOT WRITTEN HERE. They are the ktype:TestStep triples of test:Workflow-GuidedWalk in
 * static/docs-testing.ttl; this file supplies what each step does, keyed by step id, and fails if the
 * two lists differ (the pattern of workflow-readme-path.test.ts). The player's own behaviour
 * (positions do not move, arrow keys, phone bar) is proved in story-walk.test.ts; this one shows it.
 *
 * Data is synthetic: a small community garden with a three-step story, written the way
 * story-walk.test.ts writes its own.
 */

const WORKFLOW_ID = 'guided-walk';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

const S = 'urn:test:garden/';
const STORY = S + 'story';
const ITEMS = ['Seedlings', 'Compost', 'Rain barrel', 'Tool shed', 'Beds', 'Volunteers'];
const STEPS: { title: string; caption: string; lit: string[] }[] = [
  { title: 'Where food starts', caption: 'Seedlings begin in the shed and move to the beds.', lit: ['Seedlings', 'Beds'] },
  { title: 'What feeds the soil', caption: 'Compost and rainwater keep the beds healthy.', lit: ['Compost', 'Rain barrel'] },
  { title: 'Who keeps it going', caption: 'Volunteers share the tools in the shed.', lit: ['Volunteers', 'Tool shed'] },
];

async function seed(page: Page) {
  await page.evaluate(async ({ S, STORY, ITEMS, STEPS }) => {
    const path = '/src/lib/stores/kb.svelte.ts';
    const kb = await import(/* @vite-ignore */ path);
    const at = Date.now();
    let n = 0;
    const iri = (value: string) => ({ kind: 'iri' as const, value });
    const lit = (value: string, datatype?: string) => ({ kind: 'literal' as const, value, ...(datatype ? { datatype } : {}) });
    const st = (s: string, p: string, o: ReturnType<typeof iri> | ReturnType<typeof lit>) => ({
      id: 'gw-' + n++, s: iri(s), p: iri(p), o, g: iri('urn:kbase:source/gw'), sourceId: 'gw', confidence: 1, status: 'confirmed' as const, createdAt: at, updatedAt: at,
    });
    const sl = (x: string) => x.toLowerCase().replace(/ /g, '-');
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#label';
    const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const sts: ReturnType<typeof st>[] = [];
    ITEMS.forEach((name, i) => {
      sts.push(st(S + sl(name), RDFS, lit(name)), st(S + sl(name), TYPE, iri('urn:kbase:type/Thing')),
        st(S + sl(name), 'urn:kbase:predicate/next-to', iri(S + sl(ITEMS[(i + 1) % ITEMS.length]))));
    });
    sts.push(st(STORY, TYPE, iri('urn:reckons:story/Story')), st(STORY, RDFS, lit('A tour of the community garden')));
    STEPS.forEach((s, i) => {
      const step = S + 'step' + (i + 1);
      sts.push(st(step, TYPE, iri('urn:reckons:story/Step')), st(step, 'urn:reckons:story/partOf', iri(STORY)),
        st(step, 'urn:reckons:story/order', lit(String(i + 1), 'http://www.w3.org/2001/XMLSchema#integer')),
        st(step, 'urn:reckons:story/title', lit(s.title)), st(step, 'urn:reckons:story/content', lit(s.caption)));
      for (const h of s.lit) sts.push(st(step, 'urn:reckons:story/highlight', iri(S + sl(h))));
    });
    await kb.addStatements(sts as never, 'gw');
  }, { S, STORY, ITEMS, STEPS });
}

const counter = (page: Page) => page.locator('.story-step-label').first();
const controls = (page: Page) => page.locator('.story-controls').first();
const dimmed = (page: Page) => page.locator('.node-label.dim-hidden').allTextContents();
const litNow = (page: Page) => page.locator('.node-label:not(.dim-hidden)').allTextContents();

async function open(page: Page, step?: number) {
  await page.goto('/?story=' + encodeURIComponent(STORY) + (step ? '&step=' + step : ''), { waitUntil: 'domcontentloaded' });
  await page.locator('nav').waitFor({ timeout: 15_000 });
}

/** Every label drawn lit belongs to the step, at least one is drawn, and some other label is dimmed. */
async function expectLit(page: Page, names: string[]) {
  await expect.poll(async () => {
    const l = await litNow(page); const d = await dimmed(page);
    return l.length > 0 && l.every((x) => names.includes(x)) && !d.some((x) => names.includes(x)) && d.length > 0;
  }, { timeout: 20_000 }).toBe(true);
}

const impls: Record<string, StepImpl> = {
  'open-walk': async (page, snap) => {
    await open(page);
    await expect(counter(page)).toHaveText('1 / 3', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Previous step' })).toBeDisabled();
    await snap(controls(page));
  },
  'lit-items': async (page, snap) => {
    await expectLit(page, STEPS[0].lit);
    await page.waitForTimeout(1_500);
    await snap(page.locator('main canvas').first());
  },
  'next-step': async (page, snap) => {
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(counter(page)).toHaveText('2 / 3');
    await expectLit(page, STEPS[1].lit);
    expect(new URL(page.url()).searchParams.get('step')).toBe('2');
    await snap(controls(page));
  },
  'back-step': async (page, snap) => {
    await page.getByRole('button', { name: 'Previous step' }).click();
    await expect(counter(page)).toHaveText('1 / 3');
    await expectLit(page, STEPS[0].lit);
    await snap(controls(page));
  },
  'step-link': async (page, snap) => {
    await open(page, 3);
    await expect(counter(page)).toHaveText('3 / 3', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Next step' })).toBeDisabled();
    await expectLit(page, STEPS[2].lit);
    await snap(controls(page));
  },
};

test.beforeEach(async ({ page }) => {
  if (!isDemoRender()) await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await seed(page);
});

test('the steps in the graph and the steps this test runs are the same list', () => {
  expect(Object.keys(impls).sort()).toEqual(workflow.steps.map((s) => s.id).sort());
});

test(`${workflow.title}`, async ({ page }) => {
  const demo = demoRecorder(page);
  test.setTimeout(demo.active ? 600_000 : 240_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const step of workflow.steps) {
    await test.step(`${step.order}. ${step.title} (${step.page})`, async () => {
      const snap: Snap = async (target) => {
        await demo.hold(target);
        if (!CAPTURE_DIR) return;
        await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(900);
        const cleanup = await boxTarget(page, target, step.boxLabel);
        const png = await page.screenshot({ fullPage: false });
        await cleanup();
        writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
      };
      await demo.step(step.id, () => impls[step.id](page, snap));
    });
  }
  demo.finish();
});
