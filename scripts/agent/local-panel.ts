/**
 * LOCAL PANEL — hand a batch of judgment calls to several local models, and get back only the ones
 * they disagree on (F74.7, agent tier).
 *
 * WHY THIS EXISTS. Every agent-tier job here (layer-classify, describe-entities, code-review, …) is
 * a single-purpose script asking ONE model. That works for a job somebody wrote in advance. It does
 * not let the orchestrating session (Opus, on a metered subscription) hand off a judgment it meets
 * mid-task — "which of the four meanings of `node` is this?" asked 300 times — without writing a new
 * script first. This is the generic dispatcher for that: one narrow question, many items, a JSON
 * schema for the answer, and a PANEL of models from different families.
 *
 * WHY VOTES AND NOT ONE ANSWER. One local answer is confidently wrong often enough that its output
 * has to be triaged line by line, and triage is where the saved tokens get spent again (F74.3).
 * AGREEMENT across votes is a reliability signal the orchestrator can act on without reading the
 * item: agreed answers are taken, and only disagreements come back for real reasoning.
 * Whether agreement actually predicts correctness is measured per job, never assumed — see the
 * `measured` notes on kb:local-panel in the roadmap.
 *
 * THE TRUST POLICY, FROM THE FIRST CALIBRATION (2026-09-30, 30 `node` sites hand-labelled by Opus,
 * scripts/agent/fixtures/term-senses-node.*):
 *
 *   panel                                 unanimous     majority (decidable)   time
 *   qwen3.6 + gemma3:27b + mistral-small  16/16 right   5/9  (56%)             125 s
 *   qwen3.6 × 3 votes (the default)       13/13 right   9/10 (90%)             60 s
 *
 * A mixed panel lets two weaker models outvote a stronger one (qwen3.6 alone: 23/25), so the default
 * is one strong model voting three times — the first vote at temperature 0, the others sampled.
 * By default only UNANIMOUS verdicts are taken unread; --accept=majority also takes majorities, at
 * the measured cost above. Re-score with --labels before trusting any change of models.
 *
 * WHY NOT A PANEL OF FAMILIES, given the argument above for one: that argument was a hypothesis, and
 * the measurement refuted it on this task. Mixed panels remain available with --models=a,b,c.
 *
 *   ground    the CALLER's job: each item carries its own context, built by a script. The panel
 *             never reads the repository, so a model cannot reach for context it was not given.
 *   prompt    one question, identical for every item, and a schema — Ollama constrains decoding
 *             to it, and checkAnswer re-checks the result anyway, with one retry that feeds back
 *             the error. It covers the schema subset a task needs (object, required, string /
 *             number / integer / boolean, enum, maxLength) rather than adding a validator
 *             dependency for it.
 *   validate  schema per vote; consensus over one declared field (`agreeOn`).
 *   emit      a result file with every vote, and a short summary that lists only what needs a
 *             human or the orchestrator. It writes nothing else.
 *
 * TWO ENGINES. `ollama` (default) is a direct /api/chat call: fast, grounded, no tools. `claude-code`
 * runs headless Claude Code against Ollama's Anthropic-compatible endpoint, so a local model gets
 * Read/Grep/Glob and can explore — isolated in its own config directory, because Claude Code refuses
 * to nest and warns that nested sessions share runtime state. MEASURED 2026-09-30, qwen3-coder on a
 * counting question about reckons-terminology.ttl: 10 turns, 2m07s, 290k input tokens, and a WRONG
 * answer (reported 3 and 10/5/5; the truth is 25 = 11/9/5). Exploration by a local model is the
 * weakest mode here; prefer grounding by script and use it only when the context cannot be built.
 *
 * Usage:
 *   npx tsx scripts/agent/local-panel.ts --task=task.json [--out=result.json]
 *     [--models=qwen3.6:latest] [--votes=3] [--accept=unanimous|majority] [--concurrency=2]
 *     [--engine=ollama|claude-code] [--json] [--labels=labels.json]
 *
 *   --labels scores the run against hand labels ({ itemId: value | "ambiguous" }). A labelled
 *   fixture lives in scripts/agent/fixtures/; re-run it whenever the panel's models change.
 *
 * A task file is a PanelTask (below). Requires OLLAMA_BASE_URL or a server on localhost:11434; if it
 * is down this says so and exits 2 — it never falls back to a cloud model.
 *
 * Every run and every vote is also logged to local-activity.ts's event log, so `npm run agent:watch`
 * can show it live — a local run is a shell command, and never appears in Claude Code's agent list.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { logEvent } from './local-activity.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');

/** One strong model, three votes — measured better and faster than three families (see header). */
export const DEFAULT_PANEL = ['qwen3.6:latest'];
export const DEFAULT_SELF_VOTES = 3;

