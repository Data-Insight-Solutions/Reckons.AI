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

export function verifyInputs(workspace: string, inputs: readonly InputRef[]): { ok: true } | { ok: false; reason: string } {
  const root = realpathSync(workspace);
  for (const input of inputs) {
    const p = join(root, input.path);
    let st;
    try { st = lstatSync(p); } catch { return { ok: false, reason: `input ${input.path} was not found` }; }
    if (st.isSymbolicLink()) return { ok: false, reason: `input ${input.path} is a symbolic link` };
    if (!st.isFile()) return { ok: false, reason: `input ${input.path} is not a plain file` };
    if (st.size > MAX_INPUT_BYTES) return { ok: false, reason: `input ${input.path} is larger than the allowed size` };
    if (!(realpathSync(p) + sep).startsWith(root + sep)) return { ok: false, reason: `input ${input.path} is outside the workspace` };
    if (createHash('sha256').update(readFileSync(p)).digest('hex') !== input.sha256) {
      return { ok: false, reason: `input ${input.path} does not match its sha256` };
    }
  }
  return { ok: true };
}
