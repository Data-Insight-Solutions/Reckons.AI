/**
 * Self-hosted server health — script tier, zero tokens.
 *
 * Reckons.AI is local-first, but two self-hosted servers are now load-bearing for real features:
 * the Indico instance that feeds calendar ingest (kb:int-indico) and the n8n instance that runs
 * the contact/feedback webhook and the Currents monitor (kb:n8n-cloud-sync). Nothing was watching
 * either of them. Both drifted in ways nobody noticed until a human went looking:
 *
 *   - Indico blocked every browser request for its entire life because it sent no CORS header,
 *     while a Node-based verifier reported 6/6 green (2026-07-31).
 *   - The n8n host ran 92 days with two kernel security updates installed and never booted, and
 *     with NO backup of the volume holding every workflow and credential.
 *
 * Both are exactly what F74.3 calls script tier: the answer is checkable by a rule, so it costs
 * nothing and cannot hallucinate. Findings become pending graph entries for human review — this
 * job NEVER changes a server.
 *
 * Two classes of check:
 *   PUBLIC — needs only network access, so it runs anywhere including CI.
 *   REMOTE — needs the ssh aliases (`indico`, `n8n`) from ~/.ssh/config. SKIPPED, not failed,
 *            when they are absent, because most checkouts have no business holding server keys.
 *
 * Usage:
 *   npx tsx scripts/offline/server-health.ts             report
 *   npx tsx scripts/offline/server-health.ts --pending   queue findings for review
 *   npx tsx scripts/offline/server-health.ts --json      machine-readable
 */
import { existsSync, appendFileSync, readFileSync } from 'fs';
import { queueFindings } from './pending-queue.ts';
import { execFileSync } from 'child_process';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const KPRED = 'urn:kbase:predicate/';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const JSON_OUT = argv.includes('--json');

const B = '\x1b[1m', D = '\x1b[2m', Y = '\x1b[33m', G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';

type Level = 'ok' | 'warn' | 'error' | 'skip';
interface Finding { host: string; check: string; level: Level; msg: string }
const findings: Finding[] = [];
const add = (host: string, check: string, level: Level, msg: string) =>
  findings.push({ host, check, level, msg });

/** Run a command, returning null instead of throwing — an unreachable host is a skip, not a crash. */
function run(cmd: string, args: string[], timeoutMs = 25_000): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Is an ssh alias configured AND reachable? Anything else means skip. */
function sshReady(alias: string): boolean {
  const cfg = `${process.env.HOME}/.ssh/config`;
  if (!existsSync(cfg)) return false;
  if (!new RegExp(`^Host\\s+${alias}\\s*$`, 'm').test(readFileSync(cfg, 'utf8'))) return false;
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, 'true'], 15_000) !== null;
}

const ssh = (alias: string, script: string) =>
  run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, script], 40_000);

// ── PUBLIC: the Indico CORS grant ────────────────────────────────────────────
// This is the check that would have caught the original bug, and it needs no credentials.
// A browser cannot read Indico without this header no matter how healthy the API is.
function checkIndicoCors() {
  const url = process.env.INDICO_URL ?? 'https://indico.data-insight.website';
  const origin = process.env.RECKONS_ORIGIN ?? 'https://reckons.ai';
  const out = run('curl', [
    '-s', '-o', '/dev/null', '-D', '-', '--max-time', '20',
    '-H', `Origin: ${origin}`, `${url}/export/categ/0.json?pretty=yes`,
  ]);
  if (out === null) return add('indico', 'reachable', 'error', `${url} did not respond`);

  const status = /^HTTP\/[\d.]+ (\d{3})/m.exec(out)?.[1];
  if (status !== '200') return add('indico', 'export-api', 'error', `export API returned HTTP ${status ?? '?'}`);

  const acao = /^access-control-allow-origin:\s*(.+)$/im.exec(out)?.[1]?.trim();
  if (!acao) {
    add('indico', 'cors', 'error',
      `no Access-Control-Allow-Origin for ${origin} — the browser will discard every response, ` +
      `so calendar ingest is broken even though the API answers 200. Restore the nginx grant.`);
  } else if (acao !== origin && acao !== '*') {
    add('indico', 'cors', 'warn', `ACAO is "${acao}", expected "${origin}"`);
  } else if (acao === '*') {
    // A wildcard would let any site read whatever a caller's bearer token grants.
    add('indico', 'cors', 'warn', 'ACAO is "*" — should echo only known origins, never a wildcard');
  } else {
    add('indico', 'cors', 'ok', `grants ${origin}`);
  }

  // A wrong origin must NOT be echoed; a permissive map is a silent data-exposure change.
  const evil = run('curl', [
    '-s', '-o', '/dev/null', '-D', '-', '--max-time', '20',
    '-H', 'Origin: https://not-allowed.example.com', `${url}/export/categ/0.json`,
  ]);
  if (evil && /^access-control-allow-origin:/im.test(evil)) {
    add('indico', 'cors-scope', 'error', 'an UNKNOWN origin was granted CORS — the allow-list is too permissive');
  }
}

