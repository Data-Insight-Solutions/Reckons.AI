import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Browser contract with a synthetic file-queue runner in OPFS. Actual GPU generation is a separate
 * local acceptance run; these tests use committed checked assets and never download models.
 */
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
async function openStory(page: Page) {
  // Exercise real story discovery without depending on ephemeral notification positioning.
  const path = '/src/lib/stores/shelly-bridge.svelte.ts';
  await page.evaluate(async path => {
    const bridge = await import(/* @vite-ignore */ path);
    bridge.startExplore();
  }, path);
  await page.getByRole('button', { name: /Create an asset with Shelly/ }).click();
  await expect(page.getByRole('heading', { name: 'Let’s create something' })).toBeVisible();
  // Layout startup can finish restoring its (empty) workspace after the test's first link.
  // Re-link after the story is mounted; the capability fixture itself remains unchanged.
  await page.evaluate(async () => {
    const path = '/src/lib/stores/workspace.svelte.ts';
    const module = await import(/* @vite-ignore */ path);
    module.__linkHandleForTest(await navigator.storage.getDirectory());
  });
  const reconnect = page.getByRole('button', { name: 'Reconnect runner', exact: true });
  if (await reconnect.isVisible()) await reconnect.click();
}
async function jobRequests(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const jobs = await (await root.getDirectoryHandle('.reckons-generation')).getDirectoryHandle('jobs');
    const results = [];
    const entries = jobs as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
    for await (const handle of entries.values()) {
      if (handle.kind !== 'directory') continue;
      try {
        results.push(JSON.parse(await (await (await (handle as FileSystemDirectoryHandle).getFileHandle('request.json')).getFile()).text()));
      } catch { /* an unsubmitted cancellation marker */ }
    }
    return results as { id: string; stage: string; parentId?: string; spaceId: string; prompt: string }[];
  });
}
async function finishJob(page: Page, id: string, state: 'completed' | 'failed' = 'completed', corrupt = false) {
  await page.evaluate(async ({ id, state, corrupt }) => {
    const jobs = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('.reckons-generation')).getDirectoryHandle('jobs');
    const dir = await jobs.getDirectoryHandle(id);
    const request = JSON.parse(await (await (await dir.getFileHandle('request.json')).getFile()).text());
    const write = async (name: string, bytes: string | ArrayBuffer) => {
      const writer = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writer.write(bytes);
      await writer.close();
    };
    if (state === 'failed') {
      await write('status.json', JSON.stringify({ request, state, error: 'Synthetic generation failure' }));
      return;
    }
    const filename = { image: 'image.webp', video: 'video.webm', splat: 'splat.ply' }[request.stage as 'image' | 'video' | 'splat'];
    const fixture = await (await fetch('/generated/carved-turtle/receipt.json')).json();
    const receipt = fixture.stages[request.stage];
    const bytes = await (await fetch(`/generated/carved-turtle/${filename}`)).arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    receipt.settings.seed = request.seed;
    if (request.stage !== 'splat') receipt.input.prompt = request.prompt;
    receipt.output = { file: filename, bytes: bytes.byteLength, sha256: corrupt ? '0'.repeat(64) : hash };
    await write(filename, bytes);
    await write('status.json', JSON.stringify({ request, state, receipt }));
  }, { id, state, corrupt });
}
async function generatedCount(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/lib/storage/db.ts';
    const { db } = await import(/* @vite-ignore */ path);
    return db.sources.filter((s: { id: string }) => s.id.startsWith('generation-')).count();
  });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  await page.goto('/about');
  await page.locator('.starter-card', { hasText: /generated assets/i }).click();
  await page.waitForURL(url => url.pathname === '/');
  await expect(page.locator('main canvas').first()).toBeVisible();
});

