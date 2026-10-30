import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const SH = resolve(__dirname, '../local-claude.sh');
function window(ctx: number) {
  const r = spawnSync('bash', [SH, `--ctx=${ctx}`], {
    env: { ...process.env, RECKONS_DEPUTY_PRINT_WINDOW: '1' },
    encoding: 'utf8'
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe('local-claude compaction threshold = max(100k, 3/4 of window)', () => {
  it('uses 3/4 on large windows (160k -> 122880)', () => {
    expect(window(163840).out).toBe('122880');
  });
  it('clamps to 100000 at gpt-oss native maximum (131072)', () => {
    const r = window(131072);
    expect(r.code).toBe(0);
    expect(r.out).toBe('100000');
  });
  it('refuses windows where 100k leaves under 24k headroom', () => {
    const r = window(98304);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too small/);
  });
});

describe('local-claude --repo (F274.1): where the deputy works', () => {
  const ROOT = resolve(__dirname, '../../..');
  function repo(args: string[], initCwd?: string) {
    const r = spawnSync('bash', [SH, ...args], {
      env: { ...process.env, RECKONS_DEPUTY_PRINT_REPO: '1', ...(initCwd ? { INIT_CWD: initCwd } : {}) },
      encoding: 'utf8'
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
  }
  function gitRepo(): string {
    const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'deputy-repo-')));
    spawnSync('git', ['init', '-q', dir]);
    return dir;
  }

  it('without --repo, works in this repository', () => {
    expect(repo([]).out).toBe(realpathSync(ROOT));
  });
  it('resolves another repository to its top level, even from a subfolder', () => {
    const dir = gitRepo();
    mkdirSync(resolve(dir, 'content/blog'), { recursive: true });
    expect(repo([`--repo=${dir}/content/blog`]).out).toBe(dir);
  });
  it('reads a relative --repo from where it was typed (INIT_CWD), not from this repository', () => {
    const dir = gitRepo();
    const parent = resolve(dir, '..');
    expect(repo([`--repo=${dir.slice(parent.length + 1)}`], parent).out).toBe(dir);
  });
  it('refuses a folder that is not a git repository', () => {
    const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'deputy-nogit-')));
    const r = repo([`--repo=${dir}`]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not inside a git repository/);
  });
});
