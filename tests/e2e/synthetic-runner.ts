import type { Page } from '@playwright/test';

/**
 * A SYNTHETIC FILE-QUEUE RUNNER for e2e (F74.14 job channel). The real runner needs a GPU and the models, so
 * these helpers stand in for it in the browser's own file system (OPFS): they advertise the stages as
 * available, and complete a request the app wrote by copying the committed, checked carved-turtle asset in
 * with a receipt. No job ever runs and no model loads. Shared by the generation specs and the story runner's
 * `run-job` operation (tests/e2e/story-runner.ts), so a story that starts a job exercises the same channel.
 */

export interface QueuedRequest { id: string; stage: string; parentId?: string; spaceId: string; prompt: string }

/** Advertise the stages and keep the heartbeat fresh. `unavailable` names stages the runner reports as missing. */
export async function advertiseRunner(page: Page, unavailable: string[] = []) {
  await page.evaluate(async (unavailable) => {
    const root = await navigator.storage.getDirectory();
    const generation = await root.getDirectoryHandle('.reckons-generation', { create: true });
    await generation.getDirectoryHandle('jobs', { create: true });
    const writeCaps = async () => {
      const writable = await (await generation.getFileHandle('capabilities.json', { create: true })).createWritable();
      await writable.write(JSON.stringify({
        version: 1, workspaceId: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', heartbeat: Date.now(),
        stages: ['image', 'video', 'splat'].map((stage) => ({
          stage, available: !unavailable.includes(stage),
          ...(unavailable.includes(stage) ? { reason: `${stage}: synthetic missing model` } : {}),
        })),
      }));
      await writable.close();
    };
    await writeCaps();
    setInterval(() => void writeCaps(), 5000);
  }, unavailable);
}

/** Point the app's workspace at the browser's file system, where the synthetic runner's queue lives. */
export async function linkRunner(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/lib/stores/workspace.svelte.ts';
    const module = await import(/* @vite-ignore */ path);
    module.__linkHandleForTest(await navigator.storage.getDirectory());
  });
}

export async function jobRequests(page: Page): Promise<QueuedRequest[]> {
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
    return results as QueuedRequest[];
  });
}

export async function finishJob(page: Page, id: string, state: 'completed' | 'failed' = 'completed', corrupt = false) {
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
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    receipt.settings.seed = request.seed;
    if (request.stage !== 'splat') receipt.input.prompt = request.prompt;
    receipt.output = { file: filename, bytes: bytes.byteLength, sha256: corrupt ? '0'.repeat(64) : hash };
    await write(filename, bytes);
    await write('status.json', JSON.stringify({ request, state, receipt }));
  }, { id, state, corrupt });
}
