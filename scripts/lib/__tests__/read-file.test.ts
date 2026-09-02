/**
 * The check-then-use race, removed rather than narrowed.
 *
 * These pin the two behaviours that make the fix a fix: a missing file falls back instead of
 * throwing, and a real error still throws instead of being swallowed into a silent empty string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTextOr, createIfAbsent } from '../read-file';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'readfile-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readTextOr', () => {
  it('reads a file that is there', () => {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'hello');
    expect(readTextOr(f)).toBe('hello');
  });

  it('falls back when the file is absent — no existsSync, no window', () => {
    expect(readTextOr(path.join(dir, 'missing.txt'))).toBe('');
    expect(readTextOr(path.join(dir, 'missing.txt'), 'default')).toBe('default');
  });

  it('falls back when a PARENT path is not a directory (ENOTDIR)', () => {
    const notDir = path.join(dir, 'file');
    writeFileSync(notDir, 'x');
    expect(readTextOr(path.join(notDir, 'child.txt'))).toBe('');
  });

  it('THROWS on a real error rather than pretending the file was empty', () => {
    // A directory where a file was expected is EISDIR — a bug, not an absence. Swallowing it
    // would turn "you passed the wrong path" into "the queue is empty", which is how a silent
    // data-loss bug starts.
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    expect(() => readTextOr(sub)).toThrow();
  });
});

describe('createIfAbsent', () => {
  it('creates the file and reports that it did', () => {
    const f = path.join(dir, 'seed.jsonl');
    expect(createIfAbsent(f, 'header\n')).toBe(true);
    expect(readTextOr(f)).toBe('header\n');
  });

  it('does NOT clobber an existing file, and says so', () => {
    const f = path.join(dir, 'seed.jsonl');
    writeFileSync(f, 'already here');
    expect(createIfAbsent(f, 'header\n')).toBe(false);
    expect(readTextOr(f)).toBe('already here');
  });

  it('creates missing parent directories', () => {
    const f = path.join(dir, 'deep', 'nested', 'seed.txt');
    expect(createIfAbsent(f, 'x')).toBe(true);
    expect(readTextOr(f)).toBe('x');
  });

  it('only ONE of two racing creates wins', () => {
    // The whole point: the kernel arbitrates, not a prior existsSync.
    const f = path.join(dir, 'race.txt');
    const results = [createIfAbsent(f, 'first'), createIfAbsent(f, 'second')];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(readTextOr(f)).toBe('first');
  });
});