test('Shelly waits for the image, offers derivations, and resumes without duplicating assets', async ({ page }) => {
  test.setTimeout(90_000);
  await fixtureWorkspace(page);
  await openStory(page);
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toHaveCount(0);
  await page.getByLabel('What image would you like?').fill('A watercolor lighthouse on an island');
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(1);
  const image = (await jobRequests(page))[0];
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toHaveCount(0);
  await finishJob(page, image.id);
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.generation-story img.preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toBeInViewport({ ratio: 1 });
  await expect.poll(() => generatedCount(page)).toBe(1);
  if (process.env.STORY_CAPTURE_DIR) {
    await page.screenshot({ path: `${process.env.STORY_CAPTURE_DIR}/${test.info().project.name}-story.png` });
  }
  await page.getByRole('button', { name: 'Make a video', exact: true }).click();
  await page.getByLabel('How should the scene move?').fill('Slow orbit around the lighthouse');
  await page.getByRole('button', { name: 'Generate video', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(2);
  const video = (await jobRequests(page)).find(j => j.stage === 'video')!;
  expect(video.parentId).toBe(image.id);
  await finishJob(page, video.id);
  await expect(page.locator('.generation-story video')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Make a Gaussian splat', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(3);
  const splat = (await jobRequests(page)).find(j => j.stage === 'splat')!;
  expect(splat.parentId).toBe(image.id);
  await finishJob(page, splat.id);
  await expect.poll(() => generatedCount(page), { timeout: 20_000 }).toBe(3);
  await page.getByRole('button', { name: 'Exit story mode', exact: true }).click();
  await page.getByRole('button', { name: /Create an asset with Shelly/ }).click();
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await generatedCount(page)).toBe(3);
  expect((await jobRequests(page)).length).toBe(3);
});

test('failed and cancelled images never unlock derivations; retry is a new job', async ({ page }) => {
  await fixtureWorkspace(page);
  await openStory(page);
  await page.getByLabel('What image would you like?').fill('A synthetic mountain scene');
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(1);
  await finishJob(page, (await jobRequests(page))[0].id, 'failed');
  await expect(page.getByText('Generation failed:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(2);
  await page.getByRole('button', { name: 'Cancel generation', exact: true }).click();
  await expect(page.getByText('Cancelled. No result from this job will be added.')).toBeVisible();
  expect(await generatedCount(page)).toBe(0);
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toHaveCount(0);
});

test('a corrupt output is refused and unavailable derivations stay disabled', async ({ page }) => {
  await fixtureWorkspace(page, ['video']);
  await openStory(page);
  await page.getByLabel('What image would you like?').fill('A synthetic clay turtle');
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(1);
  const image = (await jobRequests(page))[0];
  await finishJob(page, image.id, 'completed', true);
  await expect(page.getByRole('alert')).toContainText('does not match its receipt');
  expect(await generatedCount(page)).toBe(0);
  await finishJob(page, image.id);
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make a video', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Make a Gaussian splat', exact: true })).toBeEnabled();
});

test('reload resumes one job and a changed space cannot receive its result', async ({ page }) => {
  test.setTimeout(60_000);
  await fixtureWorkspace(page);
  await openStory(page);
  await page.getByLabel('What image would you like?').fill('A synthetic paper boat on a pond');
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(1);
  const image = (await jobRequests(page))[0];
  await page.reload();
  await fixtureWorkspace(page);
  await openStory(page);
  await expect(page.getByRole('button', { name: 'Cancel generation', exact: true })).toBeVisible();
  expect((await jobRequests(page)).length).toBe(1);
  await page.evaluate(() => history.replaceState(null, '', '?kb=synthetic-other-space'));
  await finishJob(page, image.id);
  await expect(page.getByRole('alert')).toContainText('space or workspace changed', { timeout: 10_000 });
  expect(await generatedCount(page)).toBe(0);
  await page.evaluate(spaceId => history.replaceState(null, '', `?kb=${encodeURIComponent(spaceId)}`), image.spaceId);
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect.poll(() => generatedCount(page)).toBe(1);
});

test('a reload between creating a job directory and writing its request resumes the same ID', async ({ page }) => {
  await fixtureWorkspace(page); await openStory(page);
  await page.getByLabel('What image would you like?').fill('A synthetic paper sailboat');
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(1);
  const image = (await jobRequests(page))[0];
  // Preserve the saved browser request and directory, but simulate the interrupted atomic write.
  await page.getByRole('button', { name: 'Exit story mode', exact: true }).click();
  await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    const jobs = await (await root.getDirectoryHandle('.reckons-generation')).getDirectoryHandle('jobs');
    await (await jobs.getDirectoryHandle(id)).removeEntry('request.json');
  }, image.id);
  await page.getByRole('button', { name: /Create an asset with Shelly/ }).click();
  await expect.poll(async () => (await jobRequests(page)).map(j => j.id)).toEqual([image.id]);
  await finishJob(page, image.id);
  await expect.poll(() => generatedCount(page)).toBe(1);
});

