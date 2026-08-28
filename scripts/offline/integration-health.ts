#!/usr/bin/env npx tsx
/**
 * What is actually connected here, and is it current? SCRIPT TIER, no model.
 *
 * Matt, 2026-08-28: "The awareness of currently connected tools/integrations is important...
 * Before usage at some interval it might be nice to check if new version is available, etc."
 *
 * TWO DIFFERENT QUESTIONS, AND CONFUSING THEM IS THE BUG THIS PREVENTS. The catalogue in
 * static/reckons-generation-tools.ttl says what EXISTS in the world. Nothing until now said what
 * exists ON THIS MACHINE — so a task could be composed from tools that are not installed, and the
 * first anyone would know is a command failing in a runner.
 *
 * AND MAINTENANCE HAS BEEN A RECURRING COST, WHICH IS THE OTHER HALF. n8n has needed attention
 * repeatedly in this project; the schedule cron had failed 3,216 times unnoticed. A thing that
 * silently drifts out of date is the same failure shape as a thing that silently stops running,
 * and the answer is the same: ask, on an interval, and say what you found.
 *
 * IT REPORTS UNKNOWN RATHER THAN GUESSING. n8n's public settings endpoint carries no version
 * field and its HTTP headers carry none either — both checked — so the RUNNING version is
 * reported as unknown and the reason is printed. A health check that invents a version number to
 * look complete is worse than one that admits a gap, because the whole point is to be believed
 * when it says something IS wrong.
 *
 * BUT THE RIGHT QUESTION IS NOT "IS THERE A NEWER VERSION", IT IS "DOES THE NEWER ONE MATTER".
 * n8n publishes exactly that at api.n8n.io/api/versions/<from>, which returns every release newer
 * than <from> carrying `hasSecurityIssue`, `hasSecurityFix` and `hasBreakingChange`. A tag number
 * from the GitHub releases API cannot tell you any of those, and they are the only three facts
 * that should ever make somebody upgrade a working instance in a hurry.
 *
 * Usage:
 *   npx tsx scripts/offline/integration-health.ts
 *   npx tsx scripts/offline/integration-health.ts --pending    queue what needs attention
 */
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const CATALOGUE = 'static/reckons-generation-tools.ttl';

export type Health = {
  name: string;
  reachable: boolean | null;
  running?: string;
  latest?: string;
  detail: string;
  /** Needs a human: unreachable, or a known version behind. */
  attention: boolean;
};

