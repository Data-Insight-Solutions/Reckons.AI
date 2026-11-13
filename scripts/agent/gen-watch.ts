/** Real wiring for scripts/agent/gen-watch-core.ts: the folders agent:watch serves for local generation (F166.1.3). */
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GENERATION_DIR, parseRequest, validJobId } from '../../src/lib/generation/protocol.js';
import { generationAvailability } from '../content/gen-assets.js';
import { GenerationRunner, workspaceIdentity } from '../content/generation-runner.js';
import { GenWatch, watchedFolders, type Deps, type PendingRequest } from './gen-watch-core.js';

const configPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'reckons/generation-folders.json');
const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; } };
const writeAtomic = (p: string, v: unknown) => { const t = `${p}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); renameSync(t, p); };

function pending(folder: string): PendingRequest[] {
  const jobs = join(folder, GENERATION_DIR, 'jobs');
  if (!existsSync(jobs)) return [];
  const out: PendingRequest[] = [];
  for (const id of readdirSync(jobs)) {
    if (!validJobId(id)) continue;
    const dir = join(jobs, id);
    try {
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'cancel.json'))) continue;
      const state = (readJson(join(dir, 'status.json')) as { state?: string } | undefined)?.state;
      if (state === 'completed' || state === 'failed' || state === 'cancelled') continue;
      const request = parseRequest(readJson(join(dir, 'request.json')));
      if (request.id === id) out.push({ id, stage: request.stage as PendingRequest['stage'] });
    } catch { /* the browser may still be writing it */ }
  }
  return out;
}

const deps: Deps = {
  now: () => Date.now(),
  availability: (stage) => generationAvailability(stage),
  makeRunner: (folder) => new GenerationRunner(folder),
  pending,
  fail: (folder, id, message) => {
    const dir = join(folder, GENERATION_DIR, 'jobs', id);
    const request = parseRequest(readJson(join(dir, 'request.json')));
    writeAtomic(join(dir, 'status.json'), { request, state: 'failed', error: message });
  },
  workspaceId: (folder) => workspaceIdentity(folder),
  write: (folder, value) => { const root = join(folder, GENERATION_DIR); mkdirSync(root, { recursive: true, mode: 0o700 }); writeAtomic(join(root, 'watcher.json'), value); },
};

/** Serve every watched folder on demand until the process exits. */
export function startGenerationWatch(): () => void {
  const { folders, idleSeconds } = watchedFolders({ home: homedir(), env: process.env, config: readJson(configPath()), exists: existsSync });
  const watches = folders.map(f => { try { return new GenWatch(f, deps, idleSeconds * 1000); } catch { return undefined; } }).filter((w): w is GenWatch => !!w);
  const timer = setInterval(() => { for (const w of watches) { try { w.tick(); } catch (e) { console.error(`gen-watch: ${w.folder}: ${String(e)}`); } } }, 2000);
  const stop = () => { clearInterval(timer); watches.forEach(w => w.close()); };
  process.on('exit', stop);
  return stop;
}
