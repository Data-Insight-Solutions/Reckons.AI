#!/usr/bin/env npx tsx
/**
 * Context composition — what is actually filling the context window, and what it
 * costs to CARRY.
 *
 * scripts/session-tokens.ts reports the bill (kb:session-tokens, F74.4). It does not
 * say what the bill is FOR, and its closing advice — "offloading fresh input + output
 * is what moves weighted down" — is falsified by its own totals on this project:
 * fresh input is ~39K against ~412M weighted. The cost is cache READS, i.e. re-reading
 * accumulated context on every turn (kb:context-engine, F135).
 *
 * So this script measures the thing that drives cache reads: CARRY COST.
 *
 *   A block entering context at turn t is re-read on every request after t.
 *   carry(block) = tokens(block) x requests_remaining_after_t
 *
 * A 6k-token file read on turn 5 of a 300-request session costs ~1.8M cache-read
 * tokens; the same grounding as a 600-token kb_compress slice costs ~180K. That
 * ratio — not the one-shot size — is the argument for graph queries over file reads.
 *
 * Deterministic, zero tokens, zero triage (F74.3 script tier).
 *
 * Usage:
 *   npx tsx scripts/offline/context-composition.ts
 *   npx tsx scripts/offline/context-composition.ts --top=15
 *   npx tsx scripts/offline/context-composition.ts --session=dc510df2
 *   npx tsx scripts/offline/context-composition.ts --json
 *   npx tsx scripts/offline/context-composition.ts --projects   cross-project baseline
 *
 * HONEST LIMITS (read before quoting a number):
 *  - Carry cost is MODELLED, not billed. It assumes every prior block is re-sent on
 *    every subsequent request. Real caching, compaction and prompt-prefix reuse make
 *    the true figure lower. The script prints modelled-vs-measured cache reads so the
 *    gap is visible rather than hidden; treat the ratios as the signal, not the totals.
 *  - Tokens are the project convention words*1.33 (mcp-server estimateTokens, mirrored
 *    in prompt-audit.ts). Real tokenization differs, notably for code and JSON.
 *  - Images are counted as blocks but their token cost is not modelled.
 */
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/** Project convention: ~1.33 tokens per word (mcp-server/src/index.ts estimateTokens). */
const tokens = (s: string) => Math.round(s.split(/\s+/).filter(Boolean).length * 1.33);

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const JSON_OUT = args.includes('--json');
const top = Number(flag('top') ?? 12);
const only = flag('session');
const dir = flag('path') ?? path.join(homedir(), '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));

type Block = {
  category: string;   // human | assistant-text | thinking | tool-params | tool-result
  label: string;      // tool name, or the category, for grouping
  detail: string;     // file path / command / query — what to actually go fix
  tokens: number;
  reqIndex: number;   // how many billed requests had happened when this entered
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? (c.text ?? '') : ''))
      .join('\n');
  }
  return '';
}

/** What did this call actually touch? The bit a human needs to act on it. */
function detailOf(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const first = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
    return '';
  };
  const d = first('file_path', 'notebook_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'entity', 'skill');
  return d.replace(/\s+/g, ' ').slice(0, 68);
}

type Session = {
  id: string;
  date: string;
  requests: number;
  blocks: Block[];
  measured: { input: number; cacheW: number; cacheR: number; output: number };
};

function parseSession(file: string): Session | null {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks: Block[] = [];
  const toolName = new Map<string, { name: string; detail: string }>();
  const measured = { input: 0, cacheW: 0, cacheR: 0, output: 0 };
  const ts: string[] = [];
  let requests = 0;

  for (const line of lines) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.timestamp) ts.push(o.timestamp);

    // A compaction resets the carried context; everything before it stops being re-read.
    if (o?.isCompactSummary) { blocks.length = 0; }

    const m = o?.message;
    if (!m) continue;

    const u = m.usage;
    if (u) {
      measured.input += u.input_tokens ?? 0;
      measured.cacheW += u.cache_creation_input_tokens ?? 0;
      measured.cacheR += u.cache_read_input_tokens ?? 0;
      measured.output += u.output_tokens ?? 0;
      requests++;
    }

    const content = m.content;
    if (typeof content === 'string') {
      if (content.trim()) blocks.push({ category: 'human', label: 'human', detail: '', tokens: tokens(content), reqIndex: requests });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const b of content as any[]) {
      if (b?.type === 'text') {
        const t = tokens(b.text ?? '');
        if (!t) continue;
        const isUser = m.role === 'user';
        blocks.push({
          category: isUser ? 'human' : 'assistant-text',
          label: isUser ? 'human' : 'assistant-text',
          detail: '', tokens: t, reqIndex: requests,
        });
      } else if (b?.type === 'thinking') {
        const t = tokens(b.thinking ?? '');
        if (t) blocks.push({ category: 'thinking', label: 'thinking', detail: '', tokens: t, reqIndex: requests });
      } else if (b?.type === 'tool_use') {
        const detail = detailOf(b.name, b.input);
        toolName.set(b.id, { name: b.name ?? '?', detail });
        const t = tokens(JSON.stringify(b.input ?? {}));
        if (t) blocks.push({ category: 'tool-params', label: b.name ?? '?', detail, tokens: t, reqIndex: requests });
      } else if (b?.type === 'tool_result') {
        const meta = toolName.get(b.tool_use_id) ?? { name: 'unknown', detail: '' };
        const t = tokens(textOf(b.content));
        if (t) blocks.push({ category: 'tool-result', label: meta.name, detail: meta.detail, tokens: t, reqIndex: requests });
      }
    }
  }

  if (!requests) return null;
  return { id: path.basename(file).slice(0, 8), date: (ts.sort()[0] ?? '?').slice(0, 10), requests, blocks, measured };
}

