import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const budgetMs = Number(process.env.VISUAL_SMOKE_BUDGET_MS ?? 240_000);
if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
  throw new Error('VISUAL_SMOKE_BUDGET_MS must be a positive number');
}

const startedAt = new Date();
const started = performance.now();
const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test', '--config=playwright.smoke.config.ts'],
  { stdio: 'inherit' },
);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
}, budgetMs);

const exitCode = await new Promise<number>((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code ?? 1));
});
clearTimeout(timer);

const durationMs = Math.round(performance.now() - started);
const result = {
  schemaVersion: 1,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs,
  budgetMs,
  timedOut,
  exitCode,
};
const outputDirectory = resolve('test-results', 'visual-smoke');
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, 'timing.json'), `${JSON.stringify(result, null, 2)}\n`);

if (timedOut) {
  console.error(`Visual smoke gate exceeded its ${budgetMs} ms browser-time budget.`);
  process.exit(1);
}
if (exitCode !== 0) process.exit(exitCode);

console.log(`Visual smoke gate passed in ${durationMs} ms (budget: ${budgetMs} ms).`);
