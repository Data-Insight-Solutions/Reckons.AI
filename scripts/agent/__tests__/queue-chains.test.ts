/**
 * Integration test for job chains (Matt, 2026-11-03: "craft local job chains").
 *
 * Runs the real worker (queue-worker.ts) and queue CLI (queue.ts) as child processes against a
 * throwaway XDG_STATE_HOME, a stub Ollama (its /api/chat 404s so job-watch falls back to its
 * script-only verdict and the exit code stays the source of truth), and a fresh git repo for the
 * deputy no-commit gate. It never touches the live queue under ~/.local/state/reckons/jobs.
 *
 * The three behaviours required:
 *   1. an --after job waits until its predecessor PASSES, and runs only after it (order checked);
 *   2. an --after job is recorded 'blocked' (not run) when its predecessor failed;
 *   3. a deputy-shaped job (argv ends local-claude.sh) that exits clean but commits nothing is
 *      recorded 'no-commit', and one that commits is 'passed'.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const QUEUE = path.join(REPO, 'scripts', 'agent', 'queue.ts');
const WORKER = path.join(REPO, 'scripts', 'agent', 'queue-worker.ts');

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `queue-chains-${label}-`));
  dirs.push(dir);
  return dir;
}

/**
 * A stand-in Ollama: /api/version answers so the worker believes it is up; /api/chat 404s with a
 * body that does not read like a missing-model error, so job-watch's askModel throws a non-transient
 * OllamaHttpError and it reports the run on script facts alone (exit code decides the outcome).
 */
async function stubOllama(): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"stub"}'); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"stub: no local model for this test"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('stubOllama: could not bind a port');
  servers.push(server);
  return `http://127.0.0.1:${addr.port}`;
}

function envFor(state: string, ollama: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_STATE_HOME: state,
    // Point every on-disk source at paths that do not exist in the throwaway state dir, so no live
    // circuit history, no real device overrides, and no recurring schedules leak into the run.
    JOB_RUNS_TTL: path.join(state, 'job-runs-none.ttl'),
    RECKONS_DEVICE_TTL: path.join(state, 'device-none.ttl'),
    OLLAMA_BASE_URL: ollama,
  };
}

/** A just-written heartbeat reads as a fresh session, so the worker is allowed to start jobs. */
function touchHeartbeat(state: string): void {
  const p = path.join(state, 'reckons', 'session-heartbeat');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `heartbeat ${new Date().toISOString()}\n`);
}

