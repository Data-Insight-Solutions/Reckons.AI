#!/usr/bin/env npx tsx
/**
 * Graph economics ledger (F74.5, SCRIPT tier) — does the graph actually pay for itself?
 *
 * The project asserts it does. Only the CREDIT side was ever measured:
 * kb:agent-context-dogfooding carries real per-query numbers (and already corrects an
 * earlier overstatement that conflated encoding with subgraph selection), but its
 * headline 80-90% figure is explicitly an ESTIMATE, taken in a session where the MCP
 * was not even connected. The DEBIT side has never been counted at all.
 *
 * A saving claimed without its cost is not a measurement, it is marketing. This script
 * assembles both sides and prints the break-even. Deterministic, no model, zero tokens,
 * zero triage — right by construction (F74.3).
 *
 * THREE THINGS IT DELIBERATELY WILL NOT DO:
 *   1. Claim causation. Cohesion improves for many reasons and there is no control repo
 *      built without a graph. n=1. It reports trend + attributed events, never "the graph
 *      caused this".
 *   2. Invent an avoided-rework count. That is likely the LARGEST benefit and cannot be
 *      derived from git, so it is read from a hand-cited ledger. A fabricated automatic
 *      number would be worse than none.
 *   3. Hide the triage cost of agent-tier proposals. It is real (F74.3 says so) and not
 *      derivable here, so it is reported as UNMEASURED rather than silently omitted.
 *
 * Usage:
 *   npx tsx scripts/offline/graph-economics.ts
 *   npx tsx scripts/offline/graph-economics.ts --json
 *   npx tsx scripts/offline/graph-economics.ts --since=2026-05-01
 */
import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
/**
 * `--since=` is interpolated into git command STRINGS below (sh() runs through a shell), so an
 * unvalidated value is command injection via argv — `--since='x"; rm -rf ~; #'`. It is only ever
 * a git approxidate, so hold it to that shape rather than reaching for quoting, which is easy to
 * get subtly wrong. Same posture as sanitizeRef in mcp-server/src/git-utils.ts: refuse implausible
 * input loudly instead of passing it to a shell. (CodeQL js/indirect-command-line-injection.)
 */
function safeSince(v: string): string {
  if (!/^[A-Za-z0-9 :._-]{1,40}$/.test(v)) {
    throw new Error(`--since must be a plain date or approxidate (got: ${JSON.stringify(v)})`);
  }
  return v;
}
const SINCE = safeSince(flag('since') ?? '2026-05-01');

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';

/** Project convention: ~1.33 tokens per word (mcp-server/src/index.ts estimateTokens,
 *  mirrored at scripts/offline/prompt-audit.ts:27). Used everywhere here so figures stay
 *  comparable with the compression bench. */
const tokens = (s: string) => Math.round(s.split(/\s+/).filter(Boolean).length * 1.33);
const sh = (cmd: string) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const k = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1e6).toFixed(2)}M`);

// ─────────────────────────────────────────────────────────────────────────────
// CORPUS — the graph as it stands today
// ─────────────────────────────────────────────────────────────────────────────
const ttlFiles = readdirSync('static').filter((f) => f.endsWith('.ttl')).map((f) => path.join('static', f));
let corpusTokens = 0, corpusLines = 0, corpusBytes = 0;
for (const f of ttlFiles) {
  const src = readFileSync(f, 'utf8');
  corpusTokens += tokens(src);
  corpusLines += src.split('\n').length;
  corpusBytes += Buffer.byteLength(src);
}
/** Tokens per line of TTL — lets git's --numstat line counts become a token estimate
 *  without replaying every diff. Approximation, and labelled as one in the output. */
const tokensPerLine = corpusTokens / Math.max(1, corpusLines);

// ─────────────────────────────────────────────────────────────────────────────
// DEBIT 1 — TTL authoring and maintenance churn
// ─────────────────────────────────────────────────────────────────────────────
interface Churn { commits: number; added: number; removed: number }
function churn(since: string, paths: string, until?: string): Churn {
  const u = until ? ` --until="${until}"` : '';
  const raw = sh(`git log --since="${since}"${u} --numstat --pretty=format:C -- ${paths} || true`);
  let commits = 0, added = 0, removed = 0;
  for (const line of raw.split('\n')) {
    if (line === 'C') { commits++; continue; }
    const m = line.match(/^(\d+)\t(\d+)\t/);
    if (m) { added += Number(m[1]); removed += Number(m[2]); }
  }
  return { commits, added, removed };
}
const ttlChurn = churn(SINCE, "'static/*.ttl'");
const allCommits = Number(sh(`git log --since="${SINCE}" --oneline | wc -l`));
/** Authoring cost ~ tokens WRITTEN. Removed lines are not free either (they were written
 *  once and deleted deliberately), so both count — churn, not net growth. */
const ttlChurnTokens = Math.round((ttlChurn.added + ttlChurn.removed) * tokensPerLine);

// ─────────────────────────────────────────────────────────────────────────────
// DEBIT 2 — MCP tool-schema tax
// ─────────────────────────────────────────────────────────────────────────────
/** Every kb_* tool definition (name + description + input schema) is prompt text. In EAGER
 *  mode an agent pays it on every request of the session; in DEFERRED mode (ToolSearch) it
 *  pays only for what it fetches. The two give very different break-evens, so both are shown. */
function toolSchemaTokens(): { count: number; tokens: number } {
  const idx = 'mcp-server/src/index.ts';
  if (!existsSync(idx)) return { count: 0, tokens: 0 };
  const src = readFileSync(idx, 'utf8');
  // Tool definitions are object literals carrying a kb_-prefixed name and a description.
  const blocks = src.split(/name:\s*['"`]kb_/).slice(1);
  let total = 0;
  for (const b of blocks) {
    // Take up to the end of this tool's inputSchema block — bounded, so a parse miss
    // under-counts rather than swallowing the rest of the file.
    total += tokens(b.slice(0, 2000));
  }
  return { count: blocks.length, tokens: total };
}
const toolTax = toolSchemaTokens();

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT — compressed subgraph vs raw corpus, per query
// ─────────────────────────────────────────────────────────────────────────────
/** kb_compress default budget (mcp-server: default 2000, max 8000). */
const COMPRESS_BUDGET = 2000;

