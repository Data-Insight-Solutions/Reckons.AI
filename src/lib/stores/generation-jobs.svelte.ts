/**
 * Local generation jobs for the open knowledge base (F166.1.2), shared by the Generated assets story and
 * Shelly's free-form chat. Moved out of GenerationStory.svelte so a job outlives the panel that
 * queued it: polling continues while any job is unfinished, and stops once nothing is.
 *
 * The browser only ever writes typed requests into the connected workspace folder; the host bridge
 * (scripts/content/generation-runner.ts) turns them into jobs in the shared local-job queue. Every
 * request is mirrored as a Job entity in the knowledge base it came from (the Job entity module in src/lib/generation),
 * and its checked output is attached there. Results never attach to a different knowledge base: a
 * request is only polled while its own knowledge base is open, and attach.ts asserts that again.
 */
import { getCurrentKbId } from '$lib/storage/kb-registry';
import { db } from '$lib/storage/db';
import { workspaceHandle, workspaceState, pickWorkspace, reconnectWorkspace } from '$lib/stores/workspace.svelte';
import { applyShellyViewAdjust } from '$lib/stores/shelly-bridge.svelte';
import { officialKbActive } from '$lib/stores/official-kb.svelte';
import { persistSourceBatch, prepareStatementsForWrite, statements, updateStatement } from '$lib/stores/kb.svelte';
import { attachGeneration } from '$lib/generation/attach';
import { WorkspaceGenerationClient } from '$lib/generation/workspace-client';
import { jobSource, jobSourceId, jobStatements, jobStateRowId, producedStatement, type JobOrigin } from '$lib/generation/job-node';
import type { JobPlanItem } from '$lib/generation/job-plan';
import {
  parseRequest, type GenerationCapabilities, type GenerationJob, type GenerationRequest, type GenerationStage,
} from '$lib/generation/protocol';

type Saved = { requests: GenerationRequest[]; origins: Record<string, JobOrigin>; queuedAt: Record<string, number>; generationWorkspaceId: string | null };
const storageKey = (knowledgeBaseId: string) => `reckons:generation-jobs:${knowledgeBaseId}`;
/** Before F166.1.2 the story kept its requests under its own key. Read once, so a reload keeps them. */
const legacyKey = (knowledgeBaseId: string) => `reckons:generation-story:${knowledgeBaseId}`;

let spaceId = '';
let requests = $state<GenerationRequest[]>([]);
let jobs = $state<GenerationJob[]>([]);
let attached = $state<string[]>([]);
let previews = $state<Record<string, string>>({});
let capabilities = $state<GenerationCapabilities | null>(null);
let connectionError = $state('');
let error = $state('');
let busy = $state(false);
let connecting = $state(false);
let origins: Record<string, JobOrigin> = {};
let queuedAt: Record<string, number> = {};
let recorded: Record<string, string> = {};
let client: WorkspaceGenerationClient | null = null;
let folder: FileSystemDirectoryHandle | null = null;
let generationWorkspaceId: string | null = null;
let polling = false;
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const cancelling = new Set<string>();

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const finished = (id: string) => attached.includes(id)
  || jobs.some(j => j.request.id === id && (j.state === 'failed' || j.state === 'cancelled'));

function save() {
  // Save the IDs before dispatch. A reload or uncertain write retries the same job.
  const saved: Saved = { requests, origins, queuedAt, generationWorkspaceId };
  try { localStorage.setItem(storageKey(spaceId), JSON.stringify(saved)); } catch { /* storage full or blocked: jobs still run */ }
}

function load(knowledgeBaseId: string) {
  Object.values(previews).forEach(url => URL.revokeObjectURL(url));
  spaceId = knowledgeBaseId;
  requests = []; jobs = []; attached = []; previews = {}; origins = {}; queuedAt = {}; recorded = {};
  capabilities = null; client = null; generationWorkspaceId = null; error = '';
  try {
    const raw = localStorage.getItem(storageKey(knowledgeBaseId));
    const legacy = raw ? null : localStorage.getItem(legacyKey(knowledgeBaseId));
    const saved = JSON.parse(raw ?? legacy ?? 'null') as Partial<Saved> | null;
    if (!saved) return;
    requests = (saved.requests ?? []).map(parseRequest).filter(r => r.spaceId === knowledgeBaseId);
    origins = Object.fromEntries(requests.map(r => [r.id, saved.origins?.[r.id] === 'shelly' ? 'shelly' : 'story']));
    queuedAt = Object.fromEntries(requests.map(r => [r.id, Number(saved.queuedAt?.[r.id]) || Date.now()]));
    generationWorkspaceId = typeof saved.generationWorkspaceId === 'string' ? saved.generationWorkspaceId : null;
  } catch { error = 'Saved generation jobs could not be restored. You can queue new ones.'; }
}

