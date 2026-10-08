// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDependencyAudit } from '../lib/dependency-audit';

const report = (vulnerabilities: object) => JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } });
const vulnerability = { severity: 'high', isDirect: false, nodes: ['node_modules/example'], range: '<2', fixAvailable: { name: 'example', version: '2.0.0', isSemVerMajor: true }, via: [{ title: 'Synthetic advisory', url: 'https://example.invalid/advisory', severity: 'high', range: '<2' }] };
describe('dependency advisory evidence', () => {
  it('retains versions, directness, placement, advisories and breaking fix suggestions', () => {
    const findings = parseDependencyAudit(report({ example: vulnerability }), { packages: { 'node_modules/example': { version: '1.0.0' } } }, { overrides: { example: '1.0.0' } });
    expect(findings[0]).toMatchObject({ placement: 'runtime', direct: false, installed: [{ version: '1.0.0' }], reachability: 'not-assessed', fix: { isSemVerMajor: true } });
    expect(findings[0].advisories).toHaveLength(1);
    expect(findings[0].topLevelOverride).toBe('1.0.0');
    const dev = parseDependencyAudit(report({ example: vulnerability }), { packages: { 'node_modules/example': { version: '1.0.0', dev: true } } });
    expect(dev[0].placement).toBe('development');
  });
  it('does not invent a distinct advisory for inherited vulnerability paths', () => {
    const f = parseDependencyAudit(report({ parent: { ...vulnerability, via: ['example'] } }), { packages: {} })[0];
    expect(f.advisories).toEqual([]); expect(f.inheritedFrom).toEqual(['example']); expect(f.placement).toBe('unknown');
  });
  it('fails closed on registry errors, malformed data, and missing audit metadata', () => {
    for (const input of ['{}', 'broken', '{"error":{"code":"E403"}}', '{"auditReportVersion":2,"vulnerabilities":{}}']) expect(() => parseDependencyAudit(input, { packages: {} })).toThrow();
    expect(() => parseDependencyAudit(report({ example: { ...vulnerability, severity: 'safe' } }), { packages: {} })).toThrow();
    expect(() => parseDependencyAudit(report({ example: vulnerability }), { packages: { 'node_modules/example': { version: '1.0.0', dev: 'false' } } })).toThrow();
    expect(parseDependencyAudit(report({}), { packages: {} })).toEqual([]);
  });
  it('reports incomplete projects separately from known findings and never fixes packages', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dependency-audit-test-'));
    try {
      const repo = path.join(root, 'repo'), bin = path.join(root, 'bin');
      mkdirSync(path.join(repo, 'nested'), { recursive: true }); mkdirSync(bin);
      for (const dir of [repo, path.join(repo, 'nested')]) {
        writeFileSync(path.join(dir, 'package.json'), '{"name":"synthetic-audit-fixture","version":"1.0.0"}');
        writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/example': { version: '1.0.0' } } }));
      }
      execFileSync('git', ['init', '--quiet', repo]);
      execFileSync('git', ['-C', repo, 'add', '.']);
      const audit = report({ example: vulnerability });
      // Synthetic npm response: fail the nested registry request, retain the root advisory.
      writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\n[ "$*" = "audit --json --ignore-scripts --package-lock-only" ] || exit 3\ncase "$PWD" in */nested) printf '%s' '{"error":{"code":"E403"}}';; *) printf '%s' '${audit}';; esac\nexit 1\n`, { mode: 0o700 });
      const before = readFileSync(path.join(repo, 'package-lock.json'), 'utf8');
      let result: { stdout?: string | Buffer; status?: number } = {};
      try {
        execFileSync(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), path.join(process.cwd(), 'scripts/offline/dependency-health.ts'), '--json', '--check'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, XDG_STATE_HOME: path.join(root, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { result = e as typeof result; }
      expect(result.status).toBe(2);
      const summary = JSON.parse(String(result.stdout));
      expect(summary).toMatchObject({ projects: 2, incomplete: 1, affectedPackages: 1, severity: { high: 1 } });
      expect(readFileSync(path.join(repo, 'package-lock.json'), 'utf8')).toBe(before);
      const saved = JSON.parse(readFileSync(path.join(root, 'state/reckons/security-audit/dependency-health.json'), 'utf8'));
      expect(saved.projects.map((p: any) => p.status).sort()).toEqual(['complete', 'unknown']);
      expect(String(result.stdout)).not.toContain(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