export type Accept = 'unanimous' | 'majority';

export type PanelItem = { id: string; context: string };

export type PanelTask = {
  id: string;
  /** The one narrow question, asked identically of every item. */
  instruction: string;
  /** JSON schema of ONE answer. Must be an object schema containing `agreeOn`. */
  answer: Record<string, unknown>;
  /** The answer field consensus is computed on — an enum or a short label, not prose. */
  agreeOn: string;
  items: PanelItem[];
  models?: string[];
  votesPerModel?: number;
  numCtx?: number;
  maxOutput?: number;
};

export type Vote = { model: string; item: string; answer?: Record<string, unknown>; error?: string; ms: number };

export type VerdictStatus = 'unanimous' | 'majority' | 'split' | 'failed';

export type Verdict = {
  item: string;
  status: VerdictStatus;
  /** The winning value of `agreeOn`, when there is one. */
  value?: string;
  /** Winning votes over ALL votes cast — a vote that failed counts against agreement, not for it. */
  agreement: number;
  votes: Vote[];
};

export type PanelResult = {
  task: string;
  models: string[];
  engine: Engine;
  startedAt: string;
  ms: number;
  counts: Record<VerdictStatus, number>;
  verdicts: Verdict[];
};

type Engine = 'ollama' | 'claude-code';

export function validateTask(task: PanelTask): string[] {
  const problems: string[] = [];
  if (!task.id) problems.push('task.id is missing');
  if (!task.instruction?.trim()) problems.push('task.instruction is empty');
  if (!Array.isArray(task.items) || task.items.length === 0) problems.push('task.items is empty');
  const props = (task.answer?.properties ?? {}) as Record<string, unknown>;
  if (task.answer?.type !== 'object') problems.push('task.answer must be an object schema');
  if (!task.agreeOn || !(task.agreeOn in props)) problems.push(`task.agreeOn "${task.agreeOn}" is not a property of task.answer`);
  const ids = new Set<string>();
  for (const it of task.items ?? []) {
    if (!it.id) problems.push('an item has no id');
    else if (ids.has(it.id)) problems.push(`duplicate item id ${it.id}`);
    ids.add(it.id);
  }
  return problems;
}