function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function reachable(url: string, ms = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Latest published release of a GitHub project, or undefined if it cannot be read. */
export function latestRelease(repo: string): string | undefined {
  try {
    return execFileSync('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

/** Binaries the catalogue's tools would be invoked as, and whether they are on PATH. */
export function localBinaries(): { name: string; present: boolean }[] {
  const bins = ['ffmpeg', 'sd', 'rembg', 'piper', 'ollama', 'blender', 'docker'];
  return bins.map((name) => {
    try {
      execFileSync('command', ['-v', name], { shell: '/bin/bash', stdio: 'ignore' });
      return { name, present: true };
    } catch {
      return { name, present: false };
    }
  });
}

type N8nVersion = {
  name: string;
  createdAt: string;
  hasSecurityIssue: boolean | null;
  hasSecurityFix: boolean | null;
  hasBreakingChange: boolean;
};

/**
 * Releases newer than `from`, with the flags that actually decide an upgrade.
 *
 * `from` defaults deliberately low: without the running version we cannot compute a delta, so the
 * honest fallback is to report the newest release and whether ANY recent one carries a security
 * fix — and to say that is what we are doing.
 */
export async function n8nVersionsSince(from = '2.30.0'): Promise<N8nVersion[]> {
  try {
    const res = await fetch(`https://api.n8n.io/api/versions/${from}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    return (await res.json()) as N8nVersion[];
  } catch {
    return [];
  }
}

async function checkN8n(): Promise<Health> {
  const base = process.env.N8N_API_URL?.replace(/\/+$/, '');
  if (!base) {
    return { name: 'n8n', reachable: null, detail: 'not configured (N8N_API_URL unset)', attention: false };
  }
  const up = await reachable(`${base}/healthz`);
  const versions = await n8nVersionsSince();
  const latest = versions[0]?.name;
  const security = versions.filter((v) => v.hasSecurityFix || v.hasSecurityIssue);
  const breaking = versions.filter((v) => v.hasBreakingChange);

  const notes = [
    up ? 'up' : 'UNREACHABLE',
    `latest ${latest ?? 'unknown'}`,
    'running version NOT READABLE (no version in the public settings endpoint or headers)',
  ];
  if (security.length > 0) notes.push(`\x1b[33m${security.length} release(s) carry SECURITY fixes\x1b[0m`);
  if (breaking.length > 0) notes.push(`${breaking.length} carry breaking changes`);

  return {
    name: 'n8n',
    reachable: up,
    latest,
    detail: notes.join(' · '),
    // Security is the only thing that makes a working instance urgent. A newer tag on its own
    // is not a reason to touch something that works.
    attention: !up || security.length > 0,
  };
}

async function checkOllama(): Promise<Health> {
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) });
    const running = ((await res.json()) as { version?: string }).version;
    const latest = latestRelease('ollama/ollama');
    const behind = running && latest && !latest.includes(running);
    return {
      name: 'ollama',
      reachable: true,
      running,
      latest,
      detail: `running ${running} · latest ${latest ?? 'unknown'}${behind ? '  ← behind' : ''}`,
      attention: Boolean(behind),
    };
  } catch {
    return { name: 'ollama', reachable: false, detail: 'not reachable at ' + base, attention: false };
  }
}

/** Tools the catalogue lists, so the report can say how many of them are actually here. */
export function catalogueSize(file = CATALOGUE): number {
  if (!existsSync(file)) return 0;
  return [...readFileSync(file, 'utf8').matchAll(/kpred:repo-url\s+"/g)].length;
}

async function main(): Promise<void> {
  loadDotEnv();
  const checks = [await checkN8n(), await checkOllama()];

  console.log('\x1b[1mConnected integrations\x1b[0m');
  for (const c of checks) {
    const mark = c.reachable === null ? '\x1b[2m○\x1b[0m' : c.reachable ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
    console.log(`  ${mark} ${c.name.padEnd(10)} ${c.detail}`);
  }

  const bins = localBinaries();
  const here = bins.filter((b) => b.present);
  console.log(`\n\x1b[1mLocal tools on PATH\x1b[0m  ${here.length} of ${bins.length}`);
  console.log('  ' + bins.map((b) => `${b.present ? '\x1b[32m✓\x1b[0m' : '\x1b[2m✗\x1b[0m'} ${b.name}`).join('   '));

  // THE GAP THAT MATTERS: the catalogue is a list of what exists, not of what is usable here.
  console.log(
    `\n\x1b[1mCatalogue\x1b[0m  ${catalogueSize()} tools listed · ${here.length} invokable on this machine right now.`,
  );
  console.log('  A chain composed from tools that are not installed fails in the runner, not at planning time.');

  const attention = checks.filter((c) => c.attention);
  if (attention.length === 0) {
    console.log('\nNothing needs attention.');
  } else {
    console.log(`\n\x1b[33m${attention.length} need(s) attention:\x1b[0m`);
    for (const c of attention) console.log(`  ${c.name}: ${c.detail}`);
  }

  if (PENDING_OUT && attention.length > 0) {
    const rows = attention.map((c) => ({
      subject: `urn:kbase:concept/int-${c.name}`,
      predicate: 'urn:kbase:predicate/known-issue',
      object: `${c.name}: ${c.detail}`,
      objectKind: 'literal',
      kb: 'production',
      type: 'observation',
      priority: c.reachable === false ? 'high' : 'normal',
      agent: 'integration-health',
      note: 'Checked on a schedule. A tool that drifts out of date silently is the same failure shape as one that silently stops running.',
    }));
    appendFileSync(PENDING, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    console.log(`\nQueued ${rows.length} for review.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('integration-health.ts')) {
  main().catch((e) => { console.error('integration-health failed:', e); process.exit(1); });
}
