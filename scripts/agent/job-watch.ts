/**
 * JOB WATCH — hand the reading of a long job's log to a LOCAL model, and get TTL back (F89, F74.3).
 *
 * WHY. The orchestrating Opus session was spending its budget reading logs of CI waits, merge-queue
 * runs, e2e and offline:all. Matt, 2026-09-30: "we are likely underestimating and underutilizing LLMs
 * to watch script type processes and report back with TTL results." Reading a log is judgment over
 * language where a wrong answer is cheap IF the output is validated, so it belongs to the agent tier.
 *
 *   ground    SCRIPT FIRST: exit code, duration and pass/fail lines are extracted by rules. The model
 *             sees only the tail of the log plus those lines, never the whole thing.
 *   prompt    one question and a fixed JSON schema (Ollama constrains decoding to it).
 *   validate  every evidence_line must appear verbatim in the log or the finding is dropped; the
 *             status may never contradict the exit code (exit != 0 is never "passed").
 *   emit      one JobRun entity appended to reckons-workspace/kbs/jobs/job-runs.ttl in the MAIN
 *             checkout, and one stdout line. It writes nothing else.
 *
 * (The file is job-runs.ttl, not jobs.ttl: kbs/jobs/jobs.ttl is a symlink to the GENERATED, tracked
 * static/reckons-jobs.ttl, and appending to it would edit a generated file.)
 *
 * WEAKNESS, said out loud: the validator proves a finding quotes a real log line, not that the
 * model drew the right conclusion from it. Exit code and extracted counts are the facts; the
 * headline and findings are a local model's reading. If Ollama is down the run is reported with
 * script facts only and says so. It never falls back to a cloud model.
 *
 * Usage: npx tsx scripts/agent/job-watch.ts --name=<job> [--model=qwen3.6:latest] -- <command…>
 * The command is run with argv (no shell), so nothing in it is interpolated.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_PER_HOUR, breakerDecision, failureSignature, openCircuits, readRuns,
  runsTtlPath, setCircuitCache, stateDir, updateCurrent,
} from './job-state.js';

export { stateDir, runsTtlPath };

export type Status = 'passed' | 'failed' | 'partial' | 'refused' | 'reset';
export type Finding = { kind: string; text: string; evidence_line: string };
export type Verdict = { status: Status; headline: string; findings: Finding[] };
export type Facts = { exitCode: number; durationMs: number; lines: string[]; counts: Record<string, number> };

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** Patterns that make a log line worth showing the model. */
const SIGNAL = [
  /\bTests?\s+(\d+\s+failed\s*\|\s*)?\d+\s+(passed|failed)/i, // vitest
  /\bTest Files\s+\d+/i,
  /^\s*\d+\s+(passed|failed|skipped|flaky)\b/i, // playwright summary
  /[✓✗✔✘×]/,
  /\b(error|failed|failing|fatal|refus\w*|timed out|timeout)\b/i,
  /\b(MERGED|STOP|REFUSE)\b/,
  /\bFAIL\b/,
];

/** Deterministic extraction — zero tokens, right by construction. */
export function extractFacts(rawLog: string, exitCode: number, durationMs: number, maxLines = 40): Facts {
  const all = stripAnsi(rawLog).split('\n');
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const l of all) {
    const t = l.trim();
    if (!t || seen.has(t)) continue;
    if (SIGNAL.some((re) => re.test(t))) {
      seen.add(t);
      lines.push(t.slice(0, 300));
    }
  }
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  for (const l of all) {
    const v = /\bTests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i.exec(l);
    if (v) { counts.testsFailed = Number(v[1] ?? 0); counts.testsPassed = Number(v[2]); }
    const p = /^\s*(\d+)\s+(passed|failed|skipped|flaky)\b/i.exec(l);
    if (p) bump(`pw_${p[2].toLowerCase()}`, Number(p[1]));
    if (/\bMERGED\b/.test(l)) bump('merged');
    if (/\bSTOP\b/.test(l)) bump('stop');
    if (/\bREFUSE/.test(l)) bump('refuse');
    if (/\berror\b/i.test(l)) bump('errorLines');
    if (/[✓✔]/.test(l)) bump('ticks');
    if (/[✗✘×]/.test(l)) bump('crosses');
  }
  // Too many: keep the first few and the last ones; failures tend to come late.
  const kept = lines.length > maxLines ? [...lines.slice(0, 10), ...lines.slice(-(maxLines - 10))] : lines;
  return { exitCode, durationMs, lines: kept, counts };
}

