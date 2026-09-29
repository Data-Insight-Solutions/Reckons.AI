import { describe, expect, it } from 'vitest';
import { readFileSync, lstatSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ONE DOCTRINE FILE, READABLE BY EVERY AGENT.
 *
 * The rules in AGENTS.md lived in CLAUDE.md alone until 2026-09-16. Agents that read AGENTS.md
 * by convention — Codex among them — therefore started work having seen none of them, and the
 * divergence that followed (uncommitted work that no CI gate ever saw, a new top-level nav tab)
 * was a distribution failure rather than a capability one.
 *
 * These assertions are cheap and they fail loudly, which is the point: the failure mode being
 * guarded against is silent. A copy-paste duplicate of the doctrine would drift within a month
 * and nobody would notice until an agent acted on the stale half, so the two paths must resolve
 * to the SAME bytes rather than merely say similar things.
 */
const ROOT = join(import.meta.dirname, '..', '..');

describe('agent instruction files', () => {
  it('keeps AGENTS.md as the canonical file', () => {
    expect(existsSync(join(ROOT, 'AGENTS.md'))).toBe(true);
  });

  it('serves the same bytes at CLAUDE.md, so the two can never disagree', () => {
    const claude = join(ROOT, 'CLAUDE.md');
    expect(existsSync(claude)).toBe(true);
    // A symlink is what makes drift impossible. A regular file here would be a copy.
    expect(lstatSync(claude).isSymbolicLink(), 'CLAUDE.md must be a symlink to AGENTS.md').toBe(true);
    expect(readlinkSync(claude)).toBe('AGENTS.md');
    expect(readFileSync(claude, 'utf8')).toBe(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'));
  });

  it('states the rules that were missed, so they cannot be quietly dropped', () => {
    const doctrine = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    // Not prose-matching: each of these is a rule a past session broke.
    expect(doctrine).toMatch(/Never push to `main`/i);
    expect(doctrine).toMatch(/Product shape is Matt's decision/i);
    expect(doctrine).toMatch(/reckons-roadmap\.ttl/);
    expect(doctrine).toMatch(/governs every coding agent/i);
  });
});
