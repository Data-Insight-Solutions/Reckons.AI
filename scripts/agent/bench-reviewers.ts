#!/usr/bin/env npx tsx
/**
 * REVIEWER BENCHMARK — can a cheaper model do the overseer's review job? (roadmap kb:model-routing-ledger)
 *
 * Matt, 2026-09-30: "Maybe Overseers could be Haiku?" That is a measurable question, so this measures it:
 * each case in scripts/agent/fixtures/reviewer-bench/*.json is a review decision whose correct answer is
 * KNOWN, because it was decided on a real public PR of this repository (a noisy local-review finding that
 * was rejected, a fail-open guard that needed a fix, a clean change that was accepted). Each model is asked
 * for a JSON verdict and scored on:
 *   - verdict accuracy         accept | reject | required-change, exact match
 *   - mustMention hit rate     did the reasons name the thing that makes the verdict right (a keyword check;
 *                              crude on purpose: it is deterministic, and a miss is a thing to read, not a proof)
 *   - tokens, cost, latency    as reported by `claude -p --output-format json`
 *
 * Usage:
 *   npx tsx scripts/agent/bench-reviewers.ts                       haiku + sonnet over every case
 *   npx tsx scripts/agent/bench-reviewers.ts --models=haiku        one model
 *   npx tsx scripts/agent/bench-reviewers.ts --include-opus        ALSO opus (it is metered: opt in)
 *   npx tsx scripts/agent/bench-reviewers.ts --yes                 required to run more than 12 calls
 *   npx tsx scripts/agent/bench-reviewers.ts --repeat=3            each case N times (variance)
 *
 * Results: ${XDG_STATE_HOME:-~/.local/state}/reckons/bench/reviewers-<ts>.json (mode 0600).
 *
 * LIMITS, said here and not only in the PR: a handful of cases measures nothing finely (one case is 1/7 of
 * the accuracy); a case that is public-PR-derived may be in a model's training data; and `cost` is
 * what the CLI REPORTS, which on a subscription is an equivalent, not a charge.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export type Verdict = 'accept' | 'reject' | 'required-change';
export const VERDICTS: Verdict[] = ['accept', 'reject', 'required-change'];

export type BenchCase = {
  id: string;
  source?: string;
  promptContext: string;
  expected: { verdict: Verdict; mustMention?: string[] };
};

export type CallUsage = { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; costUsd: number; durationMs: number };

export type Parsed = { verdict: Verdict | null; reasons: string };

export type CaseResult = {
  caseId: string;
  model: string;
  verdict: Verdict | null;
  reasons: string;
  verdictCorrect: boolean;
  mentionHits: number;
  mentionTotal: number;
  usage: CallUsage;
  error?: string;
};

/** The model's text -> verdict + reasons. Tolerates code fences and prose around the JSON object. */
export function parseVerdict(text: string): Parsed {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: null, reasons: text.trim() };
  try {
    const o = JSON.parse(unfenced.slice(start, end + 1));
    const v = typeof o.verdict === 'string' ? o.verdict.trim().toLowerCase().replace(/[_ ]/g, '-') : '';
    const reasons = Array.isArray(o.reasons) ? o.reasons.map(String).join(' ') : String(o.reasons ?? '');
    return { verdict: (VERDICTS as string[]).includes(v) ? (v as Verdict) : null, reasons };
  } catch {
    // Malformed JSON (observed: haiku emitted the invalid escape \' inside a string). The verdict is still
    // stated; salvage it rather than score a clear answer as a format failure, and keep the whole text
    // as the reasons so mustMention still sees it.
    return { verdict: salvageVerdict(unfenced), reasons: text.trim() };
  }
}

function salvageVerdict(text: string): Verdict | null {
  const m = /"verdict"\s*:\s*"([^"]+)"/i.exec(text);
  const v = m ? m[1].trim().toLowerCase().replace(/[_ ]/g, '-') : '';
  return (VERDICTS as string[]).includes(v) ? (v as Verdict) : null;
}

/** Case-insensitive substring check of each required keyword against the reasons. */
export function mentionHits(reasons: string, must: string[] | undefined): { hits: number; total: number } {
  const r = reasons.toLowerCase();
  const list = must ?? [];
  return { hits: list.filter((m) => r.includes(m.toLowerCase())).length, total: list.length };
}