export function tailOf(rawLog: string, n = 60): string[] {
  return stripAnsi(rawLog).split('\n').filter((l) => l.trim()).slice(-n).map((l) => l.slice(0, 300));
}

export const VERDICT_SCHEMA = {
  type: 'object',
  required: ['status', 'headline', 'findings'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'partial'] },
    headline: { type: 'string', maxLength: 120 },
    findings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['kind', 'text', 'evidence_line'],
        properties: {
          kind: { type: 'string', enum: ['failure', 'warning', 'summary', 'timing', 'other'] },
          text: { type: 'string', maxLength: 200 },
          evidence_line: { type: 'string' },
        },
      },
    },
  },
} as const;

export function buildPrompt(name: string, facts: Facts, tail: string[]): string {
  return [
    `Job "${name}" finished. Report what happened, using ONLY the material below.`,
    `Exit code: ${facts.exitCode}. Duration: ${(facts.durationMs / 1000).toFixed(1)}s.`,
    `Counts (script-extracted): ${JSON.stringify(facts.counts)}`,
    '', 'Lines matched by rules:', ...facts.lines.map((l) => `> ${l}`),
    '', 'Last lines of the log:', ...tail.map((l) => `| ${l}`),
    '',
    'Reply as JSON: status (passed|failed|partial), headline (<=120 chars), findings (<=8) each with kind, text (<=200 chars) and evidence_line.',
    'evidence_line MUST be copied verbatim, character for character, from a line above (without the leading "> " or "| "). If you cannot quote a line, omit the finding.',
    'A non-zero exit code is never "passed". Do not invent causes the lines do not show.',
  ].join('\n');
}

/** Validate a model's raw answer against the log and the exit code. Pure. */
export function validateVerdict(raw: unknown, log: string, exitCode: number): { verdict: Verdict; notes: string[] } {
  const notes: string[] = [];
  const strippedLog = stripAnsi(log);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let status: Status = o.status === 'passed' || o.status === 'failed' || o.status === 'partial' ? o.status : exitCode === 0 ? 'passed' : 'failed';
  if (o.status !== status) notes.push('status missing or invalid; derived from exit code');
  if (exitCode !== 0 && status === 'passed') { status = 'failed'; notes.push(`model said passed on exit ${exitCode}; corrected to failed`); }
  if (exitCode === 0 && status === 'failed') { status = 'partial'; notes.push('model said failed on exit 0; downgraded to partial'); }
  let headline = typeof o.headline === 'string' ? o.headline.trim().replace(/\s+/g, ' ') : '';
  if (!headline) headline = exitCode === 0 ? 'exit 0 (no model headline)' : `exit ${exitCode} (no model headline)`;
  if (headline.length > 120) headline = headline.slice(0, 119) + '…';
  const findings: Finding[] = [];
  for (const f of Array.isArray(o.findings) ? o.findings : []) {
    const r = (f ?? {}) as Record<string, unknown>;
    if (typeof r.kind !== 'string' || typeof r.text !== 'string' || typeof r.evidence_line !== 'string') { notes.push('dropped malformed finding'); continue; }
    const ev = r.evidence_line.trim();
    if (ev.length < 3 || !strippedLog.includes(ev)) { notes.push(`dropped finding with unverifiable evidence: ${ev.slice(0, 60)}`); continue; }
    if (findings.length >= 8) break;
    findings.push({ kind: r.kind.slice(0, 40), text: r.text.trim().slice(0, 200), evidence_line: ev.slice(0, 300) });
  }
  return { verdict: { status, headline, findings }, notes };
}

const lit = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';

export const TTL_PREFIXES = [
  '@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix xsd:    <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix ktype:  <urn:kbase:type/> .',
  '@prefix kpred:  <urn:kbase:predicate/> .',
  '@prefix jobrun: <urn:reckons:jobrun/> .',
].join('\n');

export type RunRecord = {
  name: string; startedAt: Date; endedAt: Date; exitCode: number; logPath: string;
  verdict: Verdict; modelUsed?: string; modelNote?: string; attempt?: number; signature?: string;
};