// ── REMOTE: Indico host ──────────────────────────────────────────────────────
function checkIndicoHost() {
  if (!sshReady('indico')) return add('indico', 'ssh', 'skip', 'no reachable `indico` ssh alias — remote checks skipped');
  const out = ssh('indico', `
    printf 'VERSION=%s\\n' "$(sudo -u indico bash -lc 'source /opt/indico/.venv/bin/activate && indico --version' 2>/dev/null | tr -d '\\r')"
    printf 'DISK=%s\\n' "$(df --output=pcent / | tail -1 | tr -dc '0-9')"
    printf 'REBOOT=%s\\n' "$([ -f /var/run/reboot-required ] && echo yes || echo no)"
    for s in indico-celery nginx postgresql; do printf 'SVC_%s=%s\\n' "$s" "$(systemctl is-active $s 2>/dev/null)"; done
  `);
  if (!out) return add('indico', 'ssh', 'skip', 'remote command failed');
  parseHostFacts('indico', out);
}

// ── REMOTE: n8n host ─────────────────────────────────────────────────────────
function checkN8nHost() {
  if (!sshReady('n8n')) return add('n8n', 'ssh', 'skip', 'no reachable `n8n` ssh alias — remote checks skipped');
  const out = ssh('n8n', `
    printf 'DISK=%s\\n' "$(df --output=pcent / | tail -1 | tr -dc '0-9')"
    printf 'REBOOT=%s\\n' "$([ -f /var/run/reboot-required ] && echo yes || echo no)"
    printf 'KCUR=%s\\n' "$(uname -r)"
    printf 'KEXP=%s\\n' "$(needrestart -b 2>/dev/null | sed -n 's/^NEEDRESTART-KEXP: //p')"
    printf 'CONTAINERS=%s\\n' "$(docker ps --format '{{.Names}}' 2>/dev/null | tr '\\n' ',')"
    printf 'BACKUP_AGE_DAYS=%s\\n' "$(f=$(ls -1t /var/backups/n8n/n8n-*.tar.gz 2>/dev/null | head -1); [ -n "$f" ] && echo $(( ( $(date +%s) - $(stat -c %Y "$f") ) / 86400 )) || echo none)"
    printf 'BACKUP_BYTES=%s\\n' "$(f=$(ls -1t /var/backups/n8n/n8n-*.tar.gz 2>/dev/null | head -1); [ -n "$f" ] && stat -c %s "$f" || echo 0)"
  `);
  if (!out) return add('n8n', 'ssh', 'skip', 'remote command failed');
  parseHostFacts('n8n', out);

  const f = Object.fromEntries(out.split('\n').map((l) => l.split('=') as [string, string]));

  // The gap that mattered most: workflows and credentials with no recoverable copy.
  if (f.BACKUP_AGE_DAYS === 'none') {
    add('n8n', 'backup', 'error', 'NO backup archive found — every workflow and credential is unrecoverable if the volume is lost');
  } else if (Number(f.BACKUP_AGE_DAYS) > 8) {
    add('n8n', 'backup', 'error', `newest backup is ${f.BACKUP_AGE_DAYS} days old — the weekly job is not running`);
  } else if (Number(f.BACKUP_BYTES) < 100_000) {
    // A tiny archive is worse than none: it invites confidence that is not warranted.
    add('n8n', 'backup', 'error', `newest backup is only ${f.BACKUP_BYTES} bytes — implausible, treat as failed`);
  } else {
    add('n8n', 'backup', 'ok', `${f.BACKUP_AGE_DAYS}d old, ${(Number(f.BACKUP_BYTES) / 1e6).toFixed(1)} MB`);
  }

  if (f.CONTAINERS !== undefined) {
    const names = f.CONTAINERS.split(',').filter(Boolean);
    for (const want of ['n8n', 'traefik']) {
      if (!names.some((n) => n.includes(want))) add('n8n', 'containers', 'error', `no running container matching "${want}"`);
    }
    if (names.length) add('n8n', 'containers', 'ok', names.join(', '));
  }

  // Installed-but-not-booted kernels are the shape of security theatre: the log stays green
  // while the fix is inert.
  if (f.KCUR && f.KEXP && f.KCUR !== f.KEXP) {
    add('n8n', 'kernel', 'error',
      `running ${f.KCUR} but ${f.KEXP} is installed — security updates are applied and NOT in effect; needs a reboot window`);
  }
}

