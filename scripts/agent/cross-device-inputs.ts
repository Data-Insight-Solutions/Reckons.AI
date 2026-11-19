/**
 * F303.1 — the file half of input checking: a request names its inputs by sha256, and the runner
 * refuses the request unless the file it finds hashes to exactly that. A symlink, a path that leaves
 * the workspace, a directory, a missing file or an oversized file are all refusals with a reason.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { InputRef } from './lib/cross-device-request.js';

export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

/** How long a request may wait for its inputs to finish syncing, from its createdAt. A PROPOSED starting
 *  value (2 hours), not a measurement: large files sync in pieces and slow links take longer. */
export const INPUT_WAIT_MS = 2 * 60 * 60_000;

/** `waiting` = the file may still be arriving (missing, or its hash differs now); `never` = waiting cannot fix it. */
export type InputVerdict = { ok: true } | { ok: false; waiting: boolean; reason: string; path?: string; expected?: string; actual?: string };

export function verifyInputs(workspace: string, inputs: readonly InputRef[]): InputVerdict {
  const root = realpathSync(workspace);
  for (const input of inputs) {
    const p = join(root, input.path);
    let st;
    try { st = lstatSync(p); } catch { return { ok: false, waiting: true, path: input.path, expected: input.sha256, reason: `input ${input.path} was not found` }; }
    if (st.isSymbolicLink()) return { ok: false, waiting: false, reason: `input ${input.path} is a symbolic link` };
    if (!st.isFile()) return { ok: false, waiting: false, reason: `input ${input.path} is not a plain file` };
    if (st.size > MAX_INPUT_BYTES) return { ok: false, waiting: false, reason: `input ${input.path} is larger than the allowed size` };
    if (!(realpathSync(p) + sep).startsWith(root + sep)) return { ok: false, waiting: false, reason: `input ${input.path} is outside the workspace` };
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (actual !== input.sha256) {
      return { ok: false, waiting: true, path: input.path, expected: input.sha256, actual, reason: `input ${input.path} does not match its sha256` };
    }
  }
  return { ok: true };
}