export function runEntityId(name: string, startedAt: Date): string {
  return `jobrun:${slug(name)}-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

/** One run = one entity. Returns a TTL block WITHOUT prefixes (the file carries them once). */
export function runToTurtle(r: RunRecord): string {
  const id = runEntityId(r.name, r.startedAt);
  const p = [
    `rdf:type ktype:JobRun`,
    `rdfs:label ${lit(`${r.name} — ${r.verdict.status} (${r.startedAt.toISOString()})`)}`,
    `kpred:has-status ${lit(r.verdict.status)}`,
    `kpred:job-name ${lit(r.name)}`,
    `kpred:started ${lit(r.startedAt.toISOString())}^^xsd:dateTime`,
    `kpred:ended ${lit(r.endedAt.toISOString())}^^xsd:dateTime`,
    `kpred:exit-code ${Math.trunc(r.exitCode)}`,
    `kpred:headline ${lit(r.verdict.headline)}`,
    `kpred:log-path ${lit(r.logPath)}`,
    `kpred:read-by ${lit(r.modelUsed ? `local model ${r.modelUsed}` : 'script rules only (no local model)')}`,
  ];
  if (r.attempt !== undefined) p.push(`kpred:attempt ${Math.trunc(r.attempt)}`);
  if (r.signature) p.push(`kpred:failure-signature ${lit(r.signature)}`);
  if (r.modelNote) p.push(`kpred:note ${lit(r.modelNote)}`);
  for (const f of r.verdict.findings) p.push(`kpred:finding ${lit(`${f.kind}: ${f.text} [log: ${f.evidence_line}]`)}`);
  return `${id}\n    ${p.join(' ;\n    ')} .\n`;
}

export function appendRun(ttlPath: string, r: RunRecord): void {
  mkdirSync(path.dirname(ttlPath), { recursive: true });
  if (!existsSync(ttlPath)) {
    writeFileSync(ttlPath, `${TTL_PREFIXES}\n\n# Appended by scripts/agent/job-watch.ts — one JobRun entity per watched run.\n<urn:reckons:kb> <urn:reckons:meta/kbStableId> ${lit(randomUUID())} .\n`);
  }
  appendFileSync(ttlPath, '\n' + runToTurtle(r));
}


export async function askModel(base: string, model: string, prompt: string): Promise<unknown> {
  const call = async (think: boolean) => fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, ...(think ? { think: false } : {}), format: VERDICT_SCHEMA,
      messages: [
        { role: 'system', content: 'You read the output of a finished script and report it as JSON. You quote log lines exactly and never invent.' },
        { role: 'user', content: prompt },
      ],
      options: { num_ctx: 8192, num_predict: 900, temperature: 0, seed: 1 },
    }),
  });
  let res = await call(true);
  if (!res.ok) { const b = await res.text(); if (/think/i.test(b)) res = await call(false); else throw new Error(`Ollama ${res.status}: ${b.slice(0, 160)}`); }
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const text = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
  return JSON.parse(text);
}

let activeChild: ReturnType<typeof spawn> | undefined;

