import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';

export const FILE_LOCK_ACTIVE_SUFFIX = '.active';
export const FILE_LOCK_ACTIVE_LEASE_MS = 60_000;

export function activeFileLockPath(lockPath: string): string {
  return `${lockPath}${FILE_LOCK_ACTIVE_SUFFIX}`;
}

/**
 * Standalone MCP copy of the host pending-file transaction contract.
 *
 * The MCP package is intentionally buildable and distributable without the application source, so
 * it cannot import scripts/offline/pending-queue.ts. It nevertheless uses the same `<path>.lock`
 * plus leased `<path>.lock.active` protocol, making its writes interoperable with repository agents
 * on Linux and observable to browser drains that cannot participate in `flock`.
 */
export function transactPendingFile<T>(
  file: string,
  action: (current: string) => { content?: string; result: T },
): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const activeLock = activeFileLockPath(lock);
  const lockFd = openSync(lock, 'a', 0o600);
  let activeMarkerWritten = false;
  try {
    const acquired = spawnSync('flock', ['-x', '-w', '10', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', lockFd],
      encoding: 'utf8',
    });
    if (acquired.error) throw new Error(`could not start flock: ${acquired.error.message}`);
    if (acquired.status !== 0) {
      throw new Error(`could not acquire ${lock}: ${(acquired.stderr ?? '').trim() || `flock exited ${acquired.status}`}`);
    }

    // `.lock` is a persistent flock inode, not an activity signal. The browser cannot take flock,
    // so advertise only the lifetime of this transaction through a leased sidecar marker. Atomic
    // replacement prevents it from observing a half-written JSON marker; expiry recovers crashes.
    const acquiredAt = Date.now();
    atomicReplace(activeLock, JSON.stringify({
      version: 1,
      pid: process.pid,
      acquiredAt,
      expiresAt: acquiredAt + FILE_LOCK_ACTIVE_LEASE_MS,
    }) + '\n');
    activeMarkerWritten = true;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const transaction = action(current);
    if (transaction.content !== undefined && transaction.content !== current) {
      atomicReplace(file, transaction.content);
    }
    return transaction.result;
  } finally {
    if (activeMarkerWritten) {
      try { rmSync(activeLock, { force: true }); } catch { /* finite lease handles stale cleanup */ }
    }
    closeSync(lockFd);
  }
}

export function appendPendingLines(file: string, lines: string[]): void {
  if (lines.length === 0) return;
  transactPendingFile(file, (current) => {
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    return { content: current + separator + lines.join('\n') + '\n', result: undefined };
  });
}

function atomicReplace(file: string, content: string): void {
  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    try {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      // The rename is atomic even on filesystems that do not expose directory fsync.
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}
