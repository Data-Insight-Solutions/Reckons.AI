#!/usr/bin/env npx tsx
/**
 * The docs build, in the one order that works.
 *
 * There are nine docs scripts and their dependencies are real but implicit, so getting the order
 * wrong fails in ways that look like something else. Two examples that cost time on 2026-09-08:
 * docs-pages.ts REFUSES to render and looks a diagram up by hash, so running it before
 * docs-diagrams.ts throws a "no cached diagram" error naming a command; and the search index is
 * built FROM content/, so running it before docs-pages.ts silently indexes the previous build.
 *
 * This is the order, and the reason for each step:
 *
 *   1. diagrams   render mermaid to committed SVG   (pages look these up and never render)
 *   2. scenes     render three.js to committed PNG  (same contract, same reason)
 *   3. pages      write content/ from the graph     (needs 1 and 2 present)
 *   4. search     index content/                    (reads what 3 just wrote)
 *
 * NOT INCLUDED, DELIBERATELY: docs-compose.ts. It is the second page generator and it claims
 * files this one owns — see its collision guard. It must not run as part of a routine build.
 *
 * Usage:
 *   npm run docs:build            build everything in order
 *   npm run docs:build -- --check verify everything is current, change nothing (CI)
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const CHECK = process.argv.includes('--check');

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const STEPS: Array<{ name: string; script: string; why: string; checkArgs?: string[] }> = [
  { name: 'diagrams', script: 'scripts/docs-diagrams.ts', checkArgs: ['--check'],
    why: 'pages look diagrams up by hash and never render them' },
  { name: 'scenes',   script: 'scripts/docs-scenes.ts',   checkArgs: ['--check'],
    why: 'same contract as diagrams — rendered once, committed, reviewed' },
  { name: 'pages',    script: 'scripts/docs-pages.ts',
    why: 'writes content/ from the graph; needs the two caches above' },
  { name: 'search',   script: 'scripts/docs-search-index.ts', checkArgs: ['--check'],
    why: 'indexes content/, so it must run after pages' },
];

function main(): void {
  console.log('');
  console.log(C.bold(`docs build${CHECK ? ' — check only' : ''}`) + C.dim(` — ${STEPS.length} steps, in dependency order`));
  const failed: string[] = [];

  for (const step of STEPS) {
    const args = ['tsx', step.script, ...(CHECK ? (step.checkArgs ?? []) : [])];
    // A step with no --check mode still RUNS in check mode; docs-pages.ts is idempotent and
    // exits non-zero only when it wrote something, which in check mode is the failure signal.
    process.stdout.write(`  ${step.name.padEnd(10)}`);
    try {
      execFileSync('npx', args, { cwd: ROOT, stdio: 'pipe' });
      console.log(C.green('ok') + C.dim(`   ${step.why}`));
    } catch (e) {
      const out = (e as { stdout?: Buffer; stderr?: Buffer });
      const text = `${out.stdout?.toString() ?? ''}${out.stderr?.toString() ?? ''}`.trim();
      if (CHECK && step.name === 'pages' && /written/.test(text)) {
        console.log(C.red('STALE') + C.dim('  content/ does not match the graph — run npm run docs:build'));
      } else {
        console.log(C.red('FAILED'));
        for (const line of text.split('\n').slice(-6)) console.log(C.dim(`    ${line}`));
      }
      failed.push(step.name);
    }
  }

  console.log('');
  if (failed.length) {
    console.log(C.red(`  ${failed.join(', ')} failed. The order above is a dependency chain, so fix the first one first.`));
    process.exit(1);
  }
  console.log(C.green('  docs are current.'));
}

main();
