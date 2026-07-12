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
 */
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Relative Opus token weights (input=1): output is dear, cache-read is cheap.
const W = { input: 1, cacheW: 1.25, cacheR: 0.1, output: 5 };

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const top = Number(flag('top') ?? 0);
const dir = flag('path') ?? path.join(homedir(), '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));

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
console.log(`Offloading fresh input + output to local models is what moves 'weighted' down.\n`);