test('Shelly queues a chain as ONE approval, and every job is a Job entity (F166.1.2)', async ({ page }) => {
  test.setTimeout(60_000);
  await fixtureWorkspace(page);
  await page.evaluate(async () => {
    const reply = 'I can make both on your computer: two different images, then a Gaussian splat from each.\n<kb-actions>\n'
      + JSON.stringify([{ type: 'queue_jobs', label: '2 images, each with a Gaussian splat', jobs: [
        { stage: 'image', prompt: 'A synthetic paper crane on a desk' }, { stage: 'splat', from: 0 },
        { stage: 'image', prompt: 'A synthetic glass marble on sand' }, { stage: 'splat', from: 2 }] }])
      + '\n</kb-actions>';
    (globalThis as { __RECKONS_MOCK_REPLY__?: string }).__RECKONS_MOCK_REPLY__ = reply;
    const bridgePath = '/src/lib/stores/shelly-bridge.svelte.ts';
    const workspacePath = '/src/lib/stores/workspace.svelte.ts';
    const bridge = await import(/* @vite-ignore */ bridgePath);
    bridge.requestShellyChat('Make two different images and a splat for each');
    const workspace = await import(/* @vite-ignore */ workspacePath);
    workspace.__linkHandleForTest(await navigator.storage.getDirectory());
  });
  const queue = page.getByRole('button', { name: 'queue 4', exact: true });
  await expect(queue).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText('2. Gaussian splat from image 1')).toBeVisible();
  await queue.click();
  await expect.poll(async () => (await jobRequests(page)).length).toBe(4);
  const requests = await jobRequests(page);
  const images = requests.filter(r => r.stage === 'image');
  const splats = requests.filter(r => r.stage === 'splat');
  expect(images).toHaveLength(2);
  expect(splats.map(s => s.parentId).sort()).toEqual(images.map(i => i.id).sort());
  const jobNodes = () => page.evaluate(async () => {
    const dbPath = '/src/lib/storage/db.ts';
    const { db } = await import(/* @vite-ignore */ dbPath);
    const rows = await db.statements.toArray() as { s: { value: string }; p: { value: string }; o: { value: string } }[];
    const jobs = rows.filter(r => r.p.value.endsWith('#type') && r.o.value === 'urn:kbase:type/Job').map(r => r.s.value);
    const of = (s: string, p: string) => rows.find(r => r.s.value === s && r.p.value.endsWith(p))?.o.value;
    return jobs.map(s => ({ s, state: of(s, 'job-state'), waitsFor: of(s, 'waits-for'), produced: of(s, 'produced') }));
  });
  await expect.poll(async () => (await jobNodes()).length).toBe(4);
  expect((await jobNodes()).filter(j => j.waitsFor)).toHaveLength(2);
  const first = images.find(i => i.prompt.includes('crane'))!;
  await finishJob(page, first.id);
  await expect.poll(() => generatedCount(page), { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await jobNodes()).find(j => j.s.endsWith(first.id))).toMatchObject({
    state: 'completed', produced: `urn:kbase:concept/generated-${first.id}`,
  });
  await expect(page.getByText('Ready, added to this knowledge base for review')).toBeVisible();
  await expect(page.getByText('Waiting for image 3')).toBeVisible();
});
