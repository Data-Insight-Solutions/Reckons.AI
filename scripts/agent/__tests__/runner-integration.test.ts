import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNNER = path.join(REPO, 'scripts/agent/runner.ts');
const TSX = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-integration-'));
  dirs.push(dir);
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, stdio: 'ignore' }).status ?? 1;
    if (result !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'runner@test.invalid']);
  run(['config', 'user.name', 'Runner Test']);
  writeFileSync(path.join(dir, 'README'), 'fixture\n');
  run(['add', 'README']);
  run(['commit', '-qm', 'fixture']);
  return dir;
}

function taskGraph(command: string, doneWhen: string, effect: string | string[] = 'read-only'): string {
  const literal = (value: string) => JSON.stringify(value);
  const effects = (Array.isArray(effect) ? effect : [effect]).map(literal).join(', ');
  return `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n` +
    `@prefix ktype: <urn:kbase:type/> .\n@prefix kpred: <urn:kbase:predicate/> .\n` +
    `<urn:reckons:task/race> rdf:type ktype:AgentTask ;\n` +
    `  kpred:goal "Exercise the runner contract" ; kpred:tier "script" ;\n` +
    `  kpred:effect ${effects} ; kpred:command ${literal(command)} ;\n` +
    `  kpred:done-when ${literal(doneWhen)} ; kpred:task-state "open" .\n`;
}

