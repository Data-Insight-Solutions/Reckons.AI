#!/usr/bin/env npx tsx
/**
 * MODEL INVENTORY, script tier. Every local model a script or schedule falls back to, checked
 * against what Ollama has installed — before a job finds out by failing.
 *
 * WHY. On 2026-10-26 qwen3.6 and qwen3:32b were removed from this machine by hand when the deputy
 * moved to qwen3.8. Six scripts still defaulted to them; each failed at its first call with a bare
 * 404, and the deputy's handoff blamed an Ollama API change. Whether a named model exists is a rule,
 * not a judgment (F74.3), so it is a script, run at session start with the other script-tier checks.
 *
 * WHAT COUNTS AS A DEFAULT. A string literal with an Ollama tag (`name:tag`) on a line that mentions
 * "model", in a git-tracked scripts/ file outside tests; `--model=` / `--models=` flags in
 * schedules.ttl and jobs.json; and DEFAULT_REASONING_MODEL as resolved on this host. A bare name
 * with no tag is not matched (too much noise: "opus", "accept"), which is a gap said out loud.
 * Benches under tests/bench are left out: they are run by hand with their model named.
 *
 * Exit: 0 every default installed; 1 one or more missing; 2 Ollama unreachable (unknown, not green).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REASONING_MODEL } from './lib/local-model.js';

export type Expectation = { model: string; where: string };

/** `qwen3.8` → `qwen3.8:latest`; a tagged name is unchanged. Pure. */
export const withTag = (m: string): string => (m.includes(':') ? m : `${m}:latest`);

const TAGGED = /['"`]([a-z0-9][\w.\-]*:[\w.\-]+)['"`]/gi;

/** Model defaults named in one TypeScript source. Pure. */
export function defaultsInSource(file: string, text: string): Expectation[] {
  const out: Expectation[] = [];
  text.split('\n').forEach((line, i) => {
    if (!/model/i.test(line) || /^\s*(\*|\/\/)/.test(line)) return;
    for (const m of line.matchAll(TAGGED)) {
      if (/^(https?|urn|file|node):/i.test(m[1])) continue;
      out.push({ model: m[1], where: `${file}:${i + 1}` });
    }
  });
  return out;
}

/** `--model=x` and `--models=a,b` flags in a schedule or job command file. Pure. */
export function flagsInConfig(file: string, text: string): Expectation[] {
  const out: Expectation[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/--models?=([\w.:,\-]+)/g)) {
      for (const model of m[1].split(',').filter(Boolean)) out.push({ model: withTag(model), where: `${file}:${i + 1}` });
    }
  });
  return out;
}

/** Expectations whose model is not installed, grouped by model. Pure. */
export function missing(expected: Expectation[], installed: string[]): Map<string, string[]> {
  const have = new Set(installed.map(withTag));
  const gone = new Map<string, string[]>();
  for (const e of expected) {
    const m = withTag(e.model);
    if (have.has(m)) continue;
    gone.set(m, [...(gone.get(m) ?? []), e.where]);
  }
  return gone;
}

// ── IO ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const ollama = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const files = execFileSync('git', ['ls-files', 'scripts/**.ts'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => f && !/__tests__|\.test\.ts$/.test(f));
  const expected: Expectation[] = [{ model: DEFAULT_REASONING_MODEL, where: 'DEFAULT_REASONING_MODEL (scripts/offline/lib/local-model.ts)' }];
  for (const f of files) expected.push(...defaultsInSource(f, readFileSync(path.join(root, f), 'utf8')));
  for (const f of ['reckons-workspace/schedules.ttl', 'scripts/offline/jobs.json']) {
    try { expected.push(...flagsInConfig(f, readFileSync(path.join(root, f), 'utf8'))); } catch { /* absent on a fresh clone */ }
  }

  let installed: string[];
  try {
    const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(5000) });
    installed = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    console.log(`model-inventory: Ollama is not answering at ${ollama} — ${new Set(expected.map((e) => withTag(e.model))).size} expected model(s) UNCHECKED.`);
    return 2;
  }

  const gone = missing(expected, installed);
  const models = new Set(expected.map((e) => withTag(e.model)));
  if (gone.size === 0) {
    console.log(`model-inventory: ✓ all ${models.size} default model(s) installed (${expected.length} references).`);
    return 0;
  }
  console.log(`model-inventory: ✗ ${gone.size} of ${models.size} default model(s) NOT installed — jobs using them fail at their first call.`);
  for (const [m, where] of gone) {
    console.log(`  ${m}`);
    for (const w of where.slice(0, 6)) console.log(`    ${w}`);
    if (where.length > 6) console.log(`    … ${where.length - 6} more`);
  }
  console.log(`  Installed: ${installed.sort().join(', ') || '(none)'}`);
  console.log('  Fix: ollama pull <model>, or point the default at an installed model (DEFAULT_REASONING_MODEL / RECKONS_LOCAL_MODEL).');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
