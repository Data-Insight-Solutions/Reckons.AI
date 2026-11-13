import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countMatches, loadTerms, scanRange, termsFilePath } from '../private-terms-check.js';

// Synthetic only: a fake term, a temp config folder, a temp fixture repository.
const TERM = 'zebrafruit-placeholder';
let tmp: string, repo: string, cfg: string, emptyCfg: string;
const script = path.resolve(__dirname, '../private-terms-check.ts');
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: repo, encoding: 'utf8' });
const commit = (file: string, text: string, msg: string) => { writeFileSync(path.join(repo, file), text); git('add', '-A'); git('commit', '-q', '-m', msg); };
const run = (config: string, ...args: string[]) =>
  spawnSync('npx', ['tsx', script, ...args, `--repo=${repo}`], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: config } });

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ptc-'));
  repo = path.join(tmp, 'repo'); cfg = path.join(tmp, 'cfg'); emptyCfg = path.join(tmp, 'empty');
  mkdirSync(repo); mkdirSync(path.join(cfg, 'reckons'), { recursive: true }); mkdirSync(emptyCfg);
  writeFileSync(path.join(cfg, 'reckons', 'private-terms.txt'), `# synthetic\n\n${TERM.toUpperCase()}\n`);
  git('init', '-q', '-b', 'main');
  commit('a.txt', 'hello\n', 'base');
  git('checkout', '-q', '-b', 'feat/clean');
  commit('b.txt', 'nothing here\n', 'clean change');
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'feat/msg');
  commit('c.txt', 'fine\n', `add c\n\nmentions ${TERM} in the body`);
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'feat/diff');
  commit('d.txt', `line one\nsee ${TERM}\n`, 'add d');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('private-terms-check (F286.3)', () => {
  it('reads the list from the config folder, case-insensitively, ignoring comments', () => {
    const t = loadTerms(termsFilePath({ XDG_CONFIG_HOME: cfg }));
    expect(t).toEqual([TERM]);
    expect(countMatches(`a ${TERM.toUpperCase()} b ${TERM}`, t!)).toBe(2);
  });
  it('finds a term in a commit message, with a position and no term', () => {
    const r = scanRange(repo, 'main', 'feat/msg', [TERM]);
    expect(r.total).toBe(1);
    expect(r.hits[0].position).toMatch(/^commit [0-9a-f]{8} message line 3$/);
  });
  it('finds a term in an added diff line with its file and line number', () => {
    const r = scanRange(repo, 'main', 'feat/diff', [TERM]);
    expect(r.hits.find((h) => h.where === 'diff')?.position).toBe('d.txt:2');
  });
  it('refuses the commit-message branch and the output holds no listed term', () => {
    const r = run(cfg, 'main', 'feat/msg');
    expect(r.status).toBe(1);
    expect((r.stdout + r.stderr).toLowerCase()).not.toContain(TERM);
  }, 60000);
  it('passes a clean branch', () => {
    const r = run(cfg, 'main', 'feat/clean');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 matches');
  }, 60000);
  it('says not configured and exits 2 when there is no list', () => {
    const r = run(emptyCfg, 'main', 'feat/clean');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not configured');
  }, 60000);
  it('flags the branch name itself and withholds a path that holds a term', () => {
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', `feat/${TERM}`);
    commit(`${TERM}.txt`, 'x\n', 'rename test');
    const r = scanRange(repo, 'main', `feat/${TERM}`, [TERM]);
    expect(r.hits.some((h) => h.where === 'branch')).toBe(true);
    expect(JSON.stringify(r.hits).toLowerCase()).not.toContain(TERM);
  });
});
