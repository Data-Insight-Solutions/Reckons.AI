import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeRef, gitChangedFiles } from '../git-utils.js';

/**
 * F107.1 regression: the MCP's git tools take an LLM-controlled `ref` argument and once
 * built shell command strings from it. These tests pin the two-layer defence — ref
 * validation, and an argument-vector git invocation with no shell — so a hostile ref
 * cannot execute or reshape a command.
 */

describe('sanitizeRef', () => {
  it('accepts legitimate revisions and ranges', () => {
    for (const ref of [
      'HEAD', 'HEAD~1', 'HEAD^2', 'HEAD~3^1',
      'origin/dev', 'feature/foo-bar', 'release/1.2',
      'v1.2.3', 'a1b2c3d', '0123456789abcdef0123456789abcdef01234567',
      'main..dev', 'HEAD~5...HEAD', 'HEAD@{2}', 'HEAD...@{upstream}',
    ]) {
      expect(() => sanitizeRef(ref), ref).not.toThrow();
      expect(sanitizeRef(ref)).toBe(ref);
    }
  });

  it('rejects shell-metacharacter injection payloads', () => {
    for (const payload of [
      'HEAD; rm -rf ~',
      'HEAD && whoami',
      'HEAD | cat /etc/passwd',
      'HEAD$(whoami)',
      'HEAD`id`',
      'HEAD\nrm file',
      "HEAD' ; touch pwned ; '",
      'HEAD > /tmp/out',
      'a b',           // whitespace
      'HEAD&sleep 5',
    ]) {
      expect(() => sanitizeRef(payload), payload).toThrow();
    }
  });

  it('rejects option-injection refs (leading dash)', () => {
    for (const opt of ['--output=/tmp/x', '-O', '--upload-pack=evil', '-']) {
      expect(() => sanitizeRef(opt), opt).toThrow(/option|disallowed/i);
    }
  });

  it('rejects empty, non-string, and implausibly long refs', () => {
    expect(() => sanitizeRef('')).toThrow();
    // @ts-expect-error deliberately wrong type
    expect(() => sanitizeRef(undefined)).toThrow();
    expect(() => sanitizeRef('a'.repeat(257))).toThrow();
  });
});

describe('gitChangedFiles — no command executes for a hostile ref', () => {
  const sentinel = join(tmpdir(), `reckons-git-injection-${process.pid}.pwned`);

  afterEach(() => {
    if (existsSync(sentinel)) rmSync(sentinel);
  });

  it('throws and creates no side-effect file when the ref is a shell payload', () => {
    const payload = `HEAD; touch ${sentinel}`;
    expect(() => gitChangedFiles(payload, 'HEAD')).toThrow();
    // The decisive assertion: if a shell had interpreted the ref, this file would exist.
    expect(existsSync(sentinel)).toBe(false);
  });

  it('still works for a legitimate ref (HEAD..HEAD is an empty, non-throwing diff)', () => {
    const changed = gitChangedFiles('HEAD', 'HEAD');
    expect(Array.isArray(changed)).toBe(true);
    expect(changed).toHaveLength(0);
  });
});
