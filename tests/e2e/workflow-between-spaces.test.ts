import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { demoRecorder, isDemoRender } from './demo-recorder';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * TEST WORKFLOW: MOVING BETWEEN SPACES (F275.22.3 / kb:docs-video-new-workflows) — two spaces on one
 * device, the map that joins them, a jump (leap) from one item to the other space, and the way back.
 * It documents content/features/kb-leap.md and multi-kb.md (kb:multi-kb). The map's own behaviour is
 * proved in spaces-map.test.ts; this one shows the path a person takes.
 *
 * THE STEPS ARE NOT WRITTEN HERE. They are the ktype:TestStep triples of test:Workflow-BetweenSpaces in
 * static/docs-testing.ttl; this file supplies what each step does, keyed by step id, and fails if the
 * two lists differ (the pattern of workflow-readme-path.test.ts).
 *
 * Data is synthetic: a garden-plans space whose tomato item jumps to a seed-library space, written
 * the way spaces-map.test.ts writes its own spaces.
 */

const WORKFLOW_ID = 'between-spaces';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

const GARDEN = 'Garden plans';
const SEEDS = 'Seed library';
const SEEDS_STABLE_ID = '5eed5eed-0000-4000-8000-000000000012';
const GARDEN_STABLE_ID = '9a7de000-0000-4000-8000-000000000011';

/** Write both spaces the way the app does (registry entry + own database), then open the garden one. */
async function seedSpaces(page: Page): Promise<void> {
  const reloaded = page.waitForEvent('load');
  await page.evaluate(async ({ garden, seeds, seedsId, gardenId }) => {
    const registryPath = '/src/lib/storage/kb-registry.ts';
    const dbPath = '/src/lib/storage/db.ts';
    const reg = await import(/* @vite-ignore */ registryPath);
    const { KBaseDB, DEFAULT_SETTINGS } = await import(/* @vite-ignore */ dbPath);
    const now = Date.now();
    const iri = (value: string) => ({ kind: 'iri', value });
    const lit = (value: string) => ({ kind: 'literal', value });
    const stmt = (id: string, s: string, p: string, o: { kind: string; value: string }) => ({
      id, s: iri(s), p: iri(p), o, g: iri('urn:kbase:source/e2e'), sourceId: 'e2e', confidence: 1, status: 'confirmed', createdAt: now,
    });
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#label';
    async function write(id: string, stableId: string, statements: unknown[]) {
      const db = new KBaseDB(id);
      await db.settings.put({ ...DEFAULT_SETTINGS, kbStableId: stableId });
      await db.statements.bulkPut(statements);
      db.close();
    }
    const a = reg.createKb(garden);
    const b = reg.createKb(seeds);
    reg.updateKbEntry(a.id, { stableId: gardenId });
    reg.updateKbEntry(b.id, { stableId: seedsId });
    await write(a.id, gardenId, [
      stmt('g1', 'urn:kbase:concept/tomato', RDFS, lit('Tomato')),
      stmt('g2', 'urn:kbase:concept/full-sun', RDFS, lit('Full sun')),
      stmt('g3', 'urn:kbase:concept/tomato', 'urn:kbase:predicate/needs', iri('urn:kbase:concept/full-sun')),
      stmt('g4', 'urn:kbase:concept/tomato', 'urn:reckons:leap', lit(seedsId)),
      stmt('g5', 'urn:kbase:concept/tomato', 'urn:reckons:leap/label', lit(seeds)),
    ]);
    await write(b.id, seedsId, [
      stmt('s1', 'urn:kbase:concept/tomato-seed', RDFS, lit('Tomato seed')),
      stmt('s2', 'urn:kbase:concept/year-2026', RDFS, lit('2026')),
      stmt('s3', 'urn:kbase:concept/tomato-seed', 'urn:kbase:predicate/saved-in', iri('urn:kbase:concept/year-2026')),
    ]);
    reg.switchToKb(a.id);
  }, { garden: GARDEN, seeds: SEEDS, seedsId: SEEDS_STABLE_ID, gardenId: GARDEN_STABLE_ID });
  await reloaded;
}

const current = (page: Page) => page.locator('.kb-entry.current').first();
const entry = (page: Page, name: string) => page.locator('.kb-entry', { hasText: name }).first();
const mapGroup = (page: Page) => page.getByRole('group', { name: 'Map of your spaces and the leaps between them' });

const impls: Record<string, StepImpl> = {
  'two-spaces': async (page, snap) => {
    await page.goto('/kb');
    await expect(current(page)).toContainText(GARDEN, { timeout: 15_000 });
    await expect(entry(page, SEEDS)).toBeVisible();
    await snap(page.locator('.kb-entry').first());
  },
  'spaces-map': async (page, snap) => {
    await expect(mapGroup(page)).toBeVisible();
    await expect(mapGroup(page).getByRole('button', { name: new RegExp(`^${GARDEN}:`) }))
      .toHaveAccessibleName(/1 connected space/, { timeout: 20_000 });
    await expect(page.locator('.spaces-map line.edge')).toHaveCount(1);
    await snap(page.locator('.spaces-map').first());
  },
  'find-jump': async (page, snap) => {
    await page.goto('/');
    await page.getByPlaceholder('search nodes or facts…').fill('tomato');
    await page.locator('.sb-node-row').filter({ has: page.locator('.sb-node-iri') }).filter({ hasText: 'tomato' }).first().click();
    const leap = page.locator('.np-leap');
    await expect(leap).toBeVisible({ timeout: 15_000 });
    await expect(leap.locator('.leap-id')).toHaveText(SEEDS);
    await snap(leap);
  },
  'take-jump': async (page, snap) => {
    // Following a jump reloads the app into the other space.
    await Promise.all([page.waitForEvent('load'), page.locator('.np-leap .leap-id').click()]);
    await page.goto('/kb');
    await expect(current(page)).toContainText(SEEDS, { timeout: 15_000 });
    await snap(current(page));
  },
  'switch-back': async (page, snap) => {
    await Promise.all([page.waitForEvent('load'), entry(page, GARDEN).getByRole('button', { name: /^switch$/i }).click()]);
    await expect(current(page)).toContainText(GARDEN, { timeout: 15_000 });
    await snap(current(page));
  },
};

test.beforeEach(async ({ page }) => {
  if (!isDemoRender()) await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await seedSpaces(page);
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
