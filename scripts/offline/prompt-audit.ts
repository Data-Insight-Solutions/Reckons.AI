#!/usr/bin/env npx tsx
/**
 * Prompt audit (F74.3, SCRIPT tier) — how much do our system prompts cost?
 *
 * Every token in a system prompt is paid on EVERY call, forever. A 150-token
 * preamble on a 200-token extraction prompt is not a rounding error — it is a
 * ~40% tax on the smallest, most frequently fired prompt in the app.
 *
 * This measures, per prompt: total size, the ETHICS_PREAMBLE's share of it, and
 * the fixed per-call overhead. It is deterministic (no model), so it is a script,
 * and it can gate CI once a budget is set.
 *
 * Token estimate uses the project's own convention (~1.33 tokens/word — the same
 * one mcp-server/src/index.ts uses for kb_compress), so numbers are comparable to
 * the compression benchmark.
 *
 * Usage:
 *   npm run offline:prompt-audit
 *   npm run offline:prompt-audit -- --json
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const JSON_OUT = process.argv.includes('--json');

/** Project convention: ~1.33 tokens per word (mcp-server/src/index.ts estimateTokens). */
const tokens = (s: string) => Math.round(s.split(/\s+/).filter(Boolean).length * 1.33);

const ROOTS = ['src/lib', 'mcp-server/src'];
const files: string[] = [];
for (const root of ROOTS) {
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === 'node_modules' || e === '__tests__' || e === 'dist') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
    }
  })(root);
}

// The canonical preamble text, read from its source of truth.
function extractTemplate(src: string, startIdx: number): string {
  // startIdx points at the opening backtick; walk to the matching unescaped one.
  let i = startIdx + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
    if (c === '`') break;
    out += c;
    i++;
  }
  return out;
}

function preambleFrom(file: string): string {
  const src = readFileSync(file, 'utf8');
  const m = src.indexOf('ETHICS_PREAMBLE = `');
  if (m === -1) return '';
  return extractTemplate(src, src.indexOf('`', m));
}

const PREAMBLE = preambleFrom('src/lib/safety/content-policy.ts');
const MCP_PREAMBLE = preambleFrom('mcp-server/src/ethics-preamble.ts');

interface Prompt { file: string; name: string; body: string; withPreamble: boolean; runtimeInjected?: boolean; }
const prompts: Prompt[] = [];

// Find every prompt-ish string constant and every `ETHICS_PREAMBLE + \`...\`` site.
for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // a) `X = ETHICS_PREAMBLE + \`...\`` and bare `ETHICS_PREAMBLE +\n  \`...\``
  const re = /(?:(?:const|export const|let)\s+(\w+)\s*=\s*)?ETHICS_PREAMBLE\s*\+\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = extractTemplate(src, re.lastIndex - 1);
    prompts.push({ file, name: m[1] ?? `(inline @${src.slice(0, m.index).split('\n').length})`, body, withPreamble: true });
  }

  // b) Prompt constants declared WITHOUT the preamble. Some of these are still
  //    gated: turtle-chat.ts prepends it at runtime (`basePrompt = ETHICS_PREAMBLE
  //    + basePrompt`) rather than at declaration. Treat any file that injects the
  //    preamble anywhere as covering the prompts it declares — otherwise this audit
  //    reports a safety hole that does not exist, which is worse than not auditing.
  const injectsAtRuntime = /ETHICS_PREAMBLE\s*\+\s*\w/.test(src);
  const re2 = /(?:export\s+)?const\s+(\w*(?:PROMPT|SYSTEM|INSTRUCTIONS|PREFIX|WRAPPER)\w*)\s*=\s*`/g;
  while ((m = re2.exec(src))) {
    if (src.slice(Math.max(0, m.index - 60), m.index).includes('ETHICS_PREAMBLE')) continue;
    const body = extractTemplate(src, re2.lastIndex - 1);
    if (body.length < 40) continue;
    if (prompts.some((p) => p.file === file && p.body === body)) continue;
    prompts.push({ file, name: m[1], body, withPreamble: injectsAtRuntime, runtimeInjected: injectsAtRuntime });
  }
}

const pT = tokens(PREAMBLE);
const rows = prompts
  .map((p) => {
    const bodyT = tokens(p.body);
    const totalT = p.withPreamble ? bodyT + pT : bodyT;
    return { ...p, bodyT, totalT, share: p.withPreamble ? Math.round((100 * pT) / totalT) : 0 };
  })
  .sort((a, b) => b.share - a.share || a.totalT - b.totalT);

if (JSON_OUT) {
  console.log(JSON.stringify({ preambleTokens: pT, prompts: rows.map(({ body, ...r }) => r) }, null, 2));
  process.exit(0);
}

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', Y = '\x1b[33m', G = '\x1b[32m', X = '\x1b[0m';

console.log(`${B}Prompt audit${X}\n`);
console.log(`${B}ETHICS_PREAMBLE${X}  ${PREAMBLE.length} chars · ~${pT} tokens · ${PREAMBLE.split('\n').filter(Boolean).length} lines`);
if (MCP_PREAMBLE && MCP_PREAMBLE !== PREAMBLE) {
  console.log(`${R}⚠ mcp-server/src/ethics-preamble.ts has DRIFTED from the canonical copy${X}`);
  console.log(`  app: ${PREAMBLE.length} chars · mcp: ${MCP_PREAMBLE.length} chars`);
} else if (MCP_PREAMBLE) {
  console.log(`${D}  mcp-server copy is byte-identical ✓${X}`);
}

console.log(`\n${B}Prompts injecting the preamble${X} — sorted by how much of the prompt IS preamble\n`);
console.log(`  ${'preamble'.padStart(8)}  ${'body'.padStart(5)}  ${'total'.padStart(5)}   prompt`);
for (const r of rows.filter((r) => r.withPreamble)) {
  const c = r.share >= 40 ? R : r.share >= 25 ? Y : G;
  console.log(
    `  ${c}${String(r.share + '%').padStart(8)}${X}  ${String(r.bodyT).padStart(5)}  ${String(r.totalT).padStart(5)}   ${B}${r.name}${X} ${D}${r.file}${X}`,
  );
}

const naked = rows.filter((r) => !r.withPreamble);
if (naked.length) {
  console.log(`\n${R}${B}UNGATED prompts — no ETHICS_PREAMBLE on any path${X}\n`);
  for (const r of naked) console.log(`  ${R}✗${X} ${String(r.totalT).padStart(5)} tok   ${B}${r.name}${X} ${D}${r.file}${X}`);
}

const injecting = rows.filter((r) => r.withPreamble);
const totalOverhead = injecting.length * pT;
console.log(`\n${B}Summary${X}`);
console.log(`  ${injecting.length} prompt(s) carry the preamble; each pays ~${pT} tokens per call.`);
console.log(`  Worst ratio: ${injecting[0]?.share ?? 0}% of "${injecting[0]?.name}" is preamble.`);
console.log(`  ${D}Fixed overhead across all injecting prompts (1 call each): ~${totalOverhead} tokens.${X}`);
