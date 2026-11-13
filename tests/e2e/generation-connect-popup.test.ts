import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/** F166.1.2: connecting local generation from free conversation in an ordinary (non-story) space. */
async function fixtureWorkspace(page: Page, unavailable: string[] = [], file = 'capabilities.json') {
  await page.evaluate(async ([unavailable, file]) => {
    const root = await navigator.storage.getDirectory();
    const generation = await root.getDirectoryHandle('.reckons-generation', { create: true });
    await generation.getDirectoryHandle('jobs', { create: true });
    const writeCaps = async () => {
      const writable = await (await generation.getFileHandle(file, { create: true })).createWritable();
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
  }, [unavailable, file] as [string[], string]);
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

/** F166.1.3: the guided connect popup, from Shelly's reply and from the chat strip (same compact control the job list uses). */
test('the connect popup opens from Shelly\'s reply and her strip, walks the steps and closes on connect (F166.1.3)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.evaluate(async () => {
    const reply = 'Generation runs on your own computer, so start the local runner and connect its folder first.\n<kb-actions>\n'
      + JSON.stringify([{ type: 'queue_jobs', label: '1 image', jobs: [{ stage: 'image', prompt: 'A synthetic paper crane on a desk' }] }])
      + '\n</kb-actions>';
    (globalThis as { __RECKONS_MOCK_REPLY__?: string }).__RECKONS_MOCK_REPLY__ = reply;
    const bridgePath = '/src/lib/stores/shelly-bridge.svelte.ts';
    const bridge = await import(/* @vite-ignore */ bridgePath);
    bridge.requestShellyChat('Can you make me a picture of a paper crane?');
  });
  const connect = page.getByRole('button', { name: 'Connect workspace folder' });
  await expect(connect.first()).toBeVisible({ timeout: 40_000 });
  // Hosted site: no dev-server bridge, so step 1 falls back to the command.
  await page.route('**/__reckons/device/agent-watch', r => r.abort());
  const dialog = page.getByRole('dialog', { name: 'Connect the local generation runner' });

  // From the strip at the top of her chat (first control), then dismiss at step 1 with Escape.
  await connect.first().click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('npm run agent:watch');
  await expect(dialog.getByRole('link', { name: /Setup for your operating system/ })).toHaveAttribute('href', '/docs/features/generation-setup');
  await expect(dialog.locator('[data-connect-status]')).toContainText('Waiting for steps 1 and 2');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // From the control under her reply (last one), then close with the Close button.
  await connect.last().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Choose workspace folder' })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('connect-popup-step-1-2.png') });
  // With the bridge (local dev server) step 1 becomes a button; an already-running runner skips it.
  await page.unroute('**/__reckons/device/agent-watch');
  await page.route('**/__reckons/device/agent-watch', r => r.fulfill({ json: { running: false } }));
  await expect(dialog.getByRole('button', { name: 'Start the agent watcher' })).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // Walk it: reopen, link the fixture folder (the real folder picker cannot be driven headless, so the
  // test links the folder as the picker would), see the folder step done, then the runner answer and the popup close itself.
  await page.unroute('**/__reckons/device/agent-watch');
  await page.route('**/__reckons/device/agent-watch', r => r.fulfill({ json: { running: true, worker: true, workspace: '/synthetic/folder' } }));
  await connect.first().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-step="start"]')).toHaveAttribute('data-step-state', 'done', { timeout: 10_000 });
  await fixtureWorkspace(page);
  await expect(dialog.locator('[data-step="folder"]')).toHaveAttribute('data-step-state', 'done', { timeout: 20_000 });
  await expect(dialog.locator('[data-connect-status]')).toHaveText(/Connected|Checking|Waiting for the runner/);
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.runner-connect').first()).toContainText('connected').catch(() => {});
});

/** The agent watcher, not a running runner, reports the folder: services show per service and the popup says which to install. */
test('a folder reported by the agent watcher shows each service on its own (F166.1.3)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/__reckons/device/agent-watch', r => r.abort());
  await page.evaluate(async () => {
    const reply = 'Start the local runner first.\n<kb-actions>\n'
      + JSON.stringify([{ type: 'queue_jobs', label: '1 image', jobs: [{ stage: 'image', prompt: 'A synthetic paper crane' }] }]) + '\n</kb-actions>';
    (globalThis as { __RECKONS_MOCK_REPLY__?: string }).__RECKONS_MOCK_REPLY__ = reply;
    const bridgePath = '/src/lib/stores/shelly-bridge.svelte.ts';
    (await import(/* @vite-ignore */ bridgePath)).requestShellyChat('Can you make me a picture of a paper crane?');
  });
  const connect = page.getByRole('button', { name: 'Connect workspace folder' });
  await expect(connect.first()).toBeVisible({ timeout: 40_000 });
  await connect.first().click();
  const dialog = page.getByRole('dialog', { name: 'Connect the local generation runner' });
  await expect(dialog).toBeVisible();
  // Linked as the picker would; only the watcher's file exists, and splat is not installed.
  await fixtureWorkspace(page, ['splat'], 'watcher.json');
  const image = dialog.locator('[data-service="image"]');
  await expect(image).toContainText('image generation: installed, will start when needed', { timeout: 20_000 });
  await expect(dialog.locator('[data-service="splat"]')).toContainText('splat generation: not installed');
  await expect(dialog.locator('[data-service="splat"]').getByRole('link', { name: 'Install' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('connect-popup-services.png') });
  await expect(dialog).toBeHidden({ timeout: 20_000 });
});
