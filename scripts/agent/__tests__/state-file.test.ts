import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeFileLockPath,
  FILE_LOCK_ACTIVE_LEASE_MS,
  withFileLock,
} from '../state-file';

let directory: string;
let lockPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reckons-state-lock-'));
  lockPath = join(directory, 'state.json.lock');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('withFileLock browser-visible lifecycle', () => {
  it('keeps the flock pathname but exposes an active marker only during the transaction', () => {
    const before = Date.now();
    const value = withFileLock(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(activeFileLockPath(lockPath))).toBe(true);
      const marker = JSON.parse(readFileSync(activeFileLockPath(lockPath), 'utf8')) as {
        version: number;
        pid: number;
        acquiredAt: number;
        expiresAt: number;
      };
      expect(marker).toMatchObject({ version: 1, pid: process.pid });
      expect(marker.acquiredAt).toBeGreaterThanOrEqual(before);
      expect(marker.expiresAt - marker.acquiredAt).toBe(FILE_LOCK_ACTIVE_LEASE_MS);
      return 'committed';
    });

    expect(value).toBe('committed');
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(activeFileLockPath(lockPath))).toBe(false);
  });

  it('removes the active marker when the protected action throws', () => {
    expect(() => withFileLock(lockPath, () => {
      expect(existsSync(activeFileLockPath(lockPath))).toBe(true);
      throw new Error('transaction failed');
    })).toThrow('transaction failed');

    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(activeFileLockPath(lockPath))).toBe(false);
  });

  it('replaces a marker stranded by an earlier crash with the current lease', () => {
    writeFileSync(activeFileLockPath(lockPath), JSON.stringify({ expiresAt: Date.now() - 1 }));

    withFileLock(lockPath, () => {
      const marker = JSON.parse(readFileSync(activeFileLockPath(lockPath), 'utf8')) as { expiresAt: number };
      expect(marker.expiresAt).toBeGreaterThan(Date.now());
    });

    expect(existsSync(activeFileLockPath(lockPath))).toBe(false);
  });
});
