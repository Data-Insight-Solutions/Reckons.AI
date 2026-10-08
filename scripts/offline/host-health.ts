#!/usr/bin/env npx tsx
/**
 * Reusable Linux host audit (F172.1), script tier. No sudo, network probes, service changes,
 * package installs, or model calls. Default output is aggregate-only, suitable for agent logs.
 * Details: $XDG_STATE_HOME/reckons/security-audit/host-health.json (0600, outside Git).
 * --pending writes a PRIVATE proposal snapshot beside the report, never the shared queue.
 * Local policy: $XDG_CONFIG_HOME/reckons/host-health.json (defaults under ~/.config).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { collectHostChecks, DEFAULT_POLICY, parsePolicy, safeSummary, type ProbeIO } from './lib/host-probes.js';
import { privateAuditDirectory, writePrivateAudit } from './lib/private-audit.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('host-health [--json | --details] [--pending] [--deep] [--check]\nPrivate reports: $XDG_STATE_HOME/reckons/security-audit (default ~/.local/state).\nPolicy: $XDG_CONFIG_HOME/reckons/host-health.json (default ~/.config).\n--check: 0 all checked controls pass; 1 findings; 2 unknown/skipped controls.\n--pending stays private; it never writes to a repository workspace.');
  process.exit(0);
}
if (args.some(a => !['--json', '--details', '--pending', '--deep', '--check'].includes(a)) || args.includes('--json') && args.includes('--details')) {
  console.error('Invalid host-health arguments. Use --help.'); process.exit(2);
}

const io: ProbeIO = {
  now: Date.now(), platform: process.platform, desktop: process.env.XDG_CURRENT_DESKTOP,
  run(command, argv, timeout = 10_000) {
    try {
      return { stdout: execFileSync(command, argv, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) {
      const err = e as { stdout?: string | Buffer; status?: number };
      return { stdout: String(err.stdout ?? ''), code: err.status ?? null };
    }
  },
  read(file) { try { if (statSync(file).size > 2 * 1024 * 1024) return null; return readFileSync(file, 'utf8'); } catch { return null; } },
  stat(file) { try { const s = statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } },
};

try {
  const dir = privateAuditDirectory();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  if (!path.isAbsolute(configHome)) throw new Error('Invalid config root');
  const policyFile = path.join(configHome, 'reckons/host-health.json');
  let policy = DEFAULT_POLICY;
  try { policy = parsePolicy(readFileSync(policyFile, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const checks = collectHostChecks(io, policy, args.includes('--deep'));
  const generatedAt = new Date(io.now).toISOString();
  writePrivateAudit(dir, 'host-health.json', JSON.stringify({ schema: 'reckons.host-health/v1', generatedAt, checks }, null, 2) + '\n');
  if (args.includes('--pending')) {
    const proposals = checks.filter(c => ['fail', 'unknown'].includes(c.status)).map(c => ({
      subject: 'urn:reckons:local-host', predicate: 'urn:reckons:host/' + c.id, object: c.status,
      note: c.detail, type: c.status === 'fail' ? 'observation' : 'question',
      priority: c.status === 'fail' ? 'high' : 'normal', agent: 'host-health', generatedAt,
    }));
    writePrivateAudit(dir, 'host-health.pending.jsonl', proposals.map(p => JSON.stringify(p)).join('\n') + (proposals.length ? '\n' : ''));
  }
  const summary = safeSummary(checks);
  if (args.includes('--details')) console.log(JSON.stringify({ generatedAt, checks }, null, 2));
  else if (args.includes('--json')) console.log(JSON.stringify(summary));
  else console.log(`Host check: ${summary.counts.pass} pass, ${summary.counts.fail} need attention, ${summary.counts.unknown} unknown, ${summary.counts.skipped} skipped.\nDetailed evidence saved privately outside the repository. Use --details only in a private local session.`);
  if (args.includes('--check')) process.exitCode = summary.counts.fail ? 1 : summary.counts.unknown || summary.counts.skipped ? 2 : 0;
} catch {
  console.error('Host audit could not safely read its policy or write private evidence. Check local state/config permissions and --help. No detailed evidence was printed.');
  process.exitCode = 2;
}
