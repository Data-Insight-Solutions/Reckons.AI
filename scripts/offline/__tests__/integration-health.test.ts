import { describe, expect, it } from 'vitest';
import { normalizeVersion, parseN8nVersions } from '../integration-health';

describe('integration-health network boundary', () => {
  it('accepts bounded release versions and rejects display/control injection', () => {
    expect(normalizeVersion('v0.11.10')).toBe('v0.11.10');
    expect(normalizeVersion('2.30.1-beta.2')).toBe('2.30.1-beta.2');
    expect(normalizeVersion('2.30.1\nforged finding')).toBeUndefined();
  });

  it('keeps only structurally valid n8n release records', () => {
    expect(parseN8nVersions([
      {
        name: '2.31.0',
        createdAt: '2026-08-29T00:00:00Z',
        hasSecurityIssue: false,
        hasSecurityFix: true,
        hasBreakingChange: false,
      },
      {
        name: '2.31.1\nforged',
        createdAt: 'not-a-date',
        hasSecurityIssue: 'yes',
        hasSecurityFix: true,
        hasBreakingChange: false,
      },
    ])).toEqual([expect.objectContaining({ name: '2.31.0', hasSecurityFix: true })]);
  });
});