/** THE BASELINE IS THE WHOLE ARGUMENT, so two are reported and the flattering one is
 *  labelled unrealistic.
 *
 *  vs-CORPUS is an upper bound only: it assumes the alternative is reading all 23 TTL
 *  files every query. Nobody does that. Quoting it as "the" saving is exactly the error
 *  kb:agent-context-dogfooding was CORRECTED for on 2026-07-12 (conflating a favourable
 *  ratio with the real one), so it is shown as a ceiling and never used for break-even.
 *
 *  vs-EXPLORATION is the honest counterfactual: what an agent actually burns re-reading
 *  code and re-deriving the plan. F68 estimates 30-60k tokens/feature. That is an ESTIMATE,
 *  not a measurement — it is the weakest link in this ledger and is flagged as such. */
const EXPLORATION_BASELINE = Number(flag('baseline') ?? 30000); // F68 low end, conservative
const savingVsCorpus = corpusTokens - COMPRESS_BUDGET;          // ceiling, not used below
const savingPerQuery = EXPLORATION_BASELINE - COMPRESS_BUDGET;  // the defensible one
const compressionRatio = corpusTokens / COMPRESS_BUDGET;

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT — avoided rework (hand-cited ledger; never fabricated)
// ─────────────────────────────────────────────────────────────────────────────
interface AvoidedEntry { date?: string; entity?: string; avoided?: string; est_tokens?: number; note?: string }
const LEDGER = 'reckons-workspace/graph-economics.jsonl';
const avoided: AvoidedEntry[] = existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
  : [];
const avoidedTokens = avoided.reduce((a, e) => a + (e.est_tokens ?? 0), 0);

// ─────────────────────────────────────────────────────────────────────────────
// COHESION — extend-vs-add, the direct measure of "enhanced it instead of duplicating it"
// ─────────────────────────────────────────────────────────────────────────────
/** Lines landing in files that ALREADY existed vs lines landing in files created by that
 *  same commit. A codebase steered by a plan should trend toward extending. This is a
 *  TREND, not proof: refactors, review and taste move it too, and there is no control repo. */
