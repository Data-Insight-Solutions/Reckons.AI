#!/usr/bin/env npx tsx
/**
 * Session token usage — dogfooding metric for the local-offload work.
 *
 * Parses this project's Claude Code transcripts (~/.claude/projects/<slug>/*.jsonl)
 * and reports per-session token usage. Run it before/after moving work to local
 * models to SEE the fresh-input + output lines drop (cache-read is the cheap tier,
 * so it's the fresh input + output that actually consumes budget / working time).
 *
 * A rough Opus cost-weight ranks sessions by real consumption and flags the
 * expensive "no-cache" sessions (lots of fresh input, little cache reuse).
 *
 * Usage:
 *   npm run session:tokens              this project, newest last
 *   npm run session:tokens -- --top=10  only the 10 heaviest sessions
 *   npm run session:tokens -- --path=/abs/dir/to/*.jsonl
 *   npm run session:tokens -- --by=branch [--since=ISO] [--until=ISO] [--top=N]
 *   npm run session:tokens -- --calibrate        tasks per week (needs >=2 recorded percents)
 *   npm run session:tokens -- --record=<percent> record Claude Code's weekly usage % now
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { resolveTranscriptDir } from './lib/transcript-dir';
import {
  FAMILIES, attributeByBranch, calibrationWindow, cleanCalibration, dedupeEntries, entryFromLine,
  filterWindow, groupTasksPerWeek, taskCosts, tokensPerPercent, type Entry
} from './lib/usage-attribution';

// Relative Opus token weights (input=1): output is dear, cache-read is cheap.
const W = { input: 1, cacheW: 1.25, cacheR: 0.1, output: 5 };

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const top = Number(flag('top') ?? 0);
const dir = flag('path') ?? resolveTranscriptDir();

const since = flag('since');
const until = flag('until');
const calibPath = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'reckons', 'usage-calibration.json');

function readCalibration(): unknown[] {
  try { return JSON.parse(readFileSync(calibPath, 'utf8')); } catch { return []; }
}

if (flag('record') !== undefined) {
  const pct = Number(flag('record'));
  if (!Number.isFinite(pct) || pct < 0) { console.error('--record=<percent> needs a number, e.g. --record=37'); process.exit(1); }
  mkdirSync(path.dirname(calibPath), { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  const all = [...readCalibration(), { at, weeklyPercent: pct }];
  writeFileSync(calibPath, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  chmodSync(calibPath, 0o600);
  console.log(`Recorded ${pct}% at ${at} (${all.length} entries) in the private calibration file.`);
  process.exit(0);
}

/** Every *.jsonl under dir, recursively: subagent transcripts live in <session>/subagents/. */
function walk(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    return e.isDirectory() ? walk(f) : f.endsWith('.jsonl') ? [f] : [];
  });
}

function loadEntries(): Entry[] {
  let fs: string[];
  try { fs = walk(dir); } catch { console.error(`No transcripts at ${dir}\nPass --path=<dir> if your logs live elsewhere.`); process.exit(1); }
  const out: Entry[] = [];
  for (const f of fs) for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const e = entryFromLine(o);
    if (e) out.push(e);
  }
  return filterWindow(dedupeEntries(out), since, until);
}

const kk = (n: number) => (n < 1e6 ? `${Math.round(n / 1000)}K` : `${(n / 1e6).toFixed(1)}M`);

if (flag('by') === 'branch' || args.includes('--calibrate')) {
  const entries = loadEntries();
  const window = `${since ?? 'start'} .. ${until ?? 'now'}`;
  if (flag('by') === 'branch') {
    let rows = attributeByBranch(entries);
    const grand = rows.reduce((s, r) => s + r.weighted, 0);
    if (top > 0) rows = rows.slice(0, top);
    console.log(`\nWeighted tokens by branch (deduped per response; subagents attributed to their own branch) ${window}\n`);
    console.log(`${'branch'.padEnd(46)}${'weighted'.padStart(10)}  ${FAMILIES.map((f) => f.padStart(8)).join('')}`);
    for (const r of rows) console.log(`${r.branch.slice(0, 45).padEnd(46)}${kk(r.weighted).padStart(10)}  ${FAMILIES.map((f) => kk(r.byFamily[f]).padStart(8)).join('')}`);
    console.log('-'.repeat(88));
    console.log(`${'TOTAL'.padEnd(46)}${kk(grand).padStart(10)}  ${FAMILIES.map((f) => kk(entries.filter((e) => e.family === f).reduce((s, e) => s + e.weighted, 0)).padStart(8)).join('')}\n`);
  }
  if (args.includes('--calibrate')) {
    const calib = cleanCalibration(readCalibration());
    const w = calibrationWindow(calib);
    if (!w) {
      console.log(`\nNot calibrated: need >=2 recorded usage percentages in the same week, rising.`);
      console.log(`Have ${calib.length} entr${calib.length === 1 ? 'y' : 'ies'}. Record Claude Code's weekly usage % (from its usage display) now, and again after some work:`);
      console.log(`  npm run session:tokens -- --record=<percent>`);
      console.log(`Stored privately at ${calibPath.replace(homedir(), '~')} (mode 0600). No number is guessed.\n`);
    } else {
      const tpp = tokensPerPercent(entries, w);
      const g = groupTasksPerWeek(tpp, taskCosts(entries));
      console.log(`\nCalibration ${w.from} .. ${w.to}: +${w.percentDelta}% of the weekly allowance = ${kk(tpp)} weighted tokens per 1%.`);
      console.log(`Tasks = branches prefixed feat/ fix/ chore/ test/ plan/ docs/ agent/ in ${window}; cost = weighted tokens on the branch.\n`);
      const show = (label: string, r: { tasks: number; medianWeighted: number; tasksPerWeek: number }) =>
        console.log(`${label.padEnd(10)} tasks=${String(r.tasks).padStart(3)}  median=${kk(r.medianWeighted).padStart(7)}  tasks/week=${r.tasksPerWeek.toFixed(1)}`);
      show('overall', g.overall);
      for (const r of g.byKind) show(r.key, r);
      for (const r of g.byFamily) show(`[${r.key}]`, r);
      console.log(`\nCaveats: weeks are Monday-UTC calendar weeks, not your plan's reset; per-family rows divide the SAME percent-calibrated budget by that family's median task.\n`);
    }
  }
  process.exit(0);
}