function addJob(state: string, ollama: string, name: string, cwd: string, argv: string[], after: string[] = []): void {
  const r = spawnSync(
    process.execPath,
    [TSX, QUEUE, 'add', `--name=${name}`, `--cwd=${cwd}`, ...after.map((a) => `--after=${a}`), '--cpu', '--', ...argv],
    { env: envFor(state, ollama), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (r.status !== 0) throw new Error(`queue add "${name}" exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
}

function startWorker(workerCwd: string, state: string, ollama: string) {
  let output = '';
  const child = spawn(process.execPath, [TSX, WORKER, '--poll-seconds=1'], { cwd: workerCwd, env: envFor(state, ollama), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c: Buffer) => { output += c; });
  child.stderr.on('data', (c: Buffer) => { output += c; });
  const done = new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('close', (code) => resolve(code ?? 1)); });
  return { child, done, output: () => output };
}

type DoneEntry = { name: string; outcome: string; reason?: string; headBefore?: string; headAfter?: string; finishedAt: string };
function doneEntries(state: string): DoneEntry[] {
  const p = path.join(state, 'reckons', 'jobs', 'queue.done.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as DoneEntry);
}
const entry = (state: string, name: string): DoneEntry => {
  const hit = doneEntries(state).find((e) => e.name === name);
  if (!hit) throw new Error(`no done entry for "${name}"; got: ${JSON.stringify(doneEntries(state).map((e) => e.name))}`);
  return hit;
};

function initRepo(): string {
  const dir = tempDir('repo');
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, stdio: 'ignore' }).status ?? 1;
    if (result !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'chains@test.invalid']);
  run(['config', 'user.name', 'Chain Test']);
  writeFileSync(path.join(dir, 'README'), 'fixture\n');
  run(['add', 'README']);
  run(['commit', '-qm', 'initial']);
  return dir;
}

describe('job chains (--after), end to end', () => {
  it('an --after job waits until its predecessor passes, and runs only after it', async () => {
    const state = tempDir('state');
    const ollama = await stubOllama();
    touchHeartbeat(state);
    const work = tempDir('work');
    // Add the dependent FIRST so that, if the chain were ignored, it would be picked before prep.
    addJob(state, ollama, 'needs', work, ['/bin/sh', '-c', 'echo needs ran'], ['prep']);
    addJob(state, ollama, 'prep', work, ['/bin/sh', '-c', 'echo prep ran']);

    const w = startWorker(tempDir('worker'), state, ollama);
    const code = await w.done;
    expect(code).toBe(0);

    expect(entry(state, 'prep').outcome).toBe('passed');
    expect(entry(state, 'needs').outcome).toBe('passed');
    // needs could only have started after prep passed, so it finished later.
    expect(Date.parse(entry(state, 'needs').finishedAt)).toBeGreaterThan(Date.parse(entry(state, 'prep').finishedAt));
    expect(doneEntries(state).filter((e) => e.name.startsWith('sched:'))).toEqual([]);
  }, 30_000);

  it('records an --after job as blocked (never run) when its predecessor failed', async () => {
    const state = tempDir('state');
    const ollama = await stubOllama();
    touchHeartbeat(state);
    const work = tempDir('work');
    addJob(state, ollama, 'needs', work, ['/bin/sh', '-c', 'echo needs ran'], ['prep']);
    addJob(state, ollama, 'prep', work, ['/bin/sh', '-c', 'exit 1']);

    const w = startWorker(tempDir('worker'), state, ollama);
    await w.done;

    expect(entry(state, 'prep').outcome).toBe('failed');
    const needs = entry(state, 'needs');
    expect(needs.outcome).toBe('blocked');
    expect(String(needs.reason)).toMatch(/after "prep" finished "failed"/);
    // The blocked job must never have executed its command.
    expect(w.output()).not.toMatch(/needs ran/);
  }, 30_000);

  it('records a deputy job that exits clean without a new commit as no-commit', async () => {
    const state = tempDir('state');
    const ollama = await stubOllama();
    touchHeartbeat(state);
    const repo = initRepo();
    const script = path.join(tempDir('deputy'), 'local-claude.sh');
    writeFileSync(script, '#!/bin/sh\n# a stalled deputy: does nothing and exits clean\nexit 0\n');
    addJob(state, ollama, 'deputy', repo, ['/bin/sh', script]);

    const w = startWorker(tempDir('worker'), state, ollama);
    const code = await w.done;
    expect(code).toBe(0);

    const d = entry(state, 'deputy');
    expect(d.outcome).toBe('no-commit');
    expect(String(d.reason)).toMatch(/no new commit|unchanged/);
    expect(d.headBefore).toMatch(/^[0-9a-f]{40}$/);
    expect(d.headAfter).toBe(d.headBefore);
  }, 30_000);

  it('records a deputy job that commits its work as passed', async () => {
    const state = tempDir('state');
    const ollama = await stubOllama();
    touchHeartbeat(state);
    const repo = initRepo();
    const script = path.join(tempDir('deputy'), 'local-claude.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "work\\n" > work.txt\ngit add -A\ngit commit -qm "wip"\nexit 0\n');
    addJob(state, ollama, 'deputy', repo, ['/bin/sh', script]);

    const w = startWorker(tempDir('worker'), state, ollama);
    const code = await w.done;
    expect(code).toBe(0);

    const d = entry(state, 'deputy');
    expect(d.outcome).toBe('passed');
    expect(d.headBefore).toMatch(/^[0-9a-f]{40}$/);
    expect(d.headAfter).toMatch(/^[0-9a-f]{40}$/);
    expect(d.headAfter).not.toBe(d.headBefore);
  }, 30_000);
});
