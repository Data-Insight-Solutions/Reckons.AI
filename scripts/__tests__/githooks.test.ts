/**
 * F273 PHASE A done-tests: tracked git hooks, exercised in TEMPORARY repositories (git init in a
 * temp dir). Nothing here touches the real repo's history or index. The hooks find the repo's
 * tools through RECKONS_ROOT, so a temp repo can use the real scripts.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

// Each case spawns tsx in a fresh repo; under a parallel full run that exceeds the 5 s default.
vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REAL = resolve(__dirname, '..', '..');
const made: string[] = [];
const AGENT = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>';

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, RECKONS_ROOT: REAL, GIT_TERMINAL_PROMPT: '0', ...env } });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function tempRepo(registry?: object, jobs?: object) {
  const d = mkdtempSync(join(tmpdir(), 'githooks-'));
  made.push(d);
  sh(d, 'git init -q -b dev && git config user.email t@t && git config user.name T && git config commit.gpgsign false');
  cpSync(join(REAL, '.githooks'), join(d, '.githooks'), { recursive: true });
  sh(d, 'git config core.hooksPath .githooks');
  if (registry) writeFileSync(join(d, 'registry.json'), JSON.stringify(registry));
  if (jobs) writeFileSync(join(d, 'jobs.json'), JSON.stringify(jobs));
  return d;
}
const msgFile = (d: string, text: string) => { const f = join(d, '.msg'); writeFileSync(f, text); return f; };
const commit = (d: string, text: string, env: Record<string, string> = {}) => {
  writeFileSync(join(d, 'f.txt'), String(Math.random()));
  sh(d, 'git add f.txt');
  return sh(d, `git commit -q -F ${msgFile(d, text)}`, env);
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('.githooks/commit-msg', () => {
  const ONE_BLOCK = `feat: x\n\nbody\n\nModel: claude-sonnet-5-5\nIntent: do the thing\n${AGENT}\n`;
  it('rejects an agent commit whose Model/Intent are split from Co-Authored-By by a blank line, and says the fix', () => {
    const d = tempRepo();
    const r = commit(d, `feat: x\n\nModel: claude-sonnet-5-5\nIntent: do the thing\n\n${AGENT}\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Model:/);
    expect(r.out).toMatch(/one block|no blank line/i);
    expect(sh(d, 'git rev-list --count HEAD 2>/dev/null || echo 0').out.trim().split('\n').pop()).toBe('0');
  });
  it('rejects an agent commit with no trailers at all', () => {
    expect(commit(tempRepo(), `feat: x\n\n${AGENT}\n`).status).not.toBe(0);
  });
  it('accepts the one-block form', () => {
    const d = tempRepo();
    const r = commit(d, ONE_BLOCK);
    expect(r.out).toBe('');
    expect(r.status).toBe(0);
  });
  it('accepts a human commit', () => {
    expect(commit(tempRepo(), 'fix: a human wrote this\n').status).toBe(0);
  });
  it('ignores git comment lines in the message', () => {
    expect(commit(tempRepo(), `feat: x\n\n# Please enter the commit message\nModel: m\nIntent: i\n${AGENT}\n`).status).toBe(0);
  });
});

describe('.githooks/pre-commit', () => {
  const registry = [{ name: 'fake-gen', triggers: ['gen/'], check: 'test "$(cat gen/out.txt)" = "$(cat gen/src.txt)"', fix: 'cp gen/src.txt gen/out.txt' }];
  const stage = (d: string, out: string) => {
    mkdirSync(join(d, 'gen'), { recursive: true });
    writeFileSync(join(d, 'gen/src.txt'), 'real');
    writeFileSync(join(d, 'gen/out.txt'), out);
    sh(d, 'git add gen');
    return sh(d, 'git commit -q -m "chore: gen"', { RECKONS_GENERATED_REGISTRY: join(d, 'registry.json') });
  };
  it('rejects a commit that stages a hand-edited generated file, naming the generator and the fix', () => {
    const d = tempRepo(registry);
    const r = stage(d, 'hand edit');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('fake-gen');
    expect(r.out).toContain('cp gen/src.txt gen/out.txt');
  });
  it('accepts the regenerated file', () => {
    expect(stage(tempRepo(registry), 'real').status).toBe(0);
  });
  it('does not run a generator when none of its files are staged', () => {
    const d = tempRepo([{ name: 'never', triggers: ['gen/'], check: 'false', fix: 'x' }]);
    expect(commit(d, 'chore: unrelated\n', { RECKONS_GENERATED_REGISTRY: join(d, 'registry.json') }).status).toBe(0);
  });
  it('the real registry covers static/reckons-ci.ttl and every check names a script that exists and takes --check', () => {
    const reg = JSON.parse(readFileSync(join(REAL, 'scripts/githooks/generated.json'), 'utf8')) as { name: string; triggers: string[]; check: string; fix: string }[];
    expect(reg.some((g) => g.triggers.includes('static/reckons-ci.ttl') && /ci-graph\.ts --check/.test(g.check))).toBe(true);
    for (const g of reg) {
      const script = g.check.match(/(scripts\/[\w/.-]+\.ts)/)?.[1];
      expect(script, g.name).toBeTruthy();
      expect(existsSync(join(REAL, script!)), `${g.name}: ${script}`).toBe(true);
      expect(g.check, g.name).toContain('--check');
      expect(readFileSync(join(REAL, script!), 'utf8'), g.name).toContain("'--check'");
      expect(g.fix.length, g.name).toBeGreaterThan(0);
    }
  });
});

describe('.githooks/pre-push', () => {
  const push = (jobs: object) => {
    const d = tempRepo(undefined, jobs);
    const bare = mkdtempSync(join(tmpdir(), 'githooks-remote-'));
    made.push(bare);
    sh(bare, 'git init -q --bare');
    sh(d, `git remote add origin ${bare}`);
    commit(d, 'fix: a human commit\n');
    return sh(d, 'git push -q origin dev', { RECKONS_JOBS_FILE: join(d, 'jobs.json') });
  };
  const job = (name: string, cmd: string, blocking: boolean) => ({ name, tier: 'script', enabled: true, blocking, cmd });
  it('refuses on a blocking failure and names the job', () => {
    const r = push({ jobs: [job('good', 'true', true), job('bad-blocking', 'false', true)] });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('bad-blocking');
  });
  it('does not refuse on a non-blocking failure (advisory jobs are not run at all)', () => {
    const r = push({ jobs: [job('good', 'true', true), job('advisory', 'false', false)] });
    expect(r.out).not.toContain('advisory');
    expect(r.status).toBe(0);
  });
  it('passes when every blocking job passes', () => {
    expect(push({ jobs: [job('good', 'true', true)] }).status).toBe(0);
  });
});

describe('npm prepare', () => {
  it('sets core.hooksPath to .githooks', () => {
    const pkg = JSON.parse(readFileSync(join(REAL, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepare).toBeTruthy();
    const d = mkdtempSync(join(tmpdir(), 'githooks-prep-'));
    made.push(d);
    sh(d, 'git init -q');
    expect(sh(d, pkg.scripts.prepare).status).toBe(0);
    expect(sh(d, 'git config core.hooksPath').out.trim()).toBe('.githooks');
  });
  it('does not fail where there is no git repository', () => {
    const pkg = JSON.parse(readFileSync(join(REAL, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const d = mkdtempSync(join(tmpdir(), 'githooks-nogit-'));
    made.push(d);
    expect(sh(d, pkg.scripts.prepare, { GIT_CEILING_DIRECTORIES: tmpdir() }).status).toBe(0);
  });
});