function parseHostFacts(host: string, out: string) {
  const f = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split('=') as [string, string]));
  if (f.VERSION) add(host, 'version', 'ok', f.VERSION);
  if (f.DISK) {
    const pct = Number(f.DISK);
    if (pct >= 90) add(host, 'disk', 'error', `root filesystem ${pct}% full`);
    else if (pct >= 80) add(host, 'disk', 'warn', `root filesystem ${pct}% full`);
    else add(host, 'disk', 'ok', `${pct}% used`);
  }
  if (f.REBOOT === 'yes') add(host, 'reboot', 'warn', 'reboot required (pending kernel/library updates)');
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('SVC_') && v && v !== 'active') add(host, 'service', 'error', `${k.slice(4)} is ${v}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
checkIndicoCors();
checkIndicoHost();
checkN8nHost();

const problems = findings.filter((f) => f.level === 'error' || f.level === 'warn');

if (JSON_OUT) {
  console.log(JSON.stringify({ findings, problems: problems.length }, null, 2));
} else {
  console.log(`\n${B}self-hosted server health${X}\n`);
  for (const host of [...new Set(findings.map((f) => f.host))]) {
    console.log(`${B}${host}${X}`);
    for (const f of findings.filter((x) => x.host === host)) {
      const c = f.level === 'ok' ? G : f.level === 'warn' ? Y : f.level === 'skip' ? D : R;
      const m = f.level === 'ok' ? '✓' : f.level === 'warn' ? '!' : f.level === 'skip' ? '–' : '✗';
      console.log(`  ${c}${m}${X} ${D}${f.check}${X} ${f.msg}`);
    }
    console.log('');
  }
  const skipped = findings.filter((f) => f.level === 'skip').length;
  console.log(problems.length === 0
    ? `${G}no problems${X}${skipped ? ` ${D}(${skipped} check group(s) skipped — no ssh access here)${X}` : ''}`
    : `${R}${problems.length} problem(s)${X}`);
}

if (PENDING_OUT && problems.length) {
  // Recomputing: each run probes every server, so a host that has come back up should drop out of
  // the queue instead of sitting there implying it is still down.
  const { queued, superseded } = queueFindings(
    problems.map((f) => ({
      subject: f.host === 'n8n' ? 'urn:kbase:concept/n8n-cloud-sync' : 'urn:kbase:concept/int-indico',
      predicate: `${KPRED}server-health`,
      // The probe already ran and already knows the condition — filing it as an object-less
      // question asked a human to answer something the script was holding the answer to.
      object: `${f.host}: ${f.check}`,
      note: `[server-health/${f.host}/${f.check}] ${f.msg}`,
      // DEFECT, not drift: the graph's claim about these servers is correct — the world is
      // what is broken, so the fix lands in the infrastructure and never in the graph.
      findingClass: 'defect',
      type: 'drift-warning' as const,
      priority: f.level === 'error' ? ('high' as const) : ('medium' as const),
    })),
    { agent: 'offline:server-health', path: PENDING, recomputes: true },
  );
  console.log(`${queued} finding(s) queued${superseded ? `, ${superseded} recovered since last run` : ''} → ${PENDING}`);
}

// Deliberately exit 0 on findings: this reports drift for a human, it does not gate CI.
// A self-hosted server being briefly unreachable must never fail the build.
process.exit(0);
