/**
 * Filesystem reads and creates WITHOUT a check-then-use race.
 *
 * CodeQL flagged 16 high-severity `js/file-system-race` alerts across scripts/: "The file may have
 * changed since it was checked." Every one is the same shape —
 *
 *     existsSync(p) ? readFileSync(p, 'utf8') : ''      // read
 *     if (existsSync(p)) return; writeFileSync(p, …)    // create
 *
 * — and the gap between the check and the use is real, not theoretical, in this repo specifically:
 * the offline jobs, the agent runner and the MCP server all append to the SAME pending queue, and
 * `npm run offline:all` runs jobs concurrently. A file that appears between the check and the write
 * gets clobbered; a file that disappears between the check and the read throws from a branch the
 * author believed was safe.
 *
 * THE FIX IS TO STOP ASKING AND JUST DO IT. The kernel already performs the operation atomically;
 * the only thing `existsSync` adds is a window. Attempt the call and handle the error that says
 * what actually happened.
 *
 * Deliberately NOT a general fs wrapper. Two functions, both about the same race.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Node marks filesystem errors with a `code`; anything else is not ours to swallow. */
function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * Read a UTF-8 file, or return `fallback` if it is not there.
 *
 * Replaces `existsSync(p) ? readFileSync(p, 'utf8') : fallback`. Only ENOENT (and ENOTDIR, for a
 * path whose parent is not a directory) fall back — a permissions error or a directory-where-a-file
 * was-expected still throws, because those are bugs and swallowing them would hide the cause.
 */
export function readTextOr(file: string, fallback = ''): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return fallback;
    throw e;
  }
}

/**
 * Create a file only if it does not exist, atomically.
 *
 * Replaces `if (existsSync(p)) return; writeFileSync(p, …)`. The `wx` flag makes the kernel do the
 * check and the create in one operation, so two processes racing to seed the same header cannot
 * both win — the loser gets EEXIST and stops, which is exactly the intended behaviour.
 *
 * @returns true if THIS call created the file.
 */
export function createIfAbsent(file: string, contents: string): boolean {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, contents, { flag: 'wx' });
    return true;
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
}
