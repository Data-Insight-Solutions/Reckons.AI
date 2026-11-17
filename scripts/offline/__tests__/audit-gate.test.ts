import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs with JSDoc-free exports, run by CI without an install step
import { advisoryId, evaluateAudit, validateExceptions } from '../audit-gate.mjs';

/** A minimal auditReportVersion 2 report with one package and the given advisories. */
function report(pkg: string, via: Array<Record<string, unknown> | string>, severity = 'high') {
  return { auditReportVersion: 2, vulnerabilities: { [pkg]: { name: pkg, severity, via } }, metadata: { vulnerabilities: {} } };
}
const adv = (id: string, severity: string, name = 'pkg-a') =>
  ({ source: 1, name, title: `title ${id}`, url: `https://github.com/advisories/${id}`, severity, range: '<9' });
const exception = (over: Record<string, unknown> = {}) => ({
  id: 'GHSA-aaaa-bbbb-cccc', package: 'pkg-a', reason: 'not reachable: no server', decided: 'synthetic decision', expires: '2026-12-15', ...over,
});
const today = '2026-11-17';

describe('audit-gate', () => {
  it('reads the GHSA id out of an advisory URL', () => {
    expect(advisoryId('https://github.com/advisories/GHSA-3r8g-jcqq-3p5j')).toBe('GHSA-3r8g-jcqq-3p5j');
    expect(advisoryId('https://example.test/no-id')).toBeNull();
  });

  it('blocks an advisory at the level when no exception names it', () => {
    const r = evaluateAudit(report('pkg-a', [adv('GHSA-aaaa-bbbb-cccc', 'moderate')]), { exceptions: [] }, { level: 'moderate', today });
    expect(r.pass).toBe(false);
    expect(r.blocking.map((a: { id: string }) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('passes an advisory that an unexpired exception names by id AND package, and still reports it', () => {
    const r = evaluateAudit(report('pkg-a', [adv('GHSA-aaaa-bbbb-cccc', 'high')]), { exceptions: [exception()] }, { level: 'moderate', today });
    expect(r.pass).toBe(true);
    expect(r.excepted).toHaveLength(1);
    expect(r.excepted[0].expires).toBe('2026-12-15');
  });

  it('does not let an exception for one package cover the same id on another', () => {
    const r = evaluateAudit(report('pkg-b', [adv('GHSA-aaaa-bbbb-cccc', 'high', 'pkg-b')]), { exceptions: [exception()] }, { level: 'moderate', today });
    expect(r.pass).toBe(false);
    expect(r.unused).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('blocks again once the exception has expired', () => {
    const r = evaluateAudit(report('pkg-a', [adv('GHSA-aaaa-bbbb-cccc', 'high')]), { exceptions: [exception({ expires: '2026-11-16' })] }, { level: 'moderate', today });
    expect(r.pass).toBe(false);
    expect(r.blocking[0].why).toMatch(/expired 2026-11-16/);
  });

  it('keeps blocking the advisories an exception does not name', () => {
    const r = evaluateAudit(report('pkg-a', [adv('GHSA-aaaa-bbbb-cccc', 'high'), adv('GHSA-dddd-eeee-ffff', 'moderate')]),
      { exceptions: [exception()] }, { level: 'moderate', today });
    expect(r.pass).toBe(false);
    expect(r.blocking.map((a: { id: string }) => a.id)).toEqual(['GHSA-dddd-eeee-ffff']);
  });

  it('lists advisories below the level without blocking on them', () => {
    const r = evaluateAudit(report('pkg-a', [adv('GHSA-aaaa-bbbb-cccc', 'low')], 'low'), { exceptions: [] }, { level: 'moderate', today });
    expect(r.pass).toBe(true);
    expect(r.below).toHaveLength(1);
  });

  it('counts an inherited entry (a package name in via) only where the advisory is filed', () => {
    const rep = { auditReportVersion: 2, metadata: {}, vulnerabilities: {
      'pkg-a': { name: 'pkg-a', severity: 'high', via: [adv('GHSA-aaaa-bbbb-cccc', 'high')] },
      'pkg-wrapper': { name: 'pkg-wrapper', severity: 'high', via: ['pkg-a'] },
    } };
    const r = evaluateAudit(rep, { exceptions: [] }, { level: 'moderate', today });
    expect(r.blocking).toHaveLength(1);
  });

  it('fails closed on an npm error report instead of reading it as clean', () => {
    expect(() => evaluateAudit({ error: { code: 'ENOAUDIT', summary: 'registry down' } }, { exceptions: [] }, { level: 'moderate', today }))
      .toThrow(/incomplete npm audit report: registry down/);
  });

  it('refuses an exception with no reason, no decision or a bad date', () => {
    expect(validateExceptions({ exceptions: [exception({ reason: ' ' })] })[0]).toMatch(/"reason" is required/);
    expect(validateExceptions({ exceptions: [exception({ decided: undefined })] })[0]).toMatch(/"decided" is required/);
    expect(validateExceptions({ exceptions: [exception({ expires: 'soon' })] })[0]).toMatch(/YYYY-MM-DD/);
    const r = evaluateAudit(report('pkg-a', [adv('GHSA-aaaa-bbbb-cccc', 'high')]), { exceptions: [exception({ reason: '' })] }, { level: 'moderate', today });
    expect(r.pass).toBe(false);
  });

  it('the checked-in exceptions file is valid', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = JSON.parse(readFileSync('.github/audit-exceptions.json', 'utf8'));
    expect(validateExceptions(doc)).toEqual([]);
  });
});
