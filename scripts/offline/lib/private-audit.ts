/** Private audit artifacts must never be placed in a checkout or follow a symlink. */
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function privateAuditDirectory(stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state')): string {
  if (!path.isAbsolute(stateHome)) throw new Error('Private audit state location must be absolute.');
  const dir = path.resolve(stateHome, 'reckons', 'security-audit');
  for (let p = dir; ; p = path.dirname(p)) {
    if (existsSync(path.join(p, '.git'))) throw new Error('Refusing audit output inside a Git checkout.');
    try { if (lstatSync(p).isSymbolicLink()) throw new Error('Refusing symlinked audit output path.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function writePrivateAudit(dir: string, filename: string, content: string): void {
  if (!/^[a-z][a-z0-9.-]*$/.test(filename)) throw new Error('Invalid audit filename.');
  const info = lstatSync(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Audit directory must be private and owned by this user.');
  }
  // On Linux, anchor writes to the open directory rather than looking up its name again. This
  // prevents replacing the final directory with a symlink between the check and file creation.
  // This is local file hygiene, not a sandbox against code already running as the same user.
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
  const opened = fstatSync(dirFd);
  if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Audit directory changed.');
  if (process.platform === 'linux') dir = `/proc/self/fd/${dirFd}`;
  const target = path.join(dir, filename);
  try { if (!lstatSync(target).isFile() || lstatSync(target).nlink !== 1) throw new Error('Unsafe existing audit artifact.'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temp = path.join(dir, `.${filename}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content);
    closeSync(fd); fd = undefined;
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
  } finally { closeSync(dirFd); }
}