type Row = { date: string; id: string; msgs: number; input: number; cacheW: number; cacheR: number; output: number; eff: number };

function parseSession(file: string): Row | null {
  let input = 0, cacheW = 0, cacheR = 0, output = 0, msgs = 0;
  const ts: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.timestamp) ts.push(o.timestamp);
    const u = o?.message?.usage;
    if (u) {
      input += u.input_tokens ?? 0;
      cacheW += u.cache_creation_input_tokens ?? 0;
      cacheR += u.cache_read_input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      msgs++;
    }
  }
  if (!msgs) return null;
  const eff = input * W.input + cacheW * W.cacheW + cacheR * W.cacheR + output * W.output;
  return { date: (ts.sort()[0] ?? '?').slice(0, 10), id: path.basename(file).slice(0, 8), msgs, input, cacheW, cacheR, output, eff };
}

const k = (n: number) => (n < 1e6 ? `${Math.round(n / 1000)}K` : `${(n / 1e6).toFixed(1)}M`);

let files: string[];
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
} catch {
  console.error(`No transcripts at ${dir}\nPass --path=<dir> if your logs live elsewhere.`);
  process.exit(1);
}

let rows = files.map(parseSession).filter((r): r is Row => !!r);
rows.sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
if (top > 0) rows = [...rows].sort((a, b) => b.eff - a.eff).slice(0, top);

const tot = { input: 0, cacheW: 0, cacheR: 0, output: 0, eff: 0 };
console.log(`\nSession token usage — ${dir.replace(homedir(), '~')}\n`);
console.log(`${'date'.padEnd(11)}${'id'.padEnd(9)}${'msgs'.padStart(6)}${'input'.padStart(8)}${'cacheW'.padStart(8)}${'cacheR'.padStart(9)}${'output'.padStart(8)}${'weighted'.padStart(10)}  flag`);
for (const r of rows) {
  // "no-cache burn": lots of fresh input, little cache reuse → the expensive pattern.
  const noCacheBurn = r.input > 2e6 && r.cacheR < r.input;
  console.log(
    `${r.date.padEnd(11)}${r.id.padEnd(9)}${String(r.msgs).padStart(6)}${k(r.input).padStart(8)}${k(r.cacheW).padStart(8)}${k(r.cacheR).padStart(9)}${k(r.output).padStart(8)}${k(r.eff).padStart(10)}  ${noCacheBurn ? '⚠ no-cache burn' : ''}`
  );
  tot.input += r.input; tot.cacheW += r.cacheW; tot.cacheR += r.cacheR; tot.output += r.output; tot.eff += r.eff;
}
console.log('-'.repeat(78));
console.log(`${'TOTAL'.padEnd(26)}${k(tot.input).padStart(8)}${k(tot.cacheW).padStart(8)}${k(tot.cacheR).padStart(9)}${k(tot.output).padStart(8)}${k(tot.eff).padStart(10)}`);
console.log(`\nweighted = input + 1.25·cacheW + 0.1·cacheR + 5·output (rough Opus ratios).`);
// CORRECTED 2026-08-21. This line used to say offloading fresh input + output to local
// models is what moves 'weighted' down. The totals above falsify that on this project:
// fresh input is ~0% of weighted and output ~12%, while cache READS are ~72%. Tiering
// (F74.3) is still right for triage cost and hallucination - it is just not the lever on
// the bill. The lever is how much context each turn carries: see kb:context-engine (F135)
// and `npm run offline:context` for what is actually filling it.
const share = (n: number) => (tot.eff ? `${((n / tot.eff) * 100).toFixed(0)}%` : '?');
console.log(
  `fresh input ${share(tot.input * W.input)} \u00b7 cache-write ${share(tot.cacheW * W.cacheW)} \u00b7 ` +
  `cache-read ${share(tot.cacheR * W.cacheR)} \u00b7 output ${share(tot.output * W.output)} of weighted.`
);
console.log(`The big share is where the money goes. Run \`npm run offline:context\` to see what fills it.\n`);