/** Consensus over one field. Pure, so the thresholds are pinned by tests rather than by habit. */
export function aggregate(item: string, votes: Vote[], agreeOn: string): Verdict {
  const cast = votes.length;
  const valued = votes
    .map((v) => (v.answer && v.answer[agreeOn] !== undefined ? String(v.answer[agreeOn]) : undefined))
    .filter((v): v is string => v !== undefined);
  if (cast === 0 || valued.length === 0) return { item, status: 'failed', agreement: 0, votes };
  const tally = new Map<string, number>();
  for (const v of valued) tally.set(v, (tally.get(v) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [value, top] = ranked[0];
  const tied = ranked.length > 1 && ranked[1][1] === top;
  const agreement = top / cast;
  if (top === cast) return { item, status: 'unanimous', value, agreement, votes };
  if (!tied && top * 2 > cast) return { item, status: 'majority', value, agreement, votes };
  return { item, status: 'split', agreement, votes };
}

export const SYSTEM_PROMPT =
  'You answer one narrow question about one item, using ONLY the context given with it. ' +
  'Do not guess beyond that context: if it does not settle the question and the schema offers an ' +
  '"other" or "unsure" choice, use it. Reply with JSON matching the schema and nothing else.';

export function itemPrompt(task: PanelTask, item: PanelItem): string {
  return `QUESTION\n${task.instruction.trim()}\n\nITEM ${item.id}\n${item.context.trim()}\n`;
}

type FieldSchema = { type?: string; enum?: unknown[]; maxLength?: number };

export function checkAnswer(schema: Record<string, unknown>, raw: string): { answer?: Record<string, unknown>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `not JSON: ${raw.slice(0, 120)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'answer must be a JSON object' };
  const answer = parsed as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, FieldSchema>;
  const problems: string[] = [];
  for (const key of (schema.required ?? []) as string[]) if (!(key in answer)) problems.push(`missing ${key}`);
  for (const [key, value] of Object.entries(answer)) {
    const field = props[key];
    if (!field) continue;
    const t = field.type;
    const typeOk =
      !t ||
      (t === 'string' && typeof value === 'string') ||
      (t === 'boolean' && typeof value === 'boolean') ||
      (t === 'number' && typeof value === 'number') ||
      (t === 'integer' && Number.isInteger(value));
    if (!typeOk) problems.push(`${key} must be ${t}`);
    else if (field.enum && !field.enum.includes(value)) problems.push(`${key} must be one of ${field.enum.join(', ')}`);
    else if (field.maxLength !== undefined && typeof value === 'string' && value.length > field.maxLength) problems.push(`${key} is longer than ${field.maxLength}`);
  }
  return problems.length ? { error: problems.join('; ') } : { answer };
}

async function ollamaChat(model: string, user: string, task: PanelTask, attempt: number, withThink: boolean): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // think:false — a hybrid-thinking model otherwise spends its budget reasoning and returns
      // nothing (measured 2026-09-08). Models without the switch reject it, hence the fallback.
      ...(withThink ? { think: false } : {}),
      format: task.answer,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      options: {
        num_ctx: task.numCtx ?? 8192,
        num_predict: task.maxOutput ?? 300,
        // The first vote is deterministic; extra votes from the same model need some spread or
        // they are the same vote counted twice.
        temperature: attempt === 0 ? 0 : 0.7,
        seed: 1000 + attempt,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (withThink && /think/i.test(body)) return ollamaChat(model, user, task, attempt, false);
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 160)}`);
  }
  return ((await res.json()) as { message?: { content?: string } }).message?.content?.trim() ?? '';
}

/** Headless Claude Code on a local model — see the header for why it is isolated and why it is weak. */
function claudeCode(model: string, user: string, task: PanelTask): Promise<string> {
  const configDir = join(tmpdir(), 'reckons-local-claude-code');
  mkdirSync(configDir, { recursive: true });
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ANTHROPIC_API_KEY']) delete env[k];
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: OLLAMA,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const args = [
    '-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--setting-sources', 'project', '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read Grep Glob', '--json-schema', JSON.stringify(task.answer),
    '--append-system-prompt', SYSTEM_PROMPT, user,
  ];
  return new Promise((done, fail) => {
    const child = spawn('claude', args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { structured_output?: unknown; is_error?: boolean; result?: string };
        if (parsed.is_error || parsed.structured_output === undefined) return fail(new Error(`claude-code: ${String(parsed.result ?? '').slice(0, 160)}`));
        done(JSON.stringify(parsed.structured_output));
      } catch {
        fail(new Error(`claude-code exit ${code}: ${(err || out).slice(0, 160)}`));
      }
    });
  });
}

/** The answer's first free-text field other than the one voted on — what the dashboard shows as "why". */
export function reasonOf(answer: Record<string, unknown> | undefined, agreeOn: string): string | undefined {
  if (!answer) return undefined;
  const entry = Object.entries(answer).find(([k, v]) => k !== agreeOn && typeof v === 'string');
  return entry ? String(entry[1]).slice(0, 160) : undefined;
}

async function vote(run: string, engine: Engine, model: string, task: PanelTask, item: PanelItem, attempt: number): Promise<Vote> {
  const result = await castVote(engine, model, task, item, attempt);
  logEvent({
    kind: 'vote', run, at: new Date().toISOString(), model, item: item.id, ms: result.ms,
    value: result.answer ? String(result.answer[task.agreeOn]) : undefined,
    reason: reasonOf(result.answer, task.agreeOn),
    error: result.error?.slice(0, 160),
  });
  return result;
}

