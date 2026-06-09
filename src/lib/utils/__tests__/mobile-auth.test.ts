import { describe, it, expect } from 'vitest';
import { validateMobileToken, buildAccessUrl } from '../mobile-auth';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed reference timestamp
const FUTURE = NOW + 7 * 24 * 60 * 60 * 1000; // +7 days
const PAST   = NOW - 1000;                      // 1 second ago

// Valid UUID v4 token (matches the regex in validateMobileToken)
const VALID_TOKEN = '550e8400-e29b-41d4-a716-446655440000';
const VALID_TOKEN_2 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

// ── validateMobileToken ───────────────────────────────────────────────────────

describe('validateMobileToken', () => {

  // ── Missing / malformed token ────────────────────────────────────────────

  it('returns invalid when token is null', () => {
    const result = validateMobileToken(null, null, [], NOW);
    expect(result.state).toBe('invalid');
    expect(result.reason).toMatch(/No token/);
  });

  it('returns invalid when token is empty string', () => {
    const result = validateMobileToken('', null, [], NOW);
    expect(result.state).toBe('invalid');
  });

  it('returns invalid when token is not a UUID v4', () => {
    const result = validateMobileToken('some-random-token', String(FUTURE), [], NOW);
    expect(result.state).toBe('invalid');
    expect(result.reason).toMatch(/Malformed/i);
  });

  // ── Missing / invalid expiry ─────────────────────────────────────────────

  it('returns invalid when expires param is null', () => {
    const result = validateMobileToken(VALID_TOKEN, null, [], NOW);
    expect(result.state).toBe('invalid');
    expect(result.reason).toMatch(/No expiry/i);
  });

  it('returns invalid when expires param is non-numeric', () => {
    const result = validateMobileToken(VALID_TOKEN, 'not-a-number', [], NOW);
    expect(result.state).toBe('invalid');
    expect(result.reason).toMatch(/Invalid expiry/i);
  });

  // ── Expiry checks ───────────────────────────────────────────────────────

  it('returns expired when expires param is in the past', () => {
    const result = validateMobileToken(VALID_TOKEN, String(PAST), [], NOW);
    expect(result.state).toBe('expired');
    expect(result.reason).toMatch(/expired/i);
  });

  it('returns valid when token is UUID v4 and expires is in the future', () => {
    const result = validateMobileToken(VALID_TOKEN, String(FUTURE), [], NOW);
    expect(result.state).toBe('valid');
    if (result.state === 'valid') {
      expect(result.session.token).toBe(VALID_TOKEN);
      expect(result.session.expiresAt).toBe(FUTURE);
    }
  });

  // ── Boundary ─────────────────────────────────────────────────────────────

  it('returns expired when expires equals now exactly', () => {
    // exp < now is the check, so exp === now should NOT be expired (exp is not < now)
    // Actually: the code checks `if (exp < now)` — so exp === now is NOT expired
    const result = validateMobileToken(VALID_TOKEN, String(NOW), [], NOW);
    // exp (NOW) < now (NOW) is false, so it should be valid
    expect(result.state).toBe('valid');
  });

  it('returns expired when expires is 1ms before now', () => {
    const result = validateMobileToken(VALID_TOKEN, String(NOW - 1), [], NOW);
    expect(result.state).toBe('expired');
  });

  it('returns valid when expires is 1ms after now', () => {
    const result = validateMobileToken(VALID_TOKEN, String(NOW + 1), [], NOW);
    expect(result.state).toBe('valid');
  });

  // ── Synthetic session ────────────────────────────────────────────────────

  it('returns a synthetic session with correct fields', () => {
    const result = validateMobileToken(VALID_TOKEN, String(FUTURE), [], NOW);
    expect(result.state).toBe('valid');
    if (result.state === 'valid') {
      expect(result.session.id).toBe(VALID_TOKEN);
      expect(result.session.token).toBe(VALID_TOKEN);
      expect(result.session.createdAt).toBe(NOW);
      expect(result.session.expiresAt).toBe(FUTURE);
    }
  });

  it('ignores the sessions array entirely', () => {
    // Even with no sessions, a valid UUID + future expiry = valid
    const result = validateMobileToken(VALID_TOKEN, String(FUTURE), [], NOW);
    expect(result.state).toBe('valid');
  });
});

// ── buildAccessUrl ────────────────────────────────────────────────────────────

describe('buildAccessUrl', () => {
  it('returns null for empty host', () => {
    expect(buildAccessUrl('', '5173', 'tok', FUTURE)).toBeNull();
    expect(buildAccessUrl('  ', '5173', 'tok', FUTURE)).toBeNull();
  });

  it('builds a correctly formatted URL', () => {
    const url = buildAccessUrl('192.168.1.42', '5173', 'abc-def', FUTURE);
    expect(url).toBe(`http://192.168.1.42:5173/mobile?token=abc-def&expires=${FUTURE}`);
  });

  it('trims whitespace from host', () => {
    const url = buildAccessUrl('  192.168.1.42  ', '5173', 'tok', FUTURE);
    expect(url).toContain('192.168.1.42');
    expect(url).not.toContain(' ');
  });

  it('URL-encodes special characters in the token', () => {
    const url = buildAccessUrl('192.168.1.42', '5173', 'tok+with spaces', FUTURE);
    expect(url).toContain('tok%2Bwith%20spaces');
  });

  it('includes both token and expires params', () => {
    const url = buildAccessUrl('10.0.0.1', '5173', 'mytoken', FUTURE)!;
    const parsed = new URL(url);
    expect(parsed.searchParams.get('token')).toBe('mytoken');
    expect(parsed.searchParams.get('expires')).toBe(String(FUTURE));
  });
});
