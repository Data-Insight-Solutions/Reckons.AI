#!/usr/bin/env npx tsx
/**
 * THE OBSERVER — configuration is a CLAIM; log data is EVIDENCE. Script tier, no model.
 *
 * Matt, 2026-09-09: "I think we need an observer, checking configurations, versus log data?"
 *
 * That is the right frame and it is the founding tenet turned on the system itself. A config file
 * is an unverifiable claim made by the party it benefits — the machine asserting that it works.
 * kb:tenet-evidence says such a claim is not evidence. This job goes and finds the evidence.
 *
 * THREE REAL INCIDENTS, ALL THE SAME SHAPE, ALL IN ONE FORTNIGHT:
 *
 *   1. The iOS capture workflow buffered notes into Google Drive. The OAuth client was deleted;
 *      four executions failed on 2026-08-27 and nobody looked. The workflow's own successor note
 *      says it best — "the whole capture path dies with an error no one sees."
 *   2. The hourly schedule had FAILED 3,216 TIMES IN A ROW since the day it was installed, because
 *      the installed crontab line had no `cd` and npm died on the wrong package.json. The schedule
 *      still displayed a healthy future run time throughout.
 *   3. The MCP capture tool returns 404 when its target webhook is missing AND REPORTS SUCCESS TO
 *      THE PHONE anyway.
 *
 * WHICH IS WHY THIS CANNOT READ STATUSES. Every one of those had a `success` somewhere: n8n
 * reported success while the phone got nothing, cron reported a future run while producing
 * nothing. A status is the configuration talking about itself. The only evidence that a stage
 * worked is that THE NEXT STAGE RECEIVED SOMETHING — so the checks below cross a boundary
 * wherever they can, and say UNCHECKABLE where they cannot.
 *
 * IT NEVER REPORTS FINE WHEN IT COULD NOT LOOK. Without n8n credentials the integration checks are
 * UNCHECKABLE, not passing — the same rule integration-health.ts already follows for a version it
 * cannot read. A monitor that goes quiet when blindfolded teaches you to ignore it.
 *
 * Usage: npx tsx scripts/offline/config-observer.ts [--quiet] [--stale-days=14]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const PENDING = join(ROOT, 'reckons-workspace', 'knowledge.pending.jsonl');
const MCP_CONFIG = join(ROOT, '.mcp.json');
const CRON_LOG = join(ROOT, 'reckons-workspace', 'schedule-cron.log');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const STALE_DAYS = Number.parseInt(argv.find((a) => a.startsWith('--stale-days='))?.split('=')[1] ?? '14', 10);

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

type Level = 'ok' | 'warn' | 'fail' | 'unchecked';
interface Finding { level: Level; check: string; claim: string; evidence: string }
const findings: Finding[] = [];
const add = (level: Level, check: string, claim: string, evidence: string) =>
  findings.push({ level, check, claim, evidence });

/** Read a var out of .env without exporting it into the log. */
function envVar(name: string): string {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return '';
  const m = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(f, 'utf8'));
  return m ? m[1].trim() : '';
}

