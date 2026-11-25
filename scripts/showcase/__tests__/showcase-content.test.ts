import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';

/**
 * F304.1 / F304.2 — the two showcase files are the only personal content in this public
 * repository, and Matt's 2026-11-19 decision (recorded on kb:personal-showcase) is what makes
 * that possible: unlisted is not private. This test keeps them honest: both parse as Turtle,
 * and neither carries a phone number, a street address, an email, or a private workspace path.
 */
const FILES = ['static/starter-matthew-roe.ttl', 'static/starter-matthew-roe-personal.ttl'] as const;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z][a-z]+/i;
const PHONE = /(?<!\d)(?:\(\d{3}\)\s?\d{3}[-. ]\d{4}|\d{3}[-. ]\d{3}[-. ]\d{4}|\d{3}[-. ]\d{4})(?!\d)/;
const STREET = /\b\d{1,5}\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|way|circle|crescent|terrace|parkway|pike|plaza|row|square|sq)\b/i;
const HOME_PATH = /\/home\//;

describe('the showcase spaces hold no contact data', () => {
  it('both parse as Turtle (n3)', () => {
    for (const f of FILES) {
      const quads = new Parser({ format: 'text/turtle' }).parse(readFileSync(f, 'utf8'));
      expect(quads.length, f).toBeGreaterThan(0);
    }
  });

  it('neither carries a phone number, street address, email, or private workspace path', () => {
    for (const f of FILES) {
      const text = readFileSync(f, 'utf8');
      expect(text, `${f} phone`).not.toMatch(PHONE);
      expect(text, `${f} street`).not.toMatch(STREET);
      expect(text, `${f} email`).not.toMatch(EMAIL);
      expect(text, `${f} /home path`).not.toMatch(HOME_PATH);
    }
  });
});
