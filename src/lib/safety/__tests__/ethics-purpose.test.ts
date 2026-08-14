import { describe, it, expect } from 'vitest';
import {
  ethicsPreambleFor,
  requiresEthicsPreamble,
  ETHICS_PREAMBLE,
  type PromptPurpose,
} from '../content-policy';

/**
 * The preamble is ~121 tokens and rode on 12 prompts, dominating the smallest of them (78% of
 * merge-analysis's inline prompt). Splitting by PURPOSE removes it from paths where a
 * deterministic filter already vets the output — and the entire split rests on one invariant:
 * SHARING ALWAYS CARRIES IT. These tests exist to make that invariant expensive to break.
 */

describe('sharing always carries the preamble', () => {
  it('returns the full preamble for share', () => {
    expect(ethicsPreambleFor('share')).toBe(ETHICS_PREAMBLE);
  });

  it('never returns empty for share', () => {
    // The invariant a future token optimization would be most tempted to shave.
    expect(ethicsPreambleFor('share').trim().length).toBeGreaterThan(0);
    expect(requiresEthicsPreamble('share')).toBe(true);
  });

  it('keeps the non-negotiable clauses in the shared text', () => {
    const p = ethicsPreambleFor('share');
    expect(p).toMatch(/sexualizes minors/i);
    expect(p).toMatch(/incites violence/i);
    expect(p).toMatch(/weapons of mass destruction/i);
  });
});

describe('conversation carries it too — no filter can vet prose', () => {
  it('returns the full preamble for converse', () => {
    expect(ethicsPreambleFor('converse')).toBe(ETHICS_PREAMBLE);
    expect(requiresEthicsPreamble('converse')).toBe(true);
  });
});

describe('structured output omits it — the result is filtered instead', () => {
  it('returns empty for structured', () => {
    // Not because it is cheap, but because filterBlockedStatements classifies and blocks
    // every statement written through addStatements regardless of what the model was told.
    expect(ethicsPreambleFor('structured')).toBe('');
    expect(requiresEthicsPreamble('structured')).toBe(false);
  });
});

describe('the split is total — no purpose falls through unclassified', () => {
  const ALL: PromptPurpose[] = ['share', 'converse', 'structured'];

  it('every purpose gets a decision', () => {
    for (const p of ALL) {
      expect(typeof requiresEthicsPreamble(p)).toBe('boolean');
      expect(typeof ethicsPreambleFor(p)).toBe('string');
    }
  });

  it('exactly one purpose omits the preamble', () => {
    // If a future edit added a second omitting purpose, that should be a deliberate act with
    // a test change, not a quiet widening of the exemption.
    expect(ALL.filter((p) => ethicsPreambleFor(p) === '')).toEqual(['structured']);
  });
});

// ── Locality (Matt, 2026-08-14: "not for local only usage") ──────────────────

describe('local-only usage omits the preamble', () => {
  it('omits it for local conversation — nobody but the user is in the room', () => {
    // kb:tenet-private: "A private graph makes no claim on anybody."
    expect(ethicsPreambleFor('converse', 'local')).toBe('');
    expect(requiresEthicsPreamble('converse', 'local')).toBe(false);
  });

  it('still carries it for remote conversation', () => {
    expect(ethicsPreambleFor('converse', 'remote')).toBe(ETHICS_PREAMBLE);
  });

  it('defaults to remote when locality is not stated', () => {
    // The safe default: an unlabelled call gets the preamble rather than silently losing it.
    expect(ethicsPreambleFor('converse')).toBe(ETHICS_PREAMBLE);
  });
});

describe('SHARING OUTRANKS LOCALITY — the invariant', () => {
  it('carries the preamble even when the model is local', () => {
    // A persona served from a model on this machine is still read by somebody else.
    // Locality says nothing about who is exposed.
    expect(ethicsPreambleFor('share', 'local')).toBe(ETHICS_PREAMBLE);
    expect(requiresEthicsPreamble('share', 'local')).toBe(true);
  });

  it('never returns empty for share under ANY locality', () => {
    for (const loc of ['local', 'remote'] as const) {
      expect(ethicsPreambleFor('share', loc).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the full matrix is decided — nothing falls through', () => {
  it('every purpose x locality pair has an explicit answer', () => {
    const purposes = ['share', 'converse', 'structured'] as const;
    const localities = ['local', 'remote'] as const;
    const carries: string[] = [];
    for (const p of purposes) {
      for (const l of localities) {
        if (requiresEthicsPreamble(p, l)) carries.push(`${p}/${l}`);
      }
    }
    // Exactly these three combinations carry it. A future edit widening or narrowing the
    // exemption should have to change this line deliberately.
    expect(carries.sort()).toEqual(['converse/remote', 'share/local', 'share/remote']);
  });
});