/**
 * The `--output-format json` object -> text and usage. Field names verified on real output 2026-09-30:
 * result, is_error, duration_ms, total_cost_usd, usage.{input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens}.
 */
export function parseCliJson(stdout: string): { text: string; usage: CallUsage; isError: boolean } {
  const o = JSON.parse(stdout);
  const u = o.usage ?? {};
  return {
    text: String(o.result ?? ''),
    isError: Boolean(o.is_error),
    usage: {
      inputTokens: Number(u.input_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? 0),
      cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
      cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
      costUsd: Number(o.total_cost_usd ?? 0),
      durationMs: Number(o.duration_ms ?? 0),
    },
  };
}

export type ModelSummary = {
  model: string;
  cases: number;
  verdictAccuracy: number;
  mentionRate: number;
  unparsed: number;
  inputPerCase: number;
  outputPerCase: number;
  costPerCase: number;
  latencyMsPerCase: number;
  /** Cases whose expected verdict was missed, with what was said instead. */
  misses: { caseId: string; expected: Verdict; got: Verdict | null }[];
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(results: CaseResult[], expected: Map<string, Verdict>): ModelSummary[] {
  const byModel = new Map<string, CaseResult[]>();
  for (const r of results) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  return [...byModel.entries()].map(([model, rs]) => {
    const hits = rs.reduce((s, r) => s + r.mentionHits, 0);
    const total = rs.reduce((s, r) => s + r.mentionTotal, 0);
    return {
      model,
      cases: rs.length,
      verdictAccuracy: rs.length ? rs.filter((r) => r.verdictCorrect).length / rs.length : 0,
      mentionRate: total ? hits / total : 0,
      unparsed: rs.filter((r) => r.verdict === null).length,
      inputPerCase: mean(rs.map((r) => r.usage.inputTokens + r.usage.cacheCreationTokens + r.usage.cacheReadTokens)),
      outputPerCase: mean(rs.map((r) => r.usage.outputTokens)),
      costPerCase: mean(rs.map((r) => r.usage.costUsd)),
      latencyMsPerCase: mean(rs.map((r) => r.usage.durationMs)),
      misses: rs.filter((r) => !r.verdictCorrect).map((r) => ({ caseId: r.caseId, expected: expected.get(r.caseId)!, got: r.verdict })),
    };
  });
}

/** Calls the plan will make; opus only when asked for. */
export function planCalls(nCases: number, models: string[], repeat: number): number {
  return nCases * models.length * repeat;
}

export function selectModels(arg: string | undefined, includeOpus: boolean): string[] {
  const base = (arg ? arg.split(',') : ['haiku', 'sonnet']).map((m) => m.trim()).filter(Boolean);
  const withoutOpus = base.filter((m) => !m.toLowerCase().includes('opus'));
  return includeOpus ? [...withoutOpus, 'opus'] : withoutOpus;
}

export const SYSTEM_PROMPT =
  'You are an overseer reviewing one change, or one automated review finding, in a TypeScript/Svelte repository. ' +
  'Decide with the evidence given; do not ask questions and do not use tools. ' +
  'For a code change: "accept" = sound as it is, "required-change" = a real defect that must be fixed before it lands, ' +
  '"reject" = it should not land at all. For a FINDING from a local model: "accept" = a real defect, act on it, ' +
  '"reject" = noise or wrong.';

export function buildPrompt(c: BenchCase): string {
  return `${c.promptContext}\n\nAnswer with ONLY a JSON object, no prose: {"verdict": "accept" | "reject" | "required-change", "reasons": ["<one short reason>", ...]}`;
}

const run = promisify(execFile);

async function callOnce(model: string, c: BenchCase): Promise<CaseResult> {
  const args = [
    '-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence',
    '--disable-slash-commands', '--strict-mcp-config', '--system-prompt', SYSTEM_PROMPT,
  ];
  // Nested sessions are refused unless CLAUDECODE is unset; cwd is a scratch dir so no project CLAUDE.md loads.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const empty: CallUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, durationMs: 0 };
  const t0 = Date.now();
  try {
    const child = run('claude', args, { env, cwd: tmpdir(), maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    child.child.stdin?.end(buildPrompt(c));
    const { stdout } = await child;
    const p = parseCliJson(stdout);
    const v = parseVerdict(p.text);
    const m = mentionHits(v.reasons, c.expected.mustMention);
    return {
      caseId: c.id, model, verdict: v.verdict, reasons: v.reasons,
      verdictCorrect: v.verdict === c.expected.verdict,
      mentionHits: m.hits, mentionTotal: m.total,
      usage: { ...p.usage, durationMs: p.usage.durationMs || Date.now() - t0 },
      error: p.isError ? p.text.slice(0, 200) : undefined,
    };
  } catch (e) {
    return {
      caseId: c.id, model, verdict: null, reasons: '', verdictCorrect: false,
      mentionHits: 0, mentionTotal: c.expected.mustMention?.length ?? 0,
      usage: { ...empty, durationMs: Date.now() - t0 }, error: String((e as Error).message).split('\n')[0],
    };
  }
}

export function loadCases(dir: string): BenchCase[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as BenchCase);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatTable(rows: ModelSummary[]): string {
  const head = ['model', 'accuracy', 'mustMention', 'unparsed', 'in tok/case', 'out tok/case', '$/case', 'latency s'];
  const body = rows.map((r) => [
    r.model, pct(r.verdictAccuracy), pct(r.mentionRate), String(r.unparsed), Math.round(r.inputPerCase).toString(),
    Math.round(r.outputPerCase).toString(), r.costPerCase.toFixed(4), (r.latencyMsPerCase / 1000).toFixed(1),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

/** Re-score a saved results file with the current parser and fixtures: no model calls. */
export function rescore(results: CaseResult[], cases: BenchCase[]): CaseResult[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  return results.map((r) => {
    const c = byId.get(r.caseId);
    if (!c) return r;
    const v = parseVerdict(r.reasons);
    const verdict = r.verdict ?? v.verdict;
    const m = mentionHits(r.reasons, c.expected.mustMention);
    return { ...r, verdict, verdictCorrect: verdict === c.expected.verdict, mentionHits: m.hits, mentionTotal: m.total };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const rescoreFile = flag('rescore');
  if (rescoreFile) {
    const saved = JSON.parse(readFileSync(rescoreFile, 'utf8'));
    const cases = loadCases(path.resolve(import.meta.dirname ?? '.', 'fixtures', 'reviewer-bench'));
    const results = rescore(saved.results, cases);
    console.log(formatTable(summarize(results, new Map(cases.map((c) => [c.id, c.expected.verdict] as const)))));
    return;
  }
  const dir = path.resolve(import.meta.dirname ?? '.', 'fixtures', 'reviewer-bench');
  const cases = loadCases(dir);
  const models = selectModels(flag('models'), args.includes('--include-opus'));
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const calls = planCalls(cases.length, models, repeat);
  console.log(`Plan: ${cases.length} cases x ${models.join(', ')} x ${repeat} = ${calls} claude -p calls${args.includes('--include-opus') ? ' (opus included: metered)' : ''}.`);
  if (calls > 12 && !args.includes('--yes')) { console.error('More than 12 calls: pass --yes to run them.'); process.exit(1); }

  const results: CaseResult[] = [];
  for (const model of models) for (let i = 0; i < repeat; i++) for (const c of cases) {
    const r = await callOnce(model, c);
    results.push(r);
    console.log(`${model.padEnd(7)} ${c.id.padEnd(34)} expected=${c.expected.verdict.padEnd(15)} got=${String(r.verdict).padEnd(15)} ${r.verdictCorrect ? 'ok' : 'MISS'}${r.error ? `  [${r.error}]` : ''}`);
  }
  const expected = new Map(cases.map((c) => [c.id, c.expected.verdict] as const));
  const summary = summarize(results, expected);
  console.log(`\n${formatTable(summary)}\n`);

  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'reckons', 'bench');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, `reviewers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), models, repeat, summary, results }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Results: ${file.replace(homedir(), '~')}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) main();