function startRunner(
  cwd: string,
  graph: string,
  id: string,
  allowEffects = 'read-only',
  extraEnv: NodeJS.ProcessEnv = {},
) {
  let output = '';
  const child = spawn(
    process.execPath,
    [TSX, RUNNER, '--graph', graph, '--task=race', '--id', id, `--allow-effects=${allowEffects}`],
    { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise<{ code: number; output: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
  const waitForOutput = (pattern: RegExp, timeoutMs = 5_000) => new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (pattern.test(output)) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timed out waiting for ${pattern}: ${output}`));
      setTimeout(check, 10);
    };
    check();
  });
  return { child, done, output: () => output, waitForOutput };
}

function runRunner(cwd: string, graph: string, id: string, allowEffects = 'read-only') {
  return startRunner(cwd, graph, id, allowEffects).done;
}

/** Acquire the exact kernel lock the runner uses and retain it in this parent until close. */
function holdStateLock(stateFile: string): () => void {
  const lock = `${stateFile}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  const fd = openSync(lock, 'a', 0o600);
  const acquired = spawnSync('flock', ['-x', '-w', '2', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
    encoding: 'utf8',
  });
  if (acquired.status !== 0) {
    closeSync(fd);
    throw new Error(`could not hold state lock: ${acquired.stderr}`);
  }
  return () => closeSync(fd);
}

function stateValue(stateFile: string, predicate: string): string | undefined {
  const quads = new Parser().parse(readFileSync(stateFile, 'utf8'));
  return quads.find((quad) => quad.predicate.value === `urn:kbase:predicate/${predicate}`)?.object.value;
}

function journalEntries(dir: string): Record<string, unknown>[] {
  const file = path.join(dir, 'reckons-workspace/runner.log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function stateMutationCommand(dir: string, state: string, predicate: string, value: string): string {
  const script = path.join(dir, `mutate-${predicate}.mjs`);
  writeFileSync(script, `
import { readFileSync, writeFileSync } from 'node:fs';
const [file, predicate, value] = process.argv.slice(2);
const marker = '<urn:kbase:predicate/' + predicate + '> "';
const text = readFileSync(file, 'utf8');
const start = text.indexOf(marker);
if (start < 0) process.exit(3);
const valueStart = start + marker.length;
const valueEnd = text.indexOf('"', valueStart);
if (valueEnd < 0) process.exit(4);
writeFileSync(file, text.slice(0, valueStart) + value + text.slice(valueEnd));
`);
  return [process.execPath, script, state, predicate, value].map((part) => JSON.stringify(part)).join(' ');
}

function waitingFixture(dir: string, blocks: string | string[]) {
  const taskIri = 'urn:reckons:task/race';
  const subject = 'urn:question:threshold';
  const predicate = 'urn:kbase:predicate/confidence-threshold';
  const workspace = path.join(dir, 'reckons-workspace');
  const pending = path.join(workspace, 'knowledge.pending.jsonl');
  const answers = path.join(workspace, 'knowledge.answers.jsonl');
  const sentinel = path.join(dir, 'answered.txt');
  const script = path.join(dir, 'ask-or-run.sh');
  const row = JSON.stringify({
    subject,
    predicate,
    question: 'Choose the threshold',
    blocks,
    type: 'question',
  });
  writeFileSync(script, `#!/usr/bin/env bash
set -e
mkdir -p ${JSON.stringify(workspace)}
if test -f ${JSON.stringify(answers)} && grep -Fq ${JSON.stringify(subject)} ${JSON.stringify(answers)}; then
  printf 'answered\\n' >> ${JSON.stringify(sentinel)}
  exit 0
fi
printf '%s\\n' ${JSON.stringify(row)} >> ${JSON.stringify(pending)}
exit 42
`);
  return {
    script,
    command: `bash ${JSON.stringify(script)}`,
    doneWhen: `test -s ${JSON.stringify(sentinel)}`,
    pending,
    answers,
    sentinel,
    key: `${subject}|${predicate}`,
    answer: JSON.stringify({ subject, predicate, object: '0.9' }) + '\n',
  };
}

describe('runner process contract', () => {
  it('refuses a non-.ttl graph path without overwriting the authored graph', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.graph');
    const authored = taskGraph('true', 'true');
    writeFileSync(graph, authored);

    const result = await runRunner(dir, graph, 'unsafe-state-path');
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/must end in \.ttl|authored graph/i);
    expect(readFileSync(graph, 'utf8')).toBe(authored);
  });

  it('does not execute shell syntax from OLLAMA_BASE_URL during its health check', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const injected = path.join(dir, 'ollama-env-executed');
    writeFileSync(graph, taskGraph('true', 'true'));

    const runner = startRunner(dir, graph, 'safe-ollama-url', 'read-only', {
      OLLAMA_BASE_URL: `http://127.0.0.1:1; touch ${injected}; #`,
    });
    const result = await runner.done;

    expect(result.code).toBe(0);
    expect(existsSync(injected)).toBe(false);
    expect(stateValue(path.join(dir, 'tasks.state.ttl'), 'task-state')).toBe('done');
  }, 20_000);

  it('fails closed when derived state is corrupt', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const state = path.join(dir, 'tasks.state.ttl');
    writeFileSync(graph, taskGraph('true', 'true'));
    writeFileSync(state, '<broken');

    const result = await runRunner(dir, graph, 'corrupt-state');
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/state file is unreadable; refusing to run/i);
    expect(readFileSync(state, 'utf8')).toBe('<broken');
    expect(existsSync(path.join(dir, 'reckons-workspace/runs'))).toBe(false);
  });

  it('cannot turn a non-zero command into success when done-when exits zero', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    writeFileSync(graph, taskGraph("bash -c 'exit 7'", 'true'));

    const result = await runRunner(dir, graph, 'failure-test');
    expect(result.code).toBe(0); // queue failures are recorded facts; the drain itself keeps moving
    expect(stateValue(path.join(dir, 'tasks.state.ttl'), 'task-state')).toBe('failed');
    expect(stateValue(path.join(dir, 'tasks.state.ttl'), 'outcome')).toMatch(/command exited 7/i);
    const receipts = readdirSync(path.join(dir, 'reckons-workspace/runs')).filter((file) => file.endsWith('.json'));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(path.join(dir, 'reckons-workspace/runs', receipts[0]), 'utf8'));
    expect(receipt).toMatchObject({ commandExit: 7, verificationExit: 0 });
    expect(receipts[0]).toContain(receipt.claimToken);
    expect(receipt.claimToken).toMatch(/^[a-f0-9-]{36}$/);
    expect(receipt.git.worktreeStateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts.some((file) => file.endsWith('.tmp'))).toBe(false);
  }, 20_000);

  it('increments from the attempt count re-read under the claim lock', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const state = path.join(dir, 'tasks.state.ttl');
    writeFileSync(graph, taskGraph("bash -c 'exit 7'", 'true'));
    const release = holdStateLock(state);
    const runner = startRunner(dir, graph, 'fresh-attempts');
    await runner.waitForOutput(/▶ race/);
    writeFileSync(
      state,
      `<urn:reckons:task/race> <urn:kbase:predicate/task-state> "open" .\n` +
      `<urn:reckons:task/race> <urn:kbase:predicate/attempts> "2" .\n`,
    );
    release();
    const result = await runner.done;
    expect(result.code).toBe(0);
    expect(stateValue(state, 'attempts')).toBe('3');
  }, 20_000);

  it.each([
    ['a string blocker', 'urn:reckons:task/race'],
    ['an array blocker', ['urn:reckons:task/race', 'urn:reckons:task/other']],
  ])('keeps WAITING durable after pending drain for %s', async (_label, blocks) => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const state = path.join(dir, 'tasks.state.ttl');
    const fixture = waitingFixture(dir, blocks);
    writeFileSync(graph, taskGraph(
      fixture.command,
      fixture.doneWhen,
      ['source-write', 'queue-write'],
    ));

    const first = await runRunner(dir, graph, 'waiting-first', 'source-write,queue-write');
    expect(first.code).toBe(0);
    expect(stateValue(state, 'task-state')).toBe('waiting');
    expect(JSON.parse(stateValue(state, 'waiting-keys') ?? '[]')).toEqual([fixture.key]);
    expect(journalEntries(dir).at(-1)).toMatchObject({ event: 'waiting' });

    // Importing the pending row removes it from this file. That must not make WAITING runnable.
    rmSync(fixture.pending, { force: true });
    const second = await runRunner(dir, graph, 'waiting-after-drain', 'source-write,queue-write');
    expect(second.code).toBe(0);
    expect(second.output).toMatch(/WAITING|Nothing to run/i);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(stateValue(state, 'task-state')).toBe('waiting');

    writeFileSync(fixture.answers, fixture.answer);
    const third = await runRunner(dir, graph, 'waiting-answered', 'source-write,queue-write');
    expect(third.code).toBe(0);
    expect(readFileSync(fixture.sentinel, 'utf8')).toBe('answered\n');
    expect(stateValue(state, 'task-state')).toBe('done');
    expect(stateValue(state, 'waiting-keys')).toBeUndefined();
  }, 20_000);

  it('does not renew an expired lease even when its token still matches', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const state = path.join(dir, 'tasks.state.ttl');
    const expire = stateMutationCommand(dir, state, 'claim-expires', '1');
    writeFileSync(graph, taskGraph(expire, 'true', 'source-write'));

    const result = await runRunner(dir, graph, 'expired-owner', 'source-write');
    expect(result.code).toBe(0);
    expect(stateValue(state, 'task-state')).toBe('claimed');
    expect(stateValue(state, 'claim-expires')).toBe('1');
    expect(journalEntries(dir).at(-1)).toMatchObject({
      event: 'stale-completion-discarded',
      phase: 'before-verification',
    });
  }, 20_000);

  it('discards final completion when the claim token changes during verification', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const state = path.join(dir, 'tasks.state.ttl');
    const steal = stateMutationCommand(dir, state, 'claim-token', 'replacement-token');
    writeFileSync(graph, taskGraph('true', steal, 'source-write'));

    const result = await runRunner(dir, graph, 'stale-final', 'source-write');
    expect(result.code).toBe(0);
    expect(stateValue(state, 'task-state')).toBe('claimed');
    expect(stateValue(state, 'claim-token')).toBe('replacement-token');
    const entries = journalEntries(dir);
    expect(entries.at(-1)).toMatchObject({ event: 'stale-completion-discarded', phase: 'final' });
    expect(entries.some((entry) => entry.event === 'done')).toBe(false);
  }, 20_000);

  it('journals only stale-discard when WAITING loses its claim', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const state = path.join(dir, 'tasks.state.ttl');
    const fixture = waitingFixture(dir, 'urn:reckons:task/race');
    const steal = stateMutationCommand(dir, state, 'claim-token', 'replacement-token');
    writeFileSync(
      fixture.script,
      readFileSync(fixture.script, 'utf8').replace('exit 42', `${steal}\nexit 42`),
    );
    writeFileSync(graph, taskGraph(
      fixture.command,
      fixture.doneWhen,
      ['source-write', 'queue-write'],
    ));

    const result = await runRunner(dir, graph, 'stale-waiting', 'source-write,queue-write');
    expect(result.code).toBe(0);
    expect(stateValue(state, 'task-state')).toBe('claimed');
    expect(stateValue(state, 'claim-token')).toBe('replacement-token');
    const entries = journalEntries(dir);
    expect(entries.at(-1)).toMatchObject({ event: 'stale-completion-discarded', phase: 'waiting' });
    expect(entries.some((entry) => entry.event === 'waiting' || entry.event === 'failed')).toBe(false);
  }, 20_000);

  it('records receipt failure as failure, never as waiting or done', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const workspace = path.join(dir, 'reckons-workspace');
    mkdirSync(workspace, { recursive: true });
    // A file at the runs-directory path forces the atomic receipt write to fail.
    writeFileSync(path.join(workspace, 'runs'), 'not a directory');
    writeFileSync(graph, taskGraph('true', 'true'));

    const result = await runRunner(dir, graph, 'receipt-failure');
    expect(result.code).toBe(0);
    const state = path.join(dir, 'tasks.state.ttl');
    expect(stateValue(state, 'task-state')).toBe('failed');
    expect(stateValue(state, 'outcome')).toMatch(/no durable receipt/i);
    expect(stateValue(state, 'last-receipt')).toBeUndefined();
    const entries = journalEntries(dir);
    expect(entries.at(-1)).toMatchObject({ event: 'failed' });
    expect(entries.some((entry) => entry.event === 'done' || entry.event === 'waiting')).toBe(false);
  }, 20_000);

  it('computes last-run and recurrence from the finished timestamp', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const recurring = taskGraph('sleep 0.1', 'true').replace(
      'kpred:task-state "open"',
      'kpred:every "1h" ; kpred:task-state "open"',
    );
    writeFileSync(graph, recurring);

    const result = await runRunner(dir, graph, 'finished-time');
    expect(result.code).toBe(0);
    const state = path.join(dir, 'tasks.state.ttl');
    const lastRun = Number(stateValue(state, 'last-run'));
    const dueAt = Number(stateValue(state, 'due-at'));
    const receiptFile = readdirSync(path.join(dir, 'reckons-workspace/runs')).find((file) => file.endsWith('.json'))!;
    const receipt = JSON.parse(readFileSync(path.join(dir, 'reckons-workspace/runs', receiptFile), 'utf8'));
    expect(lastRun).toBe(Date.parse(receipt.finishedAt));
    expect(dueAt - lastRun).toBe(3_600_000);
  }, 20_000);

  it('executes a shared task exactly once when two runners race', async () => {
    const dir = initRepo();
    const graph = path.join(dir, 'tasks.ttl');
    const sentinel = path.join(dir, 'sentinel.txt');
    const quoted = JSON.stringify(sentinel);
    writeFileSync(graph, taskGraph(
      `printf 'run\\n' >> ${quoted}; sleep 0.4`,
      `test "$(wc -l < ${quoted})" -eq 1`,
      'source-write',
    ));

    const release = holdStateLock(path.join(dir, 'tasks.state.ttl'));
    const runnerA = startRunner(dir, graph, 'race-a', 'source-write');
    const runnerB = startRunner(dir, graph, 'race-b', 'source-write');
    await Promise.all([runnerA.waitForOutput(/▶ race/), runnerB.waitForOutput(/▶ race/)]);
    release();
    const [a, b] = await Promise.all([runnerA.done, runnerB.done]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(readFileSync(sentinel, 'utf8').trim().split('\n')).toEqual(['run']);
    expect(stateValue(path.join(dir, 'tasks.state.ttl'), 'task-state')).toBe('done');
    const receipts = readdirSync(path.join(dir, 'reckons-workspace/runs')).filter((file) => file.endsWith('.json'));
    expect(receipts).toHaveLength(1);
    expect(`${a.output}\n${b.output}`).toMatch(/lost race|claimed by|Nothing to run/i);
  }, 20_000);
});
