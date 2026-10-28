/**
 * kb:deputy-memory-readback done-test. The deputy gets a COPY of Opus's project memory each launch;
 * only what the deputy itself changed in that copy is set aside (as a patch), and the session-start
 * hook names a patch until a reviewing session marks it REVIEWED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SH = resolve(__dirname, '../deputy-memory.sh');
let src: string, cfg: string, key: string;
const dst = () => join(cfg, 'projects', key, 'memory');
const setAside = () => (existsSync(join(cfg, 'memory-written')) ? readdirSync(join(cfg, 'memory-written')) : []);
const run = (...args: string[]) => spawnSync('bash', [SH, ...args], { encoding: 'utf8' });
const sync = () => run('sync', `--src=${src}`, `--cfg=${cfg}`, `--key=${key}`);

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'deputy-memory-'));
  src = join(root, 'opus-memory'); cfg = join(root, 'cfg'); key = '-repo';
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'MEMORY.md'), '- [A](a.md)\n');
  writeFileSync(join(src, 'a.md'), 'fact a\n');
  return () => rmSync(root, { recursive: true, force: true });
});

describe('deputy-memory sync', () => {
  it('first launch copies the memory and sets nothing aside', () => {
    const r = sync();
    expect(r.status).toBe(0);
    expect(readFileSync(join(dst(), 'a.md'), 'utf8')).toBe('fact a\n');
    expect(setAside()).toEqual([]);
  });

  it('a change on Opus\'s side only sets nothing aside, and the copy follows Opus', () => {
    sync();
    writeFileSync(join(src, 'b.md'), 'fact b, written by Opus\n');
    writeFileSync(join(src, 'a.md'), 'fact a, edited by Opus\n');
    const r = sync();
    expect(r.status).toBe(0);
    expect(setAside()).toEqual([]);
    expect(readFileSync(join(dst(), 'b.md'), 'utf8')).toContain('Opus');
  });

  it('a deputy add and edit are set aside as one patch naming both, and the copy is refreshed', () => {
    sync();
    writeFileSync(join(dst(), 'c.md'), 'fact c, written by the deputy\n');
    writeFileSync(join(dst(), 'a.md'), 'fact a, edited by the deputy\n');
    writeFileSync(join(src, 'b.md'), 'fact b, written by Opus meanwhile\n');
    const r = sync();
    expect(r.status).toBe(0);
    const kept = setAside();
    expect(kept).toHaveLength(1);
    const patch = readFileSync(join(cfg, 'memory-written', kept[0], 'changes.patch'), 'utf8');
    expect(patch).toContain('c.md');
    expect(patch).toContain('+fact c, written by the deputy');
    expect(patch).toContain('+fact a, edited by the deputy');
    expect(patch).not.toContain('b.md'); // Opus's own change is not the deputy's
    expect(r.stdout).toMatch(/changes\.patch/);
    expect(readFileSync(join(dst(), 'a.md'), 'utf8')).toBe('fact a\n');
    expect(existsSync(join(dst(), 'c.md'))).toBe(false);
  });
});

describe('deputy-memory pending', () => {
  it('names an unreviewed patch, and nothing once REVIEWED is in its folder', () => {
    expect(run('pending', `--cfg=${cfg}`).stdout).toBe('');
    sync();
    writeFileSync(join(dst(), 'c.md'), 'fact c\n');
    sync();
    const line = run('pending', `--cfg=${cfg}`).stdout;
    expect(line).toMatch(/1 set-aside/);
    expect(line).toMatch(/changes\.patch/);
    writeFileSync(join(cfg, 'memory-written', setAside()[0], 'REVIEWED'), '');
    expect(run('pending', `--cfg=${cfg}`).stdout).toBe('');
  });

  it('ignores a set-aside folder from before this change (no patch in it)', () => {
    mkdirSync(join(cfg, 'memory-written', '20261024T012354Z'), { recursive: true });
    writeFileSync(join(cfg, 'memory-written', '20261024T012354Z', 'MEMORY.md'), 'old full copy\n');
    expect(run('pending', `--cfg=${cfg}`).stdout).toBe('');
  });
});