function run(argv: string[], logPath: string): Promise<{ exitCode: number; durationMs: number }> {
  return new Promise((resolve) => {
    const out = createWriteStream(logPath);
    const t0 = Date.now();
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    let finished = false;
    const done = (code: number) => {
      if (finished) return;
      finished = true;
      out.end(() => resolve({ exitCode: code, durationMs: Date.now() - t0 }));
    };
    child.on('error', (e) => { out.write(`job-watch: could not start ${argv[0]}: ${e.message}\n`); done(127); });
    child.on('close', (code, sig) => done(code ?? (sig ? 128 : 1)));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sep = args.indexOf('--');
  const flags = sep < 0 ? args : args.slice(0, sep);
  const cmd = sep < 0 ? [] : args.slice(sep + 1);
  const flag = (k: string) => flags.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const name = flag('name');
  const reset = flags.includes('--reset');
  if (!name || (!cmd.length && !reset)) { console.error('Usage: npx tsx scripts/agent/job-watch.ts --name=<job> [--model=qwen3.6:latest] [--max-attempts=3] [--max-per-hour=6] [--reset] -- <command…>'); process.exit(2); }
  const num = (k: string, d: number) => { const v = Number(flag(k)); return Number.isFinite(v) && v > 0 ? Math.trunc(v) : d; };
  const maxAttempts = num('max-attempts', DEFAULT_MAX_ATTEMPTS);
  const maxPerHour = num('max-per-hour', DEFAULT_MAX_PER_HOUR);
  const marker = (status: 'refused' | 'reset', headline: string, attempt?: number, signature?: string): RunRecord => {
    const t = new Date();
    return { name, startedAt: t, endedAt: t, exitCode: status === 'refused' ? 3 : 0, logPath: '', verdict: { status, headline, findings: [] }, attempt, signature };
  };
  if (reset) {
    appendRun(runsTtlPath(), marker('reset', 'breaker reset by --reset'));
    setCircuitCache(name, null);
    console.log(`${name}: breaker reset`);
    if (!cmd.length) process.exit(0);
  }
  const history = readRuns().filter((r) => r.name === name);
  const decision = breakerDecision(history, { maxAttempts, maxPerHour, now: new Date() });
  if (!decision.allow) {
    appendRun(runsTtlPath(), marker('refused', `refused: ${decision.reason}`.slice(0, 120), decision.attempt, decision.signature));
    console.error(`job-watch: REFUSED ${name} — ${decision.reason}`);
    process.exit(3);
  }
  const model = flag('model') ?? 'qwen3.6:latest';
  const base = (process.env.OLLAMA_BASE_URL ?? '').replace(/\/+$/, '');

  mkdirSync(stateDir(), { recursive: true });
  const startedAt = new Date();
  const logPath = path.join(stateDir(), `${slug(name)}-${startedAt.toISOString().replace(/[:.]/g, '-')}.log`);
  updateCurrent({ add: { name, pid: process.pid, started: startedAt.toISOString(), attempt: decision.attempt, maxAttempts } });
  const cleanup = (code: number) => () => { activeChild?.kill(); try { updateCurrent({ removePid: process.pid }); } catch { /* best effort */ } process.exit(code); };
  process.on('SIGINT', cleanup(130));
  process.on('SIGTERM', cleanup(143));
  const { exitCode, durationMs } = await run(cmd, logPath);
  updateCurrent({ removePid: process.pid });
  const endedAt = new Date();
  const log = readFileSync(logPath, 'utf8');
  const facts = extractFacts(log, exitCode, durationMs);

  let verdict: Verdict;
  let modelUsed: string | undefined;
  const notes: string[] = [];
  const scriptOnly = (why: string): Verdict => {
    notes.push(why);
    const c = facts.counts;
    const bits = [c.testsPassed !== undefined ? `${c.testsPassed} tests passed` : '', c.testsFailed ? `${c.testsFailed} failed` : '', `exit ${exitCode}`, `${(durationMs / 1000).toFixed(1)}s`].filter(Boolean);
    return { status: exitCode === 0 ? 'passed' : 'failed', headline: `${bits.join(', ')} (script facts only: ${why})`.slice(0, 120), findings: [] };
  };
  if (!base) verdict = scriptOnly('OLLAMA_BASE_URL not set');
  else {
    const t0 = Date.now();
    try {
      const raw = await askModel(base, model, buildPrompt(name, facts, tailOf(log)));
      const v = validateVerdict(raw, log, exitCode);
      verdict = v.verdict; notes.push(...v.notes); modelUsed = model;
      console.error(`job-watch: ${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      verdict = scriptOnly(`local model unavailable: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  const rec: RunRecord = { name, startedAt, endedAt, exitCode, logPath, verdict, modelUsed, modelNote: notes.length ? notes.join('; ').slice(0, 400) : undefined, attempt: decision.attempt, signature: failureSignature(log, exitCode) };
  appendRun(runsTtlPath(), rec);
  const open = openCircuits(readRuns(), maxAttempts).find((c) => c.name === name);
  setCircuitCache(name, open ? { count: open.count, signature: open.signature } : null);
  if (open) console.error(`job-watch: circuit now OPEN for ${name} (${open.count} identical failures); the next run will be refused`);
  console.log(`${name}: ${verdict.status} — ${verdict.headline} (ttl: ${runEntityId(name, startedAt)})`);
  process.exit(exitCode === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