/** Follow the open knowledge base. Switching away leaves the old one's jobs running on the host. */
function followSpace(): boolean {
  const current = getCurrentKbId();
  if (current === spaceId) return false;
  const leftBehind = !!spaceId && requests.some(r => !finished(r.id));
  load(current);
  if (leftBehind) error = 'The knowledge base or workspace changed. Return to the original knowledge base to receive its results; its jobs keep running on your computer.';
  return true;
}

function inOwnSpace(request: GenerationRequest) {
  return getCurrentKbId() === request.spaceId && db.name === request.spaceId;
}

/** Write or advance the Job entity. Stable row ids make every call safe to repeat. */
async function record(request: GenerationRequest, job?: GenerationJob) {
  const state = job?.state ?? 'queued';
  if (recorded[request.id] === state || officialKbActive() || !inOwnSpace(request)) return;
  const at = queuedAt[request.id] ?? Date.now();
  const rows = jobStatements(request, origins[request.id] ?? 'story', at, job);
  const plan = await prepareStatementsForWrite(rows, jobSourceId(request.id), { origin: 'manual' });
  if (!inOwnSpace(request)) return;
  await persistSourceBatch(jobSource(request, at), plan);
  const row = statements().find(s => s.id === jobStateRowId(request.id));
  if (row && row.o.value !== state) await updateStatement(row.id, { o: { kind: 'literal', value: state } });
  recorded[request.id] = state;
}

export async function connectJobs(choose = false) {
  if (connecting) return;
  followSpace();
  connecting = true;
  connectionError = '';
  try {
    if (choose) {
      const connected = workspaceState() === 'disconnected' ? await reconnectWorkspace() : await pickWorkspace();
      if (!connected) return;
    }
    folder = workspaceHandle();
    if (!folder || workspaceState() !== 'connected') throw new Error('Connect your workspace folder to run generation locally.');
    client = new WorkspaceGenerationClient(folder);
    const caps = await client.capabilities();
    if (generationWorkspaceId && caps.workspaceId !== generationWorkspaceId && requests.length > 0) {
      client = null;
      throw new Error('Connect the original generation workspace to resume these jobs.');
    }
    generationWorkspaceId = caps.workspaceId;
    capabilities = caps;
    save();
    await pollJobs();
  } catch (e) { capabilities = null; connectionError = message(e); }
  finally { connecting = false; }
}

export async function pollJobs() {
  if (followSpace()) { void connectJobs(); return; }
  // Shelly's chat has no reconnect button: pick the runner up as soon as the folder is connected.
  if (!client && !connecting && workspaceState() === 'connected') { void connectJobs(); return; }
  if (polling || busy || !client) return;
  polling = true;
  try {
    const currentFolder = workspaceHandle();
    if (!currentFolder || !folder || !(await folder.isSameEntry(currentFolder))) {
      throw new Error('The workspace folder changed. Reconnect the original one to continue these jobs.');
    }
    // Results remain readable after the bridge stops. A stale heartbeat disables new submissions.
    let caps: GenerationCapabilities | null = null;
    try { caps = await client.capabilities(); capabilities = caps; connectionError = ''; }
    catch (e) { capabilities = null; connectionError = message(e); }
    if (caps && caps.workspaceId !== generationWorkspaceId) {
      capabilities = null;
      throw new Error('The generation workspace identity changed. Reconnect the original workspace.');
    }
    for (const request of requests) {
      if (finished(request.id)) continue;
      let job: GenerationJob;
      try { job = await client.status(request); }
      catch (e) {
        if (!(e instanceof DOMException) || e.name !== 'NotFoundError') throw e;
        // A saved request whose submit was interrupted can be resumed with the same ID.
        await client.submit(request);
        job = { request, state: 'queued' };
      }
      if (getCurrentKbId() !== spaceId) return;
      jobs = [...jobs.filter(j => j.request.id !== request.id), job];
      if (job.state !== 'completed') { await record(request, job); continue; }
      const file = await client.result(job);
      // Cancellation can race reading a large output. Check again before attaching.
      if ((await client.status(request)).state !== 'completed' || cancelling.has(request.id)) continue;
      busy = true;
      try {
        const entity = await attachGeneration(job, file);
        await record(request, job);
        if (inOwnSpace(request)) await persistSourceBatch(jobSource(request, queuedAt[request.id] ?? Date.now()),
          await prepareStatementsForWrite([producedStatement(request, Date.now())], jobSourceId(request.id), { origin: 'manual' }));
        attached = [...attached, request.id];
        if (request.stage !== 'splat') previews = { ...previews, [request.id]: URL.createObjectURL(file) };
        // Selecting automatically opens a competing details sheet on phones. Highlight the
        // result while keeping the conversation reachable; the Show button selects it.
        applyShellyViewAdjust({ spotlight: [entity] });
      } finally { busy = false; }
    }
  } catch (e) { error = message(e); }
  finally { polling = false; stopWhenIdle(); }
}

