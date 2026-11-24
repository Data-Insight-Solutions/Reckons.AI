/**
 * ONE PORT PER WORKTREE for the mock dev server the browser tests run against (found 2026-11-24).
 *
 * Every Playwright config hardcoded http://localhost:5174 with reuseExistingServer. With several git worktrees
 * testing at once (local deputy jobs, Sonnet overseers, the head session), a spec in one worktree silently reused the
 * `dev:test` server another worktree had started, and so tested ANOTHER BRANCH'S CODE: a Reckoning rerun failed
 * 4 of 8 that way while a deputy ran its own e2e, and an overseer had to move to a hand-picked port.
 *
 * The rules, in order:
 *   1. E2E_PORT, when set, wins.
 *   2. The main checkout keeps 5174, so nothing changes for a person in their own checkout, or for CI (a CI checkout
 *      is never a linked worktree).
 *   3. A linked worktree gets a stable port derived from its path, in 5400-5899, so two worktrees do not meet.
 * `npm run dev:test` reads E2E_PORT and passes --strictPort, so a clash fails loudly instead of sharing a server.
 * Importing this module sets process.env.E2E_PORT, which Playwright's webServer inherits.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAIN_PORT = 5174;
const WORKTREE_PORT_FIRST = 5400;
const WORKTREE_PORT_COUNT = 500;

export type GitPlace = { top: string; linked: boolean };

/** Pure: the port for a place in git and an optional E2E_PORT value. */
export function portFor(envPort: string | undefined, place: GitPlace | null): number {
  const asked = Number(envPort);
  if (envPort && Number.isInteger(asked) && asked > 0 && asked < 65536) return asked;
  if (!place || !place.linked) return MAIN_PORT;
  const digest = createHash('sha256').update(path.resolve(place.top)).digest();
  return WORKTREE_PORT_FIRST + (digest.readUInt32BE(0) % WORKTREE_PORT_COUNT);
}

/** Where this process stands in git: its worktree's top folder, and whether that worktree is a linked one. */
export function gitPlace(cwd = process.cwd()): GitPlace | null {
  try {
    const [top, gitDir, common] = execSync('git rev-parse --show-toplevel --git-dir --git-common-dir', {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
    return { top, linked: path.resolve(cwd, gitDir) !== path.resolve(cwd, common) };
  } catch {
    return null;
  }
}

export const E2E_PORT = portFor(process.env.E2E_PORT, gitPlace());
export const E2E_BASE = `http://localhost:${E2E_PORT}`;
process.env.E2E_PORT = String(E2E_PORT);
