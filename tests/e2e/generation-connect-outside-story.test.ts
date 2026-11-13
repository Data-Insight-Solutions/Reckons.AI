import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/** F166.1.2: connecting local generation from free conversation in an ordinary (non-story) space. */
async function fixtureWorkspace(page: Page, unavailable: string[] = []) {
  await page.evaluate(async (unavailable) => {
    const root = await navigator.storage.getDirectory();
    const generation = await root.getDirectoryHandle('.reckons-generation', { create: true });
    await generation.getDirectoryHandle('jobs', { create: true });
    const writeCaps = async () => {
      const writable = await (await generation.getFileHandle('capabilities.json', { create: true })).createWritable();
      await writable.write(JSON.stringify({
        version: 1, workspaceId: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', heartbeat: Date.now(),
        stages: ['image', 'video', 'splat'].map(stage => ({
          stage, available: !unavailable.includes(stage),
          ...unavailable.includes(stage) ? { reason: `${stage}: synthetic missing model` } : {},
        })),
      }));
      await writable.close();
    };
    await writeCaps();
    setInterval(() => void writeCaps(), 5000);
    const path = '/src/lib/stores/workspace.svelte.ts';
    const module = await import(/* @vite-ignore */ path);
    module.__linkHandleForTest(root);
  }, unavailable);
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('outside the story, asking Shelly for a picture with no runner shows the connect control (F166.1.2)', async ({ page }) => {
  test.setTimeout(90_000);
  // Deliberately NO fixtureWorkspace: nothing is connected. Mock provider, so the reply is scripted;
  // the unit tests cover the real prompt, and an earlier proof used a real local model.
  await page.evaluate(async () => {
    const reply = 'Generation runs on your own computer, so start the local runner and connect its folder first.\n<kb-actions>\n'
      + JSON.stringify([{ type: 'queue_jobs', label: '1 image', jobs: [{ stage: 'image', prompt: 'A synthetic paper crane on a desk' }] }])
      + '\n</kb-actions>';
    (globalThis as { __RECKONS_MOCK_REPLY__?: string }).__RECKONS_MOCK_REPLY__ = reply;
    const bridgePath = '/src/lib/stores/shelly-bridge.svelte.ts';
    const bridge = await import(/* @vite-ignore */ bridgePath);
    bridge.requestShellyChat('Can you make me a picture of a paper crane?');
  });
  const state = page.locator('.runner-connect');
  await expect(state.first()).toBeVisible({ timeout: 40_000 });
  await expect(state.first()).toContainText('not connected');
  await expect(page.getByText('Start the runner on your generation machine')).toBeVisible();
  // One in the panel strip, one under her queue_jobs card.
  expect(await state.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('button', { name: 'Connect workspace folder' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'queue 1', exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('connect-control-outside-story.png') });
  // The folder picker cannot be driven headless. Link the fixture folder as the picker would, and the
  // same card becomes approvable and the control reads connected.
  await fixtureWorkspace(page);
  await page.evaluate(async () => {
    const workspacePath = '/src/lib/stores/workspace.svelte.ts';
    const workspace = await import(/* @vite-ignore */ workspacePath);
    workspace.__linkHandleForTest(await navigator.storage.getDirectory());
  });
  await expect(page.getByRole('button', { name: 'queue 1', exact: true })).toBeEnabled({ timeout: 20_000 });
  await expect(state.first()).toContainText('connected');
});