function extendVsAdd(since: string): { extended: number; created: number; newFiles: number } {
  const PATHS = 'src mcp-server/src scripts cli';
  // PER-COMMIT attribution. A naive "every file ever created in the window" set is wrong:
  // a file created in May and extended in July would count its July lines as new-file lines,
  // collapsing the metric toward 0% extended. Classify each commit's lines against the files
  // THAT COMMIT created.
  const createdBy = new Map<string, Set<string>>();
  let cur = '';
  for (const line of sh(`git log --since="${since}" --diff-filter=A --name-only --pretty=format:C%H -- ${PATHS} || true`).split('\n')) {
    if (line.startsWith('C')) { cur = line.slice(1); createdBy.set(cur, new Set()); continue; }
    if (line.trim() && cur) createdBy.get(cur)!.add(line.trim());
  }
  let ext = 0, add = 0, newFiles = 0;
  cur = '';
  for (const line of sh(`git log --since="${since}" --numstat --pretty=format:C%H -- ${PATHS} || true`).split('\n')) {
    if (line.startsWith('C')) { cur = line.slice(1); continue; }
    const m = line.match(/^(\d+)\t\d+\t(.+)$/);
    if (!m) continue;
    if (createdBy.get(cur)?.has(m[2])) add += Number(m[1]); else ext += Number(m[1]);
  }
  for (const s of createdBy.values()) newFiles += s.size;
  return { extended: ext, created: add, newFiles };
}
const cohesion = extendVsAdd(SINCE);
const extendShare = cohesion.extended / Math.max(1, cohesion.extended + cohesion.created);

