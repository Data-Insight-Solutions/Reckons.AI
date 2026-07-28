import { spawn } from 'node:child_process';

if (process.env.VISUAL_BASELINE_REVIEWED !== '1') {
  throw new Error(
    'Baseline update refused. First run npm run visual:review, inspect the Playwright ' +
    'actual/expected/diff artifacts, then rerun with VISUAL_BASELINE_REVIEWED=1.',
  );
}

async function run(command: string, args: string[], env = process.env): Promise<void> {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} exited ${exitCode}`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const updateEnv = { ...process.env, VISUAL_BASELINE_UPDATE: '1' };

await run(npm, ['run', 'build:test'], updateEnv);
await run(
  npx,
  ['playwright', 'test', '--config=playwright.evidence.config.ts', '--update-snapshots'],
  updateEnv,
);
await run(npx, ['tsx', 'scripts/visual-evidence-report.ts'], updateEnv);