const k = (n: number) => (n < 1_000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(1)}K` : `${(n / 1e6).toFixed(1)}M`);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '0%');

/**
 * Cross-project baseline. The graph's own kb:graph-economics says the honest weakness
 * of every saving claim here is "compared to what?" — there is no control repo. This is
 * the closest available answer: the same user, same tool, same models, on other
 * codebases with no Reckons MCP attached. It is a WEAK baseline (few sessions, short
 * ones) and the report says so rather than implying a controlled experiment.
 */
function compareProjects(): void {
  const root = path.join(homedir(), '.claude', 'projects');
  type P = { name: string; sessions: number; requests: number; ctxPerReq: number; peak: number; output: number };
  const rows: P[] = [];
  for (const d of readdirSync(root)) {
    const pdir = path.join(root, d);
    let requests = 0, ctx = 0, peak = 0, output = 0, sessions = 0;
    let entries: string[];
    try { entries = readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of entries) {
      let had = false;
      for (const line of readFileSync(path.join(pdir, f), 'utf8').split('\n')) {
        if (!line) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        const u = o?.message?.usage; if (!u) continue;
        had = true;
        const c = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (c > peak) peak = c;
        ctx += c; requests++; output += u.output_tokens ?? 0;
      }
      if (had) sessions++;
    }
    if (requests) rows.push({ name: d.replace('-home-matt-Github-', '').replace('-home-matt', '~').slice(0, 34), sessions, requests, ctxPerReq: ctx / requests, peak, output });
  }
  rows.sort((a, b) => b.requests - a.requests);

  if (JSON_OUT) { console.log(JSON.stringify({ projects: rows }, null, 2)); return; }

  console.log(`\nCross-project baseline — context carried per request`);
  console.log(`(same user, same tool; only this repo has the Reckons MCP attached)\n`);
  console.log(`${'project'.padEnd(36)}${'sess'.padStart(5)}${'reqs'.padStart(7)}${'ctx/req'.padStart(10)}${'peak ctx'.padStart(11)}`);
  console.log('-'.repeat(69));
  for (const r of rows) {
    console.log(`${r.name.padEnd(36)}${String(r.sessions).padStart(5)}${String(r.requests).padStart(7)}${k(r.ctxPerReq).padStart(10)}${k(r.peak).padStart(11)}`);
  }
  const here = rows.find((r) => r.name.includes('tripleNotes'));
  const others = rows.filter((r) => !r.name.includes('tripleNotes') && r.requests >= 20);
  if (here && others.length) {
    const base = others.reduce((n, r) => n + r.ctxPerReq, 0) / others.length;
    console.log('-'.repeat(69));
    console.log(`\nthis repo   ${k(here.ctxPerReq)} / request   (peak ${k(here.peak)})`);
    console.log(`baseline    ${k(base)} / request   from ${others.length} project(s) with >=20 requests`);
    console.log(`ratio       ${(here.ctxPerReq / base).toFixed(1)}x`);
  }
  console.log(
    `\nHONEST LIMIT: this is not a controlled comparison and must not be quoted as one.\n` +
    `The baseline projects are short sessions of different work, n is tiny, and a larger\n` +
    `context WINDOW invites a larger context — part of any gap is capacity, not waste.\n` +
    `What it does establish is a floor: ordinary Claude Code work on this machine runs an\n` +
    `order of magnitude leaner than this repo does, so the graph is not currently making\n` +
    `these sessions cheap. Per-query compression savings (kb:context-compression) are a\n` +
    `separate, separately-measured claim and this neither confirms nor refutes them.\n`
  );
}

if (args.includes('--projects')) { compareProjects(); process.exit(0); }

let files: string[];
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
} catch {
  console.error(`No transcripts at ${dir}\nPass --path=<dir> if your logs live elsewhere.`);
  process.exit(1);
}
if (only) files = files.filter((f) => path.basename(f).startsWith(only));

const sessions = files.map(parseSession).filter((s): s is Session => !!s);
if (!sessions.length) { console.error('No sessions parsed.'); process.exit(1); }

// ---- aggregate ------------------------------------------------------------
type Agg = { size: number; carry: number; count: number };
const byCategory = new Map<string, Agg>();
const byLabel = new Map<string, Agg>();
const byDetail = new Map<string, Agg & { label: string }>();
let totalSize = 0, totalCarry = 0;
const measured = { input: 0, cacheW: 0, cacheR: 0, output: 0 };

for (const s of sessions) {
  measured.input += s.measured.input; measured.cacheW += s.measured.cacheW;
  measured.cacheR += s.measured.cacheR; measured.output += s.measured.output;
  for (const b of s.blocks) {
    const carry = b.tokens * Math.max(0, s.requests - b.reqIndex);
    totalSize += b.tokens; totalCarry += carry;
    const bump = (m: Map<string, Agg>, key: string) => {
      const a = m.get(key) ?? { size: 0, carry: 0, count: 0 };
      a.size += b.tokens; a.carry += carry; a.count++; m.set(key, a);
    };
    bump(byCategory, b.category);
    bump(byLabel, b.category === 'tool-result' ? `tool-result:${b.label}` : b.category);
    if (b.category === 'tool-result' && b.detail) {
      const key = `${b.label} ${b.detail}`;
      const a = byDetail.get(key) ?? { size: 0, carry: 0, count: 0, label: b.label };
      a.size += b.tokens; a.carry += carry; a.count++; byDetail.set(key, a);
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    sessions: sessions.length, totalSize, totalCarry, measured,
    byCategory: Object.fromEntries(byCategory),
    byLabel: Object.fromEntries(byLabel),
    topCarriers: [...byDetail.entries()].sort((a, b) => b[1].carry - a[1].carry).slice(0, top)
      .map(([key, v]) => ({ key, ...v })),
  }, null, 2));
  process.exit(0);
}

console.log(`\nContext composition — ${dir.replace(homedir(), '~')}`);
console.log(`${sessions.length} session(s), ${sessions.reduce((n, s) => n + s.requests, 0)} billed requests\n`);

console.log('WHAT FILLS THE CONTEXT            share of context   share of CARRY COST');
console.log('-'.repeat(76));
const rows = [...byLabel.entries()].sort((a, b) => b[1].carry - a[1].carry);
for (const [label, a] of rows) {
  if (a.carry / totalCarry < 0.002 && a.size / totalSize < 0.002) continue;
  console.log(
    `${label.padEnd(32)}${(k(a.size) + ' ' + pct(a.size, totalSize)).padStart(17)}${(k(a.carry) + ' ' + pct(a.carry, totalCarry)).padStart(22)}`
  );
}
console.log('-'.repeat(76));
console.log(`${'TOTAL'.padEnd(32)}${k(totalSize).padStart(17)}${k(totalCarry).padStart(22)}`);

console.log(`\nTOP CARRIERS — single calls whose output is re-read the most`);
console.log('-'.repeat(76));
console.log(`${'carry'.padStart(8)}${'  size'.padStart(8)}${'  n'.padStart(4)}  what`);
for (const [key, v] of [...byDetail.entries()].sort((a, b) => b[1].carry - a[1].carry).slice(0, top)) {
  console.log(`${k(v.carry).padStart(8)}${k(v.size).padStart(8)}${String(v.count).padStart(4)}  ${key.slice(0, 56)}`);
}

// Honest calibration: modelled carry vs the cache reads actually billed.
console.log(`\nCALIBRATION (modelled vs billed)`);
console.log('-'.repeat(76));
console.log(`modelled carry cost      ${k(totalCarry).padStart(10)}`);
console.log(`billed cache reads       ${k(measured.cacheR).padStart(10)}`);
const ratio = measured.cacheR ? totalCarry / measured.cacheR : 0;
console.log(`ratio                    ${ratio.toFixed(2).padStart(10)}   (1.0 = model matches the bill)`);
console.log(
  ratio > 1.5 || ratio < 0.5
    ? `\n  The model and the bill disagree by more than 2x. Compaction, prompt-prefix\n  reuse and tokenizer differences all push these apart. Use the SHARES above —\n  they are ratios within one consistent model — and do not quote the totals.\n`
    : `\n  Model and bill are within 2x, so the shares above are a fair read on where\n  the cache-read bill goes.\n`
);
