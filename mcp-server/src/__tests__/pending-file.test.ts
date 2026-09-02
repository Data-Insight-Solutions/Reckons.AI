import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeFileLockPath,
  FILE_LOCK_ACTIVE_LEASE_MS,
  transactPendingFile,
} from '../pending-file.js';

let directory: string;
let pendingFile: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reckons-mcp-lock-'));
  pendingFile = join(directory, 'knowledge.pending.jsonl');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('pending-file active lock marker', () => {
  it('mirrors the shared host protocol for the real MCP queue writer lifecycle', () => {
    const lockPath = `${pendingFile}.lock`;
    const markerPath = activeFileLockPath(lockPath);
    const result = transactPendingFile(pendingFile, (current) => {
      expect(current).toBe('');
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        version: number;
        pid: number;
        acquiredAt: number;
        expiresAt: number;
      };
      expect(marker).toMatchObject({ version: 1, pid: process.pid });
      expect(marker.expiresAt - marker.acquiredAt).toBe(FILE_LOCK_ACTIVE_LEASE_MS);
      return { content: 'queued\n', result: 'written' };
    });

    expect(result).toBe('written');
    expect(readFileSync(pendingFile, 'utf8')).toBe('queued\n');
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('cleans up the marker when the MCP transaction throws', () => {
    const markerPath = activeFileLockPath(`${pendingFile}.lock`);

    expect(() => transactPendingFile(pendingFile, () => {
      expect(existsSync(markerPath)).toBe(true);
      throw new Error('MCP transaction failed');
    })).toThrow('MCP transaction failed');

    expect(existsSync(markerPath)).toBe(false);
  });
});