// ─────────────────────────────────────────────────────────────────────────────
// COMPOUNDING — walk history monthly: does corpus grow while churn per triple falls?
// ─────────────────────────────────────────────────────────────────────────────
interface MonthRow { month: string; corpusBytes: number; churnLines: number }
function monthly(since: string): MonthRow[] {
  const months = [...new Set(sh(`git log --since="${since}" --format=%ad --date=format:%Y-%m`).split('\n').filter(Boolean))].sort();
  const rows: MonthRow[] = [];
  for (const m of months) {
    // Compute the month boundary in JS — git's date parser does not accept "+1 month" here,
    // which silently yielded an empty sha and a 0-byte corpus for every row.
    const [y, mo] = m.split('-').map(Number);
    const end = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`;
    let bytes = 0;
    try {
      const sha = sh(`git rev-list -1 --before="${end}" HEAD || true`);
      if (sha) {
        const tree = sh(`git ls-tree -r --long ${sha} -- static || true`);
        for (const l of tree.split('\n')) {
          if (!l.endsWith('.ttl')) continue;
          const mm = l.match(/blob\s+\w+\s+(\d+)\t/);
          if (mm) bytes += Number(mm[1]);
        }
      }
    } catch { /* month predates the tree; leave 0 */ }
    // Churn WITHIN this month only — bounded by --since/--until, not by subtracting a running total.
    const c = churn(`${m}-01`, "'static/*.ttl'", end);
    rows.push({ month: m, corpusBytes: bytes, churnLines: c.added + c.removed });
  }
  return rows;
}
const curve = monthly(SINCE);

// ─────────────────────────────────────────────────────────────────────────────
// BREAK-EVEN
// ─────────────────────────────────────────────────────────────────────────────
const breakEven = (debit: number) => (savingPerQuery > 0 ? Math.ceil(debit / savingPerQuery) : Infinity);
const beDeferred = breakEven(ttlChurnTokens + toolTax.tokens);          // schema fetched once
const beEager = breakEven(ttlChurnTokens);                              // + per-request tax below

const report = {
  since: SINCE,
  corpus: { files: ttlFiles.length, tokens: corpusTokens, lines: corpusLines, bytes: corpusBytes, tokensPerLine: Number(tokensPerLine.toFixed(2)) },
  debit: {
    ttlChurn: { ...ttlChurn, estTokens: ttlChurnTokens, shareOfAllCommits: Number((ttlChurn.commits / Math.max(1, allCommits)).toFixed(3)) },
    toolSchema: { tools: toolTax.count, tokensPerLoad: toolTax.tokens },
    triageCost: 'UNMEASURED — agent-tier proposal triage is a real cost (F74.3) and is not derivable from git.',
  },
  credit: {
    savingPerQuery, explorationBaseline: EXPLORATION_BASELINE,
    baselineCaveat: 'ESTIMATE — F68 puts re-exploration at 30-60k tokens/feature; never measured. Weakest link in this ledger.',
    savingVsCorpusCeiling: savingVsCorpus, compressionRatio: Number(compressionRatio.toFixed(1)), compressBudget: COMPRESS_BUDGET,
    avoidedRework: { entries: avoided.length, estTokens: avoidedTokens },
  },
  cohesion: { ...cohesion, extendShare: Number(extendShare.toFixed(3)) },
  breakEven: { deferredMode: beDeferred, eagerMode: beEager },
  curve,
  caveat: 'Correlational. No control repo exists, n=1; cohesion moves for many reasons. Attributed events, not causation.',
};

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

console.log(`\n${B}Graph economics ledger${X} ${D}— since ${SINCE}${X}`);
console.log(`${D}corpus: ${ttlFiles.length} TTL files, ${k(corpusTokens)} tokens, ${k(corpusBytes)} bytes (~${tokensPerLine.toFixed(1)} tok/line)${X}\n`);

console.log(`${B}${Y}DEBIT${X} ${D}— what the graph costs${X}`);
console.log(`  TTL churn        ${ttlChurn.commits} commits of ${allCommits} (${((ttlChurn.commits / Math.max(1, allCommits)) * 100).toFixed(0)}% of all commits)`);
console.log(`                   +${k(ttlChurn.added)} / -${k(ttlChurn.removed)} lines  ≈ ${k(ttlChurnTokens)} tokens written ${D}(estimated via tok/line)${X}`);
console.log(`  MCP tool schema  ${toolTax.count} kb_* tools ≈ ${k(toolTax.tokens)} tokens per load`);
console.log(`                   ${D}eager: paid EVERY request · deferred (ToolSearch): paid once${X}`);
console.log(`  ${Y}triage${X}           ${D}UNMEASURED — real (F74.3), not derivable from git. Declared, not omitted.${X}\n`);

console.log(`${B}${G}CREDIT${X} ${D}— what the graph saves${X}`);
console.log(`  per query        ${k(savingPerQuery)} tokens ${D}(baseline ${k(EXPLORATION_BASELINE)} re-exploration − ${k(COMPRESS_BUDGET)} compressed)${X}`);
console.log(`  ${Y}baseline is an ESTIMATE${X} ${D}— F68's 30-60k/feature, never measured. Weakest link here.${X}`);
console.log(`  ${D}ceiling only: ${k(savingVsCorpus)} (${compressionRatio.toFixed(0)}x) vs reading all ${ttlFiles.length} TTL files — unrealistic, not used for break-even${X}`);
console.log(`  avoided rework   ${avoided.length} cited entr${avoided.length === 1 ? 'y' : 'ies'}${avoidedTokens ? ` ≈ ${k(avoidedTokens)} tokens` : ''}`);
if (!avoided.length) console.log(`                   ${D}ledger empty at ${LEDGER} — never auto-counted, only cited${X}`);
for (const e of avoided.slice(0, 5)) console.log(`                   ${D}· ${e.date ?? '?'} ${e.avoided ?? ''} ${C}via ${e.entity ?? '?'}${X}`);
console.log('');

console.log(`${B}${C}COHESION${X} ${D}— extended existing code vs added new files${X}`);
console.log(`  ${(extendShare * 100).toFixed(1)}% of added lines landed in files that already existed`);
console.log(`  ${D}${k(cohesion.extended)} extended · ${k(cohesion.created)} in ${cohesion.newFiles} new files${X}\n`);

console.log(`${B}BREAK-EVEN${X}`);
console.log(`  deferred (ToolSearch)  ${beDeferred} queries to repay ${k(ttlChurnTokens + toolTax.tokens)} tokens`);
console.log(`  eager (all tools)      ${beEager} queries + ${k(toolTax.tokens)}/request standing tax\n`);

if (curve.length > 1) {
  console.log(`${B}COMPOUNDING${X} ${D}— does maintenance cost per unit of graph FALL as the graph grows?${X}`);
  for (const r of curve) {
    const perKb = r.corpusBytes ? (r.churnLines / (r.corpusBytes / 1024)) : 0;
    console.log(`  ${r.month}  corpus ${String(k(r.corpusBytes)).padStart(6)}  churn ${String(k(r.churnLines)).padStart(6)} lines  ${D}${perKb.toFixed(2)} lines/KB${X}`);
  }
  const first = curve.find((r) => r.corpusBytes), last = [...curve].reverse().find((r) => r.corpusBytes);
  if (first && last && first !== last) {
    const a = first.churnLines / (first.corpusBytes / 1024), b = last.churnLines / (last.corpusBytes / 1024);
    console.log(`  ${b < a ? G + 'compounding' : Y + 'no compounding yet'}${X}: ${a.toFixed(2)} -> ${b.toFixed(2)} lines/KB ${D}(${b < a ? 'falling — the graph costs less per unit to keep' : 'flat or rising — maintenance is scaling with size'})${X}`);
  }
  console.log(`  ${D}n=${curve.length} months. Too few points to call a trend; this is a baseline to watch.${X}`);
  console.log('');
}

console.log(`${Y}CAVEAT${X} ${D}${report.caveat}${X}`);
console.log(`${D}Correlation and cited events. Not a causal claim — there is no repo built without a graph to compare against.${X}\n`);