function stopWhenIdle() {
  if (timer && users === 0 && requests.every(r => finished(r.id))) { clearInterval(timer); timer = null; }
}

/** Keep jobs polling while a view shows them. Returns the release function for onMount. */
export function useGenerationJobs(): () => void {
  users++;
  if (followSpace() || !client) void connectJobs();
  timer ??= setInterval(() => void pollJobs(), 2000);
  return () => { users--; stopWhenIdle(); };
}

/**
 * Queue a plan of jobs. Derivations name an earlier item in the same plan (`parent`), or an
 * existing request ID (`parentId`). The whole plan is checked before any job is written.
 */
export async function submitJobs(items: (JobPlanItem & { parentId?: string; seed?: number })[], origin: JobOrigin): Promise<GenerationRequest[]> {
  if (busy) throw new Error('Another job is being added. Try again in a moment.');
  followSpace();
  if (!client || !capabilities) throw new Error('No local generation runner is connected.');
  if (officialKbActive()) throw new Error('Open an editable copy of this knowledge base before generating assets.');
  const currentFolder = workspaceHandle();
  if (getCurrentKbId() !== spaceId || !folder || !currentFolder || !(await folder.isSameEntry(currentFolder))) {
    throw new Error('Return to the originating knowledge base and workspace before submitting.');
  }
  busy = true;
  error = '';
  try {
    const created: GenerationRequest[] = [];
    for (const item of items) {
      const parentId = item.parent !== undefined ? created[item.parent]?.id : item.parentId;
      created.push(parseRequest({
        version: 1, id: crypto.randomUUID(), spaceId, stage: item.stage, prompt: item.prompt,
        seed: item.seed ?? Math.floor(Math.random() * 2147483648),
        ...(item.stage !== 'image' ? { parentId } : {}),
      }));
    }
    const now = Date.now();
    for (const request of created) { origins[request.id] = origin; queuedAt[request.id] = now; }
    requests = [...requests, ...created];
    save();
    for (const request of created) {
      await client.submit(request);
      jobs = [...jobs, { request, state: 'queued' }];
      await record(request);
    }
    timer ??= setInterval(() => void pollJobs(), 2000);
    return created;
  } catch (e) { error = message(e); throw e; }
  finally { busy = false; }
}

export async function retryJob(request: GenerationRequest, origin: JobOrigin) {
  return submitJobs([{ stage: request.stage, prompt: request.prompt, seed: request.seed, parentId: request.parentId }], origin);
}

export async function cancelJob(request: GenerationRequest) {
  if (!client || busy) return;
  busy = true;
  cancelling.add(request.id);
  try {
    await client.cancel(request);
    const job: GenerationJob = { request, state: 'cancelled' };
    jobs = [...jobs.filter(j => j.request.id !== request.id), job];
    await record(request, job);
    error = '';
  } catch (e) { error = message(e); }
  finally { busy = false; cancelling.delete(request.id); }
}

export function clearJobsError() { error = ''; void pollJobs(); }

/** Read-only view for components. Getters keep each read reactive. */
export const generationJobs = {
  get requests() { return requests; },
  get jobs() { return jobs; },
  get attached() { return attached; },
  get previews() { return previews; },
  get capabilities() { return capabilities; },
  get connectionError() { return connectionError; },
  get error() { return error; },
  get busy() { return busy; },
  get connecting() { return connecting; },
  originOf: (id: string): JobOrigin => origins[id] ?? 'story',
  jobOf: (id: string) => jobs.find(j => j.request.id === id),
  isFinished: finished,
  available: (stage: GenerationStage) => !!capabilities?.stages.find(c => c.stage === stage)?.available,
  reason: (stage: GenerationStage) => capabilities?.stages.find(c => c.stage === stage)?.reason ?? 'Connect the local runner first.',
};
