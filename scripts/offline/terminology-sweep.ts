#!/usr/bin/env npx tsx
/**
 * TERMINOLOGY SWEEP (F203.6, agent tier inside a script harness) — the weekly half of terminology
 * as a standing maintenance job (Matt, 2026-10-07).
 *
 * For every word that static/reckons-terminology.ttl gives TWO OR MORE meanings, run the
 * term-senses panel over a sample of real code sites and queue only the sites the panel did not
 * agree on. The word list is read from the graph each run, so a meaning added through review is
 * covered the next week without anyone editing this file.
 *
 * MIXED MODELS (Matt's decision): three different families vote, because one model voting three
 * times measures consistency, not correctness. On 2026-10-07 qwen3-coder x3 was 30/30 unanimous
 * on `graph` while the terminology lacked the meaning most of those sites used; a mixed panel the
 * same day split on `export` and the dissenting model was right (the sites were the JS keyword).
 * nemotron3:33b was the decided third voter; it is not installed here, so gemma3:27b stands in.
 *
 * Usage: OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/terminology-sweep.ts
 *          [--sample=30] [--models=a,b,c] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTerms } from './term-usage.js';

export const DEFAULT_MODELS = ['qwen3-coder:latest', 'devstral-small-2:latest', 'gemma3:27b'];

/** Words with two or more meanings in the terminology graph, most meanings first. Pure. */
export function ambiguousWords(ttl: string): { word: string; meanings: number }[] {
  const count = new Map<string, number>();
  for (const term of readTerms(ttl)) for (const token of term.tokens) count.set(token, (count.get(token) ?? 0) + 1);
  return [...count].filter(([, n]) => n >= 2).map(([word, meanings]) => ({ word, meanings }))
    .sort((a, b) => b.meanings - a.meanings || a.word.localeCompare(b.word));
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const root = resolve(import.meta.dirname ?? '.', '../..');
  const words = ambiguousWords(readFileSync(join(root, 'static/reckons-terminology.ttl'), 'utf8'));
  const models = flag('models') ?? DEFAULT_MODELS.join(',');
  console.log(`terminology sweep: ${words.length} ambiguous word(s): ${words.map((w) => `${w.word}(${w.meanings})`).join(', ')}`);
  if (!process.env.OLLAMA_BASE_URL) { console.error('OLLAMA_BASE_URL is not set; the panel needs local models. Nothing ran.'); process.exit(2); }
  if (argv.includes('--dry-run')) return;
  const failed: string[] = [];
  for (const { word } of words) {
    try {
      execFileSync('npx', ['tsx', join(root, 'scripts/offline/term-senses.ts'), `--word=${word}`, `--sample=${flag('sample') ?? 30}`,
        `--models=${models}`, '--accept=unanimous', '--pending'], { stdio: 'inherit', cwd: root });
    } catch { failed.push(word); }
  }
  // A failed word is said by name, never folded into a count.
  if (failed.length) { console.error(`✗ term-senses FAILED for: ${failed.join(', ')}`); process.exit(1); }
}

if (process.argv[1] && process.argv[1].endsWith('terminology-sweep.ts')) main();
