#!/usr/bin/env npx tsx
/**
 * A/B benchmark — does the graph actually pay for itself?
 *
 * kb:graph-economics (F74.5) states the honest weakness of every saving claimed in this
 * project: "there is NO COUNTERFACTUAL: no control repo built without a graph, and n=1."
 * This harness builds that counterfactual. One feature task, written once, executed twice
 * from the same base commit in two isolated worktrees:
 *
 *   CONTROL  no CLAUDE.md, no HANDOFF.md, no .mcp.json — plain Claude Code on this repo
 *   GRAPH    CLAUDE.md as shipped + the reckons MCP server attached
 *
 * Both arms get the identical task text, the same model, and a clean tree. The harness
 * measures cost from each arm's own stream-json transcript and captures the resulting
 * diff so the OUTCOME can be judged, not just the bill.
 *
 * Usage:
 *   npx tsx scripts/offline/ab-graph-benchmark.ts --task=tasks/x.md --kind=decided
 *   npx tsx scripts/offline/ab-graph-benchmark.ts --task=tasks/x.md --kind=decided --run
 *   npx tsx scripts/offline/ab-graph-benchmark.ts --report=.ab/run-<id>
 *
 * Without --run this is a DRY RUN: it prints the plan and the fixed tax, and touches nothing.
 *
 * READ BEFORE TRUSTING A RESULT
 *  - TASK SELECTION DECIDES THE OUTCOME, so --kind is required and recorded. On a
 *    'greenfield' task nothing is in the graph to find and the graph arm can only look
 *    like overhead (it pays the CLAUDE.md + tool-schema tax for nothing). On a 'decided'
 *    task — work the graph already has a ruling on — avoided rework is the whole claim.
 *    A single greenfield run is not evidence against the graph, and a single decided run
 *    is not evidence for it. Run both kinds, and say which you ran.
 *  - CHEAPER IS NOT BETTER. An arm that spends fewer tokens building the wrong thing, or
 *    rebuilding something that already exists, LOST. Cost is only meaningful alongside
 *    the outcome, which this harness captures but cannot score. Judge the diffs.
 *  - n=1 per cell. Model sampling is stochastic; a single pair is an anecdote. Repeat
 *    with --repeat to get a spread before quoting any number.
 *  - --run passes --dangerously-skip-permissions so the arms are unattended. That is why
 *    they execute in throwaway worktrees outside the main tree. Read the task spec you
 *    are handing them first; they can run arbitrary commands inside that worktree.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const RUN = args.includes('--run');
const JSON_OUT = args.includes('--json');
const model = flag('model') ?? 'opus';
const base = flag('base') ?? 'HEAD';
const repeat = Number(flag('repeat') ?? 1);
const kind = flag('kind');
const taskFile = flag('task');
const reportOnly = flag('report');

/** Project convention: ~1.33 tokens per word (mcp-server/src/index.ts estimateTokens). */
const tokens = (s: string) => Math.round(s.split(/\s+/).filter(Boolean).length * 1.33);
const k = (n: number) => (n < 1e3 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(1)}K` : `${(n / 1e6).toFixed(2)}M`);
const W = { input: 1, cacheW: 1.25, cacheR: 0.1, output: 5 }; // same weights as session-tokens.ts
const git = (a: string[], cwd = process.cwd()) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

type Metrics = {
  arm: string; requests: number; input: number; cacheW: number; cacheR: number; output: number;
  weighted: number; ctxPerReq: number; peak: number; wallMs: number; toolCalls: Record<string, number>;
  filesRead: string[]; graphCalls: number; exitCode: number | null;
};

/** Everything the graph arm pays before it does any work at all. */
function fixedTax(): { claudeMd: number; memory: number; handoff: number } {
  const t = (p: string) => (existsSync(p) ? tokens(readFileSync(p, 'utf8')) : 0);
  return {
    claudeMd: t('CLAUDE.md'),
    memory: t(path.join(process.env.HOME ?? '', '.claude/projects/-home-matt-Github-tripleNotes/memory/MEMORY.md')),
    handoff: t('HANDOFF.md'),
  };
}

function parseStream(file: string, arm: string, wallMs: number, exitCode: number | null): Metrics {
  const m: Metrics = { arm, requests: 0, input: 0, cacheW: 0, cacheR: 0, output: 0, weighted: 0, ctxPerReq: 0, peak: 0, wallMs, toolCalls: {}, filesRead: [], graphCalls: 0, exitCode };
  let ctx = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    if (u) {
      m.input += u.input_tokens ?? 0; m.cacheW += u.cache_creation_input_tokens ?? 0;
      m.cacheR += u.cache_read_input_tokens ?? 0; m.output += u.output_tokens ?? 0;
      const c = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (c > m.peak) m.peak = c;
      ctx += c; m.requests++;
    }
    const content = o?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_use') continue;
        const name = b.name ?? '?';
        m.toolCalls[name] = (m.toolCalls[name] ?? 0) + 1;
        if (name.startsWith('mcp__reckons__')) m.graphCalls++;
        const fp = b.input?.file_path;
        if (typeof fp === 'string') m.filesRead.push(fp);
      }
    }
  }
  m.weighted = m.input * W.input + m.cacheW * W.cacheW + m.cacheR * W.cacheR + m.output * W.output;
  m.ctxPerReq = m.requests ? ctx / m.requests : 0;
  return m;
}

/** Strip the graph arm's advantages so CONTROL is genuinely plain Claude Code. */
const CONTROL_STRIP = ['CLAUDE.md', '.mcp.json', 'HANDOFF.md', 'HANDOFF-ARCHIVE.md', '.claude/settings.json', '.claude/settings.local.json'];

function runArm(arm: 'control' | 'graph', wt: string, task: string, outDir: string): Metrics {
  if (arm === 'control') for (const f of CONTROL_STRIP) { const p = path.join(wt, f); if (existsSync(p)) rmSync(p, { recursive: true, force: true }); }

  const outFile = path.join(outDir, `${arm}.stream.jsonl`);
  const cmd = ['-p', task, '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (arm === 'control') cmd.push('--strict-mcp-config');

  const t0 = Date.now();
  const r = spawnSync('claude', cmd, { cwd: wt, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env } });
  const wallMs = Date.now() - t0;
  writeFileSync(outFile, r.stdout ?? '');
  if (r.stderr?.trim()) writeFileSync(path.join(outDir, `${arm}.stderr.txt`), r.stderr);

  // Capture the OUTCOME, which is the half of the comparison that cost cannot answer.
  try {
    writeFileSync(path.join(outDir, `${arm}.diff`), execFileSync('git', ['diff', 'HEAD'], { cwd: wt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    writeFileSync(path.join(outDir, `${arm}.diffstat.txt`), execFileSync('git', ['diff', '--stat', 'HEAD'], { cwd: wt, encoding: 'utf8' }) + '\n--- untracked ---\n' + execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }));
  } catch { /* a arm that changed nothing still reports */ }

  return parseStream(outFile, arm, wallMs, r.status);
}

function report(dir: string): void {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const arms: Metrics[] = JSON.parse(readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
  if (JSON_OUT) { console.log(JSON.stringify({ meta, arms }, null, 2)); return; }
  const c = arms.find((a) => a.arm === 'control'), g = arms.find((a) => a.arm === 'graph');
  console.log(`\nA/B graph benchmark — ${path.basename(dir)}`);
  console.log(`task ${meta.taskFile}  kind=${meta.kind}  model=${meta.model}  base=${meta.base.slice(0, 8)}\n`);
  const row = (label: string, f: (m: Metrics) => string) =>
    console.log(`${label.padEnd(22)}${(c ? f(c) : '-').padStart(14)}${(g ? f(g) : '-').padStart(14)}`);
  console.log(`${''.padEnd(22)}${'CONTROL'.padStart(14)}${'GRAPH'.padStart(14)}`);
  console.log('-'.repeat(50));
  row('requests', (m) => String(m.requests));
  row('fresh input', (m) => k(m.input));
  row('cache write', (m) => k(m.cacheW));
  row('cache read', (m) => k(m.cacheR));
  row('output', (m) => k(m.output));
  row('WEIGHTED', (m) => k(m.weighted));
  row('ctx / request', (m) => k(m.ctxPerReq));
  row('peak ctx', (m) => k(m.peak));
  row('wall time', (m) => `${(m.wallMs / 1000).toFixed(0)}s`);
  row('tool calls', (m) => String(Object.values(m.toolCalls).reduce((a, b) => a + b, 0)));
  row('  file reads', (m) => String(m.filesRead.length));
  row('  graph queries', (m) => String(m.graphCalls));
  row('exit code', (m) => String(m.exitCode));
  if (c && g && c.weighted) {
    const d = ((g.weighted - c.weighted) / c.weighted) * 100;
    console.log('-'.repeat(50));
    console.log(`\nweighted cost: graph is ${d >= 0 ? '+' : ''}${d.toFixed(1)}% vs control`);
  }
  console.log(`\nfixed tax paid by the graph arm before any work: CLAUDE.md ${k(meta.tax.claudeMd)} tokens` +
    `${meta.tax.handoff ? `, HANDOFF.md ${k(meta.tax.handoff)}` : ''} (+ MCP tool schemas, not counted here).`);
  console.log(`\nNOW JUDGE THE OUTCOME — cost alone decides nothing:`);
  console.log(`  diff --stat:  ${dir}/control.diffstat.txt   ${dir}/graph.diffstat.txt`);
  console.log(`  full diffs:   ${dir}/control.diff           ${dir}/graph.diff`);
  console.log(`  Did either rebuild something that already exists? Did either follow a ruling`);
  console.log(`  the graph already holds? That is the claim under test, not the token count.\n`);
}

// ---------------------------------------------------------------------------
if (reportOnly) { report(reportOnly); process.exit(0); }

if (!taskFile || !kind) {
  console.error('Required: --task=<file.md> and --kind=greenfield|decided\n' +
    "  greenfield  nothing in the graph covers it — measures the graph's OVERHEAD\n" +
    "  decided     the graph already holds a ruling — measures AVOIDED REWORK\n" +
    'Run both kinds before drawing any conclusion. --report=<dir> to re-print a finished run.');
  process.exit(1);
}
if (!['greenfield', 'decided'].includes(kind)) { console.error(`--kind must be greenfield or decided`); process.exit(1); }
if (!existsSync(taskFile)) { console.error(`No task spec at ${taskFile}`); process.exit(1); }

const task = readFileSync(taskFile, 'utf8');
const taskHash = createHash('sha256').update(task).digest('hex').slice(0, 12);
const baseSha = git(['rev-parse', base]);
const tax = fixedTax();

if (!RUN) {
  console.log(`\nA/B graph benchmark — DRY RUN (nothing created)\n`);
  console.log(`task        ${taskFile}  (${tokens(task)} tokens, sha ${taskHash})`);
  console.log(`kind        ${kind}${kind === 'greenfield' ? '  — measures the graph as pure overhead' : '  — measures avoided rework'}`);
  console.log(`base        ${baseSha.slice(0, 12)}`);
  console.log(`model       ${model}     repeat  ${repeat}`);
  console.log(`\nCONTROL arm  worktree with these removed: ${CONTROL_STRIP.join(', ')}`);
  console.log(`             claude -p --strict-mcp-config  (no MCP servers at all)`);
  console.log(`GRAPH arm    worktree as-is: CLAUDE.md + reckons MCP attached`);
  console.log(`\nfixed tax the graph arm pays first: CLAUDE.md ${k(tax.claudeMd)} tokens, HANDOFF.md ${k(tax.handoff)} tokens`);
  if (git(['status', '--porcelain']).trim()) {
    console.log(`\n⚠  WORKING TREE IS DIRTY. Worktrees branch from ${base}, so uncommitted work is`);
    console.log(`   NOT included in either arm — both arms would build against committed state.`);
    console.log(`   Commit first if the task depends on your current changes.`);
  }
  console.log(`\nRe-run with --run to execute. Both arms run unattended with`);
  console.log(`--dangerously-skip-permissions inside throwaway worktrees.\n`);
  process.exit(0);
}

const runId = `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${taskHash}`;
const outRoot = path.join('.ab', runId);
mkdirSync(outRoot, { recursive: true });
const wtRoot = path.resolve('..', `reckons-ab-${runId}`);

const allMetrics: Metrics[] = [];
for (let i = 0; i < repeat; i++) {
  for (const arm of ['control', 'graph'] as const) {
    const wt = path.join(wtRoot, `${arm}-${i}`);
    const branch = `ab/${runId}/${arm}-${i}`;
    console.log(`→ ${arm} #${i}: worktree ${wt}`);
    git(['worktree', 'add', '-b', branch, wt, baseSha]);
    const dir = repeat > 1 ? path.join(outRoot, String(i)) : outRoot;
    mkdirSync(dir, { recursive: true });
    const m = runArm(arm, wt, task, dir);
    allMetrics.push({ ...m, arm: repeat > 1 ? `${arm}-${i}` : arm });
    console.log(`  done: ${m.requests} requests, weighted ${k(m.weighted)}, exit ${m.exitCode}`);
  }
}

writeFileSync(path.join(outRoot, 'meta.json'), JSON.stringify({ runId, taskFile, taskHash, kind, model, base: baseSha, repeat, tax, worktrees: wtRoot, createdAt: new Date().toISOString() }, null, 2));
writeFileSync(path.join(outRoot, 'metrics.json'), JSON.stringify(allMetrics, null, 2));
report(outRoot);
console.log(`Worktrees kept at ${wtRoot} so the diffs can be inspected and run.`);
console.log(`Remove with: git worktree remove <path> --force  (per arm)\n`);
