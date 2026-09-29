#!/usr/bin/env npx tsx
/**
 * Opt-in online audit of every Git-tracked npm lockfile in this repository. Contacts the configured
 * npm registry with dependency metadata. Never installs, upgrades, fixes, or runs lifecycle scripts.
 * Reports the LOCKFILE, not the currently installed node_modules tree or a deployed bundle.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseDependencyAudit } from './lib/dependency-audit.js';
import { privateAuditDirectory, writePrivateAudit } from './lib/private-audit.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('dependency-health [--json] [--check]\nOnline: submits dependency metadata to the configured npm registry.\nChecks every Git-tracked package-lock.json; detailed versions, advisories, placement and suggested fixes stay in private state.\n--check: 1 vulnerabilities, 2 incomplete audit, 0 no advisories found. No auto-fix or install.');
  process.exit(0);
}
if (args.some(a => !['--json', '--check'].includes(a))) { console.error('Invalid dependency audit arguments. Use --help.'); process.exit(2); }
try {
  const dir = privateAuditDirectory();
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5_000 }).trim();
  const files = execFileSync('git', ['ls-files', '-z', '--', 'package-lock.json', '**/package-lock.json'], { cwd: root, encoding: 'utf8', timeout: 5_000 }).split('\0').filter(Boolean);
  if (!files.length) throw new Error('No supported lockfiles');
  const projects = files.map(file => {
    try {
      const full = realpathSync(path.join(root, file));
      if (!full.startsWith(realpathSync(root) + path.sep)) throw new Error('Lockfile outside repository');
      const lock = JSON.parse(readFileSync(full, 'utf8'));
      const manifest = JSON.parse(readFileSync(path.join(path.dirname(full), 'package.json'), 'utf8'));
      let output: string;
      try { output = execFileSync('npm', ['audit', '--json', '--ignore-scripts', '--package-lock-only'], { cwd: path.dirname(full), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) {
        const error = e as { status?: number; stdout?: string | Buffer };
        if (error.status !== 1 || !error.stdout) throw e;
        output = String(error.stdout);
      }
      const findings = parseDependencyAudit(output, lock, manifest);
      return { manifest: file, status: 'complete', findings };
    } catch { return { manifest: file, status: 'unknown', findings: [], error: 'Registry request, lockfile validation, or audit parsing failed; no clean result is inferred.' }; }
  });
  const report = { schema: 'reckons.dependency-health/v1', generatedAt: new Date().toISOString(), scope: 'Git-tracked npm lockfiles; lockfile placement does not establish deployed reachability', projects };
  writePrivateAudit(dir, 'dependency-health.json', JSON.stringify(report, null, 2) + '\n');
  const findings = projects.flatMap(p => p.findings);
  const summary = { schema: 'reckons.dependency-health-summary/v1', projects: projects.length, incomplete: projects.filter(p => p.status !== 'complete').length, affectedPackages: findings.length,
    severity: Object.fromEntries(['critical', 'high', 'moderate', 'low', 'info'].map(s => [s, findings.filter(f => f.severity === s).length])),
    placement: Object.fromEntries(['runtime', 'development', 'unknown'].map(s => [s, findings.filter(f => f.placement === s).length])) };
  if (args.includes('--json')) console.log(JSON.stringify(summary));
  else console.log(`Dependency audit: ${summary.projects} projects, ${summary.incomplete} incomplete; ${summary.affectedPackages} affected package entries (${summary.severity.critical} critical, ${summary.severity.high} high, ${summary.severity.moderate} moderate, ${summary.severity.low} low).\nLockfile placement: ${summary.placement.runtime} runtime, ${summary.placement.development} development, ${summary.placement.unknown} unknown.\nDetails, advisory links and top-level overrides saved privately. Inherited package entries can share one advisory; reachability and fix compatibility require review.`);
  if (args.includes('--check')) process.exitCode = summary.incomplete ? 2 : findings.length ? 1 : 0;
} catch {
  console.error('Dependency audit incomplete: private report storage or npm lockfile discovery failed. No clean result is claimed.'); process.exitCode = 2;
}
