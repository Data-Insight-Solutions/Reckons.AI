import { describe, it, expect } from 'vitest';
import { sameLicense } from '../license-compare.ts';

describe('sameLicense', () => {
  it('treats the graph "none" and the API "NONE" as the same unlicensed state', () => {
    expect(sameLicense('NONE', 'none')).toBe(true);
  });
  it('ignores case and surrounding space in SPDX ids', () => {
    expect(sameLicense('MIT', 'mit')).toBe(true);
    expect(sameLicense('Apache-2.0', ' apache-2.0 ')).toBe(true);
  });
  it('still reports a real change', () => {
    expect(sameLicense('AGPL-3.0', 'MIT')).toBe(false);
    expect(sameLicense('MIT', 'none')).toBe(false);
  });
  it('never matches a repo the graph has no record for', () => {
    expect(sameLicense('MIT', 'UNKNOWN')).toBe(false);
  });
});
