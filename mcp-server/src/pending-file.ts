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

/**
 * Standalone MCP copy of the host pending-file transaction contract.
 *
 * The MCP package is intentionally buildable and distributable without the application source, so
 * it cannot import scripts/offline/pending-queue.ts. It nevertheless uses the same `<path>.lock`
 * protocol, making its writes interoperable with repository agents on Linux. Browser drains cannot
 * participate in `flock` and remain an explicitly separate cross-runtime boundary.
 */
export function transactPendingFile<T>(
  file: string,
  action: (current: string) => { content?: string; result: T },
): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const lockFd = openSync(lock, 'a', 0o600);
  try {
    const acquired = spawnSync('flock', ['-x', '-w', '10', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', lockFd],
      encoding: 'utf8',
    });
    if (acquired.error) throw new Error(`could not start flock: ${acquired.error.message}`);
    if (acquired.status !== 0) {
      throw new Error(`could not acquire ${lock}: ${(acquired.stderr ?? '').trim() || `flock exited ${acquired.status}`}`);
    }
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const transaction = action(current);
    if (transaction.content !== undefined && transaction.content !== current) {
      atomicReplace(file, transaction.content);
    }
    return transaction.result;
  } finally {
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