async function castVote(engine: Engine, model: string, task: PanelTask, item: PanelItem, attempt: number): Promise<Vote> {
  const t0 = Date.now();
  const user = itemPrompt(task, item);
  try {
    const ask = (u: string) => (engine === 'claude-code' ? claudeCode(model, u, task) : ollamaChat(model, u, task, attempt, true));
    let checked = checkAnswer(task.answer, await ask(user));
    if (checked.error) {
      // One retry, told exactly what was wrong. A second failure is reported, not retried forever.
      checked = checkAnswer(task.answer, await ask(`${user}\nYOUR PREVIOUS REPLY WAS REJECTED: ${checked.error}\nReply again with JSON matching the schema.`));
    }
    return { model, item: item.id, ...checked, ms: Date.now() - t0 };
  } catch (e) {
    return { model, item: item.id, error: (e as Error).message, ms: Date.now() - t0 };
  }
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

export async function availableModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA}/api/tags`).catch(() => undefined);
  if (!res?.ok) throw new Error(`Ollama is not reachable at ${OLLAMA}. Start it, or set OLLAMA_BASE_URL. Not falling back to a cloud model.`);
  return ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name);
}

export async function runPanel(
  task: PanelTask,
  opts: { models?: string[]; votes?: number; concurrency?: number; engine?: Engine; onProgress?: (msg: string) => void; resultPath?: string } = {},
): Promise<PanelResult> {
  const problems = validateTask(task);
  if (problems.length) throw new Error(`invalid task: ${problems.join('; ')}`);
  const engine = opts.engine ?? 'ollama';
  const models = opts.models ?? task.models ?? DEFAULT_PANEL;
  const have = await availableModels();
  const missing = models.filter((m) => !have.includes(m));
  if (missing.length) throw new Error(`models not installed: ${missing.join(', ')} (ollama pull them, or pass --models)`);
  // A single model needs several votes or there is nothing to agree; a panel gets one each.
  const votesPerModel = opts.votes ?? task.votesPerModel ?? (models.length === 1 ? DEFAULT_SELF_VOTES : 1);
  const started = Date.now();
  const run = `${task.id}-${started.toString(36)}`;
  logEvent({ kind: 'run-start', run, at: new Date(started).toISOString(), task: task.id, models, items: task.items.length, votesPerModel, engine, cwd: process.cwd() });
  const all: Vote[] = [];
  // Model by model, so each is loaded once rather than swapped per item.
  for (const model of models) {
    const t0 = Date.now();
    const jobs = task.items.flatMap((item) => Array.from({ length: votesPerModel }, (_, a) => () => vote(run, engine, model, task, item, a)));
    const votes = await pool(jobs, opts.concurrency ?? 2);
    all.push(...votes);
    const failed = votes.filter((v) => !v.answer).length;
    opts.onProgress?.(`  ${model}: ${votes.length} votes in ${((Date.now() - t0) / 1000).toFixed(0)}s${failed ? `, ${failed} FAILED` : ''}`);
  }
  const verdicts = task.items.map((item) => aggregate(item.id, all.filter((v) => v.item === item.id), task.agreeOn));
  const counts: Record<VerdictStatus, number> = { unanimous: 0, majority: 0, split: 0, failed: 0 };
  for (const v of verdicts) counts[v.status]++;
  logEvent({ kind: 'run-end', run, at: new Date().toISOString(), ms: Date.now() - started, counts, resultPath: opts.resultPath });
  return { task: task.id, models, engine, startedAt: new Date(started).toISOString(), ms: Date.now() - started, counts, verdicts };
}

/** What is taken unread — see THE TRUST POLICY in the header. */
export function needsReview(v: Verdict, accept: Accept = 'unanimous'): boolean {
  if (v.status === 'unanimous') return false;
  return !(accept === 'majority' && v.status === 'majority');
}

/** The part the orchestrator reads: counts, then only what needs it. Everything else is in the file. */
export function summarize(result: PanelResult, agreeOn: string, limit = 25, accept: Accept = 'unanimous'): string {
  const c = result.counts;
  const total = result.verdicts.length;
  const lines = [
    `panel ${result.task}: ${total} items × ${result.models.length} models (${result.models.join(', ')}) in ${(result.ms / 1000).toFixed(0)}s`,
    `  unanimous ${c.unanimous} · majority ${c.majority} · split ${c.split} · failed ${c.failed}` +
      ` — ${total - result.verdicts.filter((v) => needsReview(v, accept)).length} taken (accept=${accept}), ${result.verdicts.filter((v) => needsReview(v, accept)).length} to review`,
  ];
  const show = (v: Verdict) =>
    `  ${v.status.toUpperCase()} ${v.item}: ` +
    v.votes.map((x) => `${x.model.split(':')[0]}=${x.answer ? String(x.answer[agreeOn]) : `ERR(${(x.error ?? '').slice(0, 40)})`}`).join(' ');
  // Worst first: failures and splits, then majorities when they are not accepted.
  const rank: Record<VerdictStatus, number> = { failed: 0, split: 1, majority: 2, unanimous: 3 };
  const review = result.verdicts.filter((v) => needsReview(v, accept)).sort((a, b) => rank[a.status] - rank[b.status]);
  for (const v of review.slice(0, limit)) lines.push(show(v));
  if (review.length > limit) lines.push(`  … ${review.length - limit} more to review in the result file`);
  return lines.join('\n');
}

export type Score = Record<VerdictStatus, { correct: number; wrong: number; ambiguous: number; unlabelled: number }>;

/**
 * Score a run against hand labels. A label of 'ambiguous' means the question has no single right
 * answer for that item; those are counted separately so they neither flatter nor punish the panel.
 * For split and failed items there is no panel answer, so only the ambiguity count is informative.
 */
export function scoreAgainst(result: PanelResult, labels: Record<string, string>): Score {
  const blank = () => ({ correct: 0, wrong: 0, ambiguous: 0, unlabelled: 0 });
  const score: Score = { unanimous: blank(), majority: blank(), split: blank(), failed: blank() };
  for (const v of result.verdicts) {
    const want = labels[v.item];
    const row = score[v.status];
    if (want === undefined) row.unlabelled++;
    else if (want === 'ambiguous') row.ambiguous++;
    else if (v.value === want) row.correct++;
    else row.wrong++;
  }
  return score;
}

export function formatScore(score: Score): string {
  return (Object.keys(score) as VerdictStatus[])
    .map((s) => {
      const r = score[s];
      const decided = r.correct + r.wrong;
      return `  ${s.padEnd(9)} correct ${r.correct} · wrong ${r.wrong} · ambiguous ${r.ambiguous}${r.unlabelled ? ` · unlabelled ${r.unlabelled}` : ''}` +
        (decided && (s === 'unanimous' || s === 'majority') ? `  (${Math.round((100 * r.correct) / decided)}% of decidable)` : '');
    })
    .join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const taskPath = flag('task');
  if (!taskPath) {
    console.error('Usage: npx tsx scripts/agent/local-panel.ts --task=task.json [--out=result.json] [--models=a,b] [--votes=3] [--accept=unanimous|majority] [--concurrency=2] [--engine=ollama|claude-code] [--json] [--labels=labels.json]');
    process.exit(1);
  }
  const task = JSON.parse(readFileSync(taskPath, 'utf8')) as PanelTask;
  const accept: Accept = flag('accept') === 'majority' ? 'majority' : 'unanimous';
  const out = flag('out') ?? taskPath.replace(/\.json$/, '') + '.result.json';
  let result: PanelResult;
  try {
    result = await runPanel(task, {
      models: flag('models')?.split(',').filter(Boolean),
      votes: flag('votes') ? Number(flag('votes')) : undefined,
      concurrency: flag('concurrency') ? Number(flag('concurrency')) : undefined,
      engine: (flag('engine') as Engine | undefined) ?? 'ollama',
      onProgress: (m) => console.error(m),
      resultPath: out,
    });
  } catch (e) {
    console.error(`local-panel: ${(e as Error).message}`);
    process.exit(2);
  }
  writeFileSync(out, JSON.stringify(result, null, 2));
  if (argv.includes('--json')) console.log(JSON.stringify(result));
  else console.log(`${summarize(result, task.agreeOn, 25, accept)}\nresult → ${out}`);
  const labelsPath = flag('labels');
  if (labelsPath) {
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as Record<string, string>;
    console.log(`SCORE against ${labelsPath}:\n${formatScore(scoreAgainst(result, labels))}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('local-panel.ts')) void main();
