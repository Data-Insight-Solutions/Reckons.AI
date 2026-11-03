import { describe, expect, it } from 'vitest';
import { isSafeWebHref } from '../safe-href';

describe('isSafeWebHref (stored values are attacker-influenced)', () => {
  it('allows http and https links, case-insensitively', () => {
    expect(isSafeWebHref('https://example.org/data-insight-solutions/reckons.ai')).toBe(true);
    expect(isSafeWebHref('http://example.org')).toBe(true);
    expect(isSafeWebHref('HTTPS://EXAMPLE.ORG/')).toBe(true);
  });
  it('refuses script and data schemes', () => {
    expect(isSafeWebHref('javascript:alert(1)')).toBe(false);
    expect(isSafeWebHref('javascript:alert(1)#')).toBe(false);
    expect(isSafeWebHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });
  it('refuses other schemes and malformed values', () => {
    expect(isSafeWebHref('urn:kbase:entity/repo')).toBe(false);
    expect(isSafeWebHref('https://')).toBe(false);
    expect(isSafeWebHref('example.org')).toBe(false);
    expect(isSafeWebHref('')).toBe(false);
    expect(isSafeWebHref(null)).toBe(false);
    expect(isSafeWebHref(undefined)).toBe(false);
  });
});
