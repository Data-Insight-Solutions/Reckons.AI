import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';
import { playStory } from './story-runner';
import type { UnifiedStory } from '../../src/lib/rdf/story-steps';

/**
 * F300.3 (kb:story-recorder): the data probes (count, standing) and the run-job operation, played by the
 * real runner against the real app. The story is built here in code rather than read from the Testing data
 * because it exists to exercise the runner's page operations, not to document a walk. It starts the
 * synthetic file-queue runner (tests/e2e/synthetic-runner.ts); no model runs.
 */
const story = (expects: UnifiedStory['steps'][number]['expects'], actions: UnifiedStory['steps'][number]['actions'] = []): UnifiedStory => ({
  id: 'probes', label: 'probes', steps: [{
    iri: 'urn:test:s1', id: 's1', order: 1, title: 'probe', shortLabel: 'probe', pageName: 'the graph', content: '', detail: '',
    highlights: [], actions, expects, needs: [], refusals: [],
  }],
} as unknown as UnifiedStory);

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  await page.goto('/about');
  await page.getByTestId('starter-card-generated-assets').click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.locator('main canvas').first()).toBeVisible();
});

test('count and standing read the open space: true ones pass, false ones fail by name', async ({ page }) => {
  const ok = await playStory(page, story([
    { kind: 'count', type: 'Image', n: 3 },
    { kind: 'standing', subject: 'gen-carved-turtle-video', predicate: 'made-from', object: 'gen-carved-turtle-image', status: 'held' },
  ]));
  expect(ok[0].checks.map((c) => c.status)).toEqual(['checked', 'checked']);
});

test('a false count fails the story with the numbers in the message', async ({ page }) => {
  await expect(playStory(page, story([{ kind: 'count', type: 'Image', n: 99 }]))).rejects.toThrow(/expected 99 of Image, found \d+/);
});

test('a standing that does not hold fails, and a pending one is not held', async ({ page }) => {
  await expect(playStory(page, story([{ kind: 'standing', subject: 'gen-carved-turtle-video', predicate: 'made-from', object: 'gen-carved-turtle-image', status: 'pending' }]))).rejects.toThrow(/does not stand as pending/);
});

test('run-job generate-image writes a request, the synthetic runner completes it, and the result is a generated source', async ({ page }) => {
  test.setTimeout(90_000);
  await playStory(page, story([], [{ kind: 'run-job', job: 'generate-image', params: { prompt: 'A watercolor lighthouse on an island' } }]));
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/lib/storage/db.ts';
    const { db } = await import(/* @vite-ignore */ path);
    return db.sources.filter((s: { id: string }) => s.id.startsWith('generation-')).count();
  }), { timeout: 20_000 }).toBe(1);
});

test('run-job refuses an undefined job kind before touching the page', async ({ page }) => {
  await expect(playStory(page, story([], [{ kind: 'run-job', job: 'rm-rf', params: {} }]))).rejects.toThrow(/not a defined job kind/);
});
