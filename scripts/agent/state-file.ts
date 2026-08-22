import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Hold a kernel flock for one short synchronous state transaction.
 *
 * The flock child locks inherited fd 3. Linux associates the lock with the shared open-file
 * description, so it remains held by the parent until `closeSync(fd)`. Process death releases it
 * automatically; the persistent empty `.lock` pathname therefore needs no stale-PID reaper. */
export function withFileLock<T>(lockPath: string, action: () => T, timeoutSeconds = 10): T {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = openSync(lockPath, 'a', 0o600);
  try {
    const locked = spawnSync('flock', ['-x', '-w', String(timeoutSeconds), '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
      encoding: 'utf8',
    });
    if (locked.error) throw new Error(`could not start flock: ${locked.error.message}`);
    if (locked.status !== 0) {
      throw new Error(`could not acquire ${lockPath}: ${(locked.stderr ?? '').trim() || `flock exited ${locked.status}`}`);
    }
    return action();
  } finally {
    closeSync(fd);
  }
}

/** Crash-safe replacement in the destination directory: write + fsync + atomic rename. */
export function atomicWriteFile(file: string, content: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    // Best effort directory fsync: the rename is already atomic; this additionally asks Linux to
    // persist the directory entry before a sudden power loss.
    try {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      /* Some filesystems do not permit directory fsync. */
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}