function n8nGet<T>(path: string): T | null {
  const base = envVar('N8N_API_URL');
  const key = envVar('N8N_API_KEY');
  if (!base || !key) return null;
  try {
    const out = execFileSync('curl', [
      '-s', '--max-time', '25', '-H', `X-N8N-API-KEY: ${key}`, `${base}${path}`,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(out) as T;
  } catch { return null; }
}

interface Wf { id: string; name: string; active: boolean; nodes?: Array<{ name: string; type: string; parameters?: Record<string, unknown> }> }
interface Ex { id: number; workflowId: string; status: string; startedAt: string }

// ── n8n: does what is configured actually happen? ────────────────────────────

function checkN8n(): void {
  const wfRes = n8nGet<{ data: Wf[] }>('/api/v1/workflows?limit=100');
  if (!wfRes?.data) {
    add('unchecked', 'n8n', 'workflows are configured and running',
      'no N8N_API_URL/N8N_API_KEY readable from .env, or the instance did not answer — NOT the same as healthy');
    return;
  }
  const workflows = wfRes.data;
  const exRes = n8nGet<{ data: Ex[] }>('/api/v1/executions?limit=250');
  const executions = exRes?.data ?? [];
  const lastRun = new Map<string, string>();
  for (const e of executions) {
    const prev = lastRun.get(e.workflowId);
    if (!prev || e.startedAt > prev) lastRun.set(e.workflowId, e.startedAt);
  }

  const active = workflows.filter((w) => w.active);
  const now = Date.now();

  /*
   * ACTIVE BUT SILENT. `active: true` is the configuration claiming this workflow runs. An
   * execution is the only evidence that it does. A workflow can be active, correctly configured,
   * and never fire for weeks because whatever was meant to call it has moved on.
   */
  for (const w of active) {
    const last = lastRun.get(w.id);
    if (!last) {
      add('warn', 'active but silent', `${w.name} is active`,
        `no execution in the last ${executions.length} recorded — it may simply be rarely triggered, but nothing proves it works`);
      continue;
    }
    const days = (now - Date.parse(last)) / 86_400_000;
    if (days > STALE_DAYS) {
      add('warn', 'active but silent', `${w.name} is active`,
        `last ran ${days.toFixed(0)} day(s) ago (${last.slice(0, 10)})`);
    }
  }

  /*
   * WEBHOOK PATH COLLISION. n8n registers a path only for ACTIVE workflows, so a duplicate held by
   * a deactivated one is not a live fault — it is a loaded gun. Activating the old workflow would
   * silently contend for a path the live one serves. Found on 2026-09-09: two workflows both
   * declare `reckons-note`, and the retired Drive-based one is still one toggle from returning.
   */
  const byPath = new Map<string, Wf[]>();
  for (const w of workflows) {
    for (const n of w.nodes ?? []) {
      const p = (n.parameters as { path?: string } | undefined)?.path;
      if (!p || !n.type.toLowerCase().includes('webhook')) continue;
      byPath.set(p, [...(byPath.get(p) ?? []), w]);
    }
  }
  for (const [path, ws] of byPath) {
    if (ws.length < 2) continue;
    const live = ws.filter((w) => w.active);
    const dormant = ws.filter((w) => !w.active);
    if (live.length > 1) {
      add('fail', 'webhook collision', `${live.length} ACTIVE workflows declare /${path}`,
        `${live.map((w) => w.name).join(' + ')} — only one can serve it and which one is not deterministic`);
    } else if (dormant.length > 0 && live.length === 1) {
      add('warn', 'webhook collision', `/${path} is served by ${live[0].name}`,
        `${dormant.map((w) => w.name).join(', ')} also declare(s) it while inactive — activating one would contend for the path`);
    }
  }

  /*
   * INSTRUCTIONS THAT NAME A DEAD WORKFLOW. A sticky note is documentation living inside the
   * config, and it rots exactly like any other documentation — except that following it changes a
   * production system. The MCP capture workflow still tells a reader to deploy the Drive-based
   * workflow FIRST, which is retired.
   */
  const nameOf = new Map(workflows.map((w) => [w.name, w] as const));
  for (const w of workflows) {
    for (const n of w.nodes ?? []) {
      if (!n.type.toLowerCase().includes('sticky')) continue;
      const content = String((n.parameters as { content?: string } | undefined)?.content ?? '');
      for (const [name, target] of nameOf) {
        if (name === w.name || !content.includes(name)) continue;
        if (!target.active) {
          add('warn', 'stale instructions', `${w.name} documentation names "${name}"`,
            `that workflow is INACTIVE — following the instruction would revive a retired path`);
        }
      }
    }
  }

  /*
   * THE END-TO-END CHECK, and the only one that proves anything. A capture execution reporting
   * success says the webhook answered. It does NOT say a note reached the graph. The evidence for
   * that is a row in the pending queue whose subject carries the same capture timestamp.
   */
  /*
   * ONLY THE WORKFLOW THAT WRITES THE NOTE COUNTS, and getting this wrong produced a FALSE FAIL on
   * the first run. Two active workflows match /capture/: the webhook one that buffers the row, and
   * the MCP trigger that merely calls it. The MCP execution starts a second later, so matching its
   * timestamp against the subject minted by the webhook reported a capture that had in fact
   * arrived. A monitor that cries wolf gets switched off, and then it protects nothing — so the
   * producer is identified by having a WEBHOOK NODE, not by its name.
   */
  const captureWfIds = workflows
    .filter((w) => w.active && /capture/i.test(w.name)
      && (w.nodes ?? []).some((n) => n.type.toLowerCase().includes('webhook')
        && !n.type.toLowerCase().includes('respond')))
    .map((w) => w.id);
  const captures = executions.filter((e) => captureWfIds.includes(e.workflowId) && e.status === 'success');
  if (captures.length === 0) {
    add('unchecked', 'capture end-to-end', 'notes dictated to the ring reach the graph',
      'no successful capture executions in the recent window to check against');
  } else if (!existsSync(PENDING)) {
    add('fail', 'capture end-to-end', 'notes dictated to the ring reach the graph',
      'the pending queue does not exist, so nothing captured could have arrived');
  } else {
    const queue = readFileSync(PENDING, 'utf8');
    const missing = captures.filter((e) => {
      // Subjects are minted as note-<ISO with : and . replaced by ->, from the capture instant.
      const stamp = e.startedAt.slice(0, 19).replace(/[:.]/g, '-');
      return !queue.includes(`note-${stamp}`);
    });
    if (missing.length === 0) {
      add('ok', 'capture end-to-end', `${captures.length} capture(s) succeeded`,
        `all ${captures.length} reached knowledge.pending.jsonl — execution AND arrival, not status alone`);
    } else {
      add('fail', 'capture end-to-end', `${captures.length} capture(s) reported success`,
        `${missing.length} never reached the pending queue: ${missing.map((m) => m.startedAt.slice(0, 16)).join(', ')}`);
    }
  }
}

// ── MCP: is every declared server actually resolvable? ───────────────────────

function checkMcp(): void {
  if (!existsSync(MCP_CONFIG)) return;
  let cfg: { mcpServers?: Record<string, { url?: string; command?: string; env?: Record<string, string> }> };
  try { cfg = JSON.parse(readFileSync(MCP_CONFIG, 'utf8')); } catch {
    add('fail', 'mcp config', '.mcp.json is valid JSON', 'it does not parse');
    return;
  }
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    const refs = [server.url ?? '', ...Object.values(server.env ?? {})].join(' ');
    const vars = [...refs.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
    const unset = vars.filter((v) => !process.env[v] && !envVar(v));
    if (unset.length > 0) {
      add('fail', 'mcp config', `${name} is declared and expected to connect`,
        `${unset.join(', ')} unset in this environment — the client sees the literal \${...} and refuses`);
    }
    /*
     * The one that actually bit: the variable EXISTS in .env but the MCP client does not read
     * .env, so the value is present to every script here and absent to the client. Reporting
     * "it is set" from a shell that sourced .env would be exactly the wrong answer.
     */
    const inEnvOnly = vars.filter((v) => !process.env[v] && envVar(v));
    if (inEnvOnly.length > 0) {
      add('warn', 'mcp config', `${name} resolves \${${inEnvOnly.join('}, ${')}}`,
        'present in .env but NOT exported to the process — scripts that source .env will work and the MCP client will not');
    }
  }
}

// ── cron: the schedule claims to run; does the log agree? ────────────────────

function checkCron(): void {
  let crontab = '';
  try { crontab = execFileSync('crontab', ['-l'], { encoding: 'utf8' }); } catch { crontab = ''; }
  const entry = crontab.split('\n').find((l) => l.includes('reckons-schedule'));
  if (!entry) {
    add('unchecked', 'schedule', 'a cron entry pulls notes on an interval',
      'no reckons-schedule line in crontab — either deliberately absent or wiped, and this cannot tell which');
    return;
  }
  if (!/\bcd\s+\S/.test(entry)) {
    add('fail', 'schedule', 'the cron entry runs the scheduler',
      'the line has no `cd` into the repo — this is the exact fault that failed 3,216 times in a row');
  }
  if (!existsSync(CRON_LOG)) {
    add('warn', 'schedule', 'the cron entry is installed and logging',
      'the log file does not exist, so nothing proves the schedule has ever run');
    return;
  }
  const ageH = (Date.now() - statSync(CRON_LOG).mtimeMs) / 3_600_000;
  const tail = readFileSync(CRON_LOG, 'utf8').split('\n').slice(-40).join('\n');
  const errs = (tail.match(/npm ERR!|Error:|ENOENT/g) ?? []).length;
  if (ageH > 2) {
    add('fail', 'schedule', `cron says every 15 minutes`,
      `the log has not been written for ${ageH.toFixed(1)}h — it is firing on paper only`);
  } else if (errs > 0) {
    add('fail', 'schedule', 'the schedule runs successfully',
      `${errs} error line(s) in the last 40 lines of schedule-cron.log`);
  } else {
    add('ok', 'schedule', 'cron runs the scheduler every 15 minutes',
      `log written ${ageH < 1 ? 'within the hour' : `${ageH.toFixed(1)}h ago`}, no errors in the recent tail`);
  }
}

function main(): void {
  checkN8n();
  checkMcp();
  checkCron();

  const order: Level[] = ['fail', 'warn', 'unchecked', 'ok'];
  const label: Record<Level, string> = {
    fail: C.red('FAIL'), warn: C.yellow('WARN'), unchecked: C.dim('????'), ok: C.green(' OK '),
  };

  console.log('');
  console.log(C.bold('observer') + C.dim(' — what the configuration claims, against what the logs show'));
  console.log('');
  for (const level of order) {
    const rows = findings.filter((f) => f.level === level);
    if (rows.length === 0 || (QUIET && level === 'ok')) continue;
    for (const f of rows) {
      console.log(`  ${label[level]}  ${C.cyan(f.check)}`);
      console.log(C.dim(`         claims:   ${f.claim}`));
      console.log(C.dim(`         evidence: ${f.evidence}`));
    }
    console.log('');
  }

  const n = (l: Level) => findings.filter((f) => f.level === l).length;
  console.log(`  ${C.red(`${n('fail')} contradicted`)} · ${C.yellow(`${n('warn')} unproven`)} · ${n('unchecked')} uncheckable · ${C.green(`${n('ok')} substantiated`)}`);
  console.log(C.dim('  A status is the configuration talking about itself. Only the next stage receiving'));
  console.log(C.dim('  something is evidence — so "uncheckable" is reported rather than counted as fine.'));
}

if (process.argv[1] && process.argv[1].endsWith('config-observer.ts')) main();
