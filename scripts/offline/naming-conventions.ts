#!/usr/bin/env npx tsx
/**
 * NAMING CONVENTIONS (F204, SCRIPT tier) — what this codebase does, what the frameworks it is
 * built on do, and where those two disagree. Deterministic, zero tokens.
 *
 * WHY IT EXISTS, AND WHY IT MEASURES OTHER PEOPLE'S CODE. Matt, 2026-09-17: "I would put Threlte
 * and other key framework standards as more important than specific individuals' opinions." That
 * ranking is only usable if the framework's standard is a FACT rather than a recollection, and a
 * style guide's prose is not that fact — the code is. Mr.doob's Code Style says constants may be
 * "UPPER_SNAKE_CASE or UpperCamelCase depending on context", which settles nothing; counting
 * three.js's shipped constants settles it in a second.
 *
 * It also exposes the thing a style guide can hide. three.js is authored in JavaScript, so it has
 * no opinion whatsoever on `interface` versus `type` — it cannot, there is no such declaration in
 * it. A source with no evidence must not be cited as though it agreed with us, and only counting
 * shows that it is empty.
 *
 * PRECEDENCE, which is the decision this encodes:
 *   1. THE FRAMEWORK WE BUILD ON — SvelteKit and Svelte. We live inside their conventions.
 *   2. THE LIBRARY BINDING WE USE — Threlte, which is a Svelte library solving our exact problem.
 *   3. THE UPSTREAM LIBRARY ITSELF — three.js, for its own API surface only.
 *   4. AN INDIVIDUAL'S STYLE GUIDE — lowest, and only where nothing above has evidence.
 * Ranked sources disagreeing is normal. The report says who wins and by how much, so a decision
 * is taken once and recorded, rather than re-argued in a review.
 *
 * WHAT IT CANNOT TELL YOU. These are line-shaped regular expressions over published packages, and
 * a published package is not always authored source: Threlte ships compiled .d.ts, Svelte ships
 * hand-written types beside generated ones. Counts are evidence of the SHAPE OF A PUBLIC API, which
 * is what we are copying anyway, not of what the authors typed. Where a package ships no
 * TypeScript at all the report says NO EVIDENCE rather than zero, because those mean opposite
 * things and reading one as the other is how a silent source gets a vote.
 *
 * Usage:
 *   npx tsx scripts/offline/naming-conventions.ts            report
 *   npx tsx scripts/offline/naming-conventions.ts --json     machine-readable
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STANDARDS = join(ROOT, 'static/reckons-standards.ttl');
const JSON_OUT = process.argv.includes('--json');
const CHECK = process.argv.includes('--check');

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** Sources, most authoritative first. Rank is the decision; the counts are the evidence. */
export const SOURCES = [
  { rank: 1, id: 'ours', label: 'this codebase', roots: ['src'] },
  { rank: 1, id: 'sveltekit', label: 'SvelteKit', roots: ['node_modules/@sveltejs/kit'] },
  { rank: 1, id: 'svelte', label: 'Svelte', roots: ['node_modules/svelte'] },
  { rank: 2, id: 'threlte', label: 'Threlte', roots: ['node_modules/@threlte/core', 'node_modules/@threlte/extras'] },
  { rank: 3, id: 'three', label: 'three.js', roots: ['node_modules/three/src'] },
] as const;

export type Metric = {
  id: string;
  question: string;
  /** Competing answers. The winner is whichever counts highest within one source. */
  options: { id: string; re: RegExp; exemptWhen?: RegExp }[];
  /**
   * Only count this metric in files that declare a class.
   *
   * Without it, "how is a private member marked" reported a 97%-to-2% conflict with SvelteKit in
   * a codebase with 16 classes: the 223 hits were module-scope mutable state (`_labelLast`,
   * `_autoSaveTimer`) and object keys (`_format`), not private members at all. A metric that
   * answers a question nobody asked, confidently, is worse than no metric.
   */
  classFilesOnly?: boolean;
};

/**
 * Each metric is one decision somebody has to take, phrased as competing line shapes. Anchored at
 * the start of a line so a mention inside a comment or a string does not vote.
 */
export const METRICS: Metric[] = [
  {
    id: 'declaration',
    question: 'interface or type for an exported object shape?',
    options: [
      {
        id: 'interface',
        re: /^\s*(export\s+)?(declare\s+)?interface\s+[A-Za-z]/,
        // The decided rule is "type by default, interface as a deliberate EXTENSION POINT", so the
        // ratchet has to be able to tell a deliberate one from a leftover. Saying so in a comment
        // on or above the declaration is the cheapest possible marker and documents itself.
        exemptWhen: /extension point/i,
      },
      { id: 'type', re: /^\s*(export\s+)?(declare\s+)?type\s+[A-Za-z][\w]*\s*[=<]/ },
    ],
  },
  {
    id: 'unit',
    question: 'class or function as the unit of code?',
    options: [
      { id: 'class', re: /^\s*export\s+(abstract\s+)?class\s+[A-Za-z]/ },
      { id: 'function', re: /^\s*export\s+(async\s+)?function\s+[A-Za-z]/ },
    ],
  },
  {
    /**
     * A LITERAL constant only — `const MAX = 10`, not `const parser = new Parser()`.
     *
     * The unrestricted version of this metric reported that SvelteKit and Threlte prefer camelCase
     * for constants and therefore conflicted with our UPPER_SNAKE. They do not. It was counting
     * module-scope SINGLETONS — `const saveBtn = document.getElementById(...)` — which every one of
     * these codebases cases camelCase, ours included. Two different conventions wearing one name.
     */
    id: 'constant',
    question: 'how is a module-level LITERAL constant cased?',
    options: [
      { id: 'UPPER_SNAKE', re: /^(export\s+)?const\s+[A-Z][A-Z0-9_]{2,}\s*(:[^=]+)?=\s*(['"`]|-?\d|true|false|\[|\{|new\s|Object\.freeze)/ },
      { id: 'PascalCase', re: /^(export\s+)?const\s+[A-Z][a-z][A-Za-z0-9]*\s*(:[^=]+)?=\s*(['"`]|-?\d|true|false|\[|\{|new\s|Object\.freeze)/ },
      { id: 'camelCase', re: /^(export\s+)?const\s+[a-z][A-Za-z0-9]*\s*(:[^=]+)?=\s*(['"`]|-?\d|true|false|\[|\{)/ },
    ],
  },
  {
    id: 'private',
    question: 'how is a private CLASS member marked?',
    classFilesOnly: true,
    options: [
      { id: '#private', re: /^\s+#[a-zA-Z]\w*\s*[=;(]/ },
      { id: 'ts-private', re: /^\s+(private|protected)\s+[a-zA-Z#]/ },
      { id: '_underscore', re: /^\s+(readonly\s+|static\s+)?_[a-zA-Z]\w*\s*[=;(]/ },
    ],
  },
  {
    /**
     * The convention the private-member metric was accidentally measuring, given its own question.
     * Module-scope mutable state is real and common in this codebase; whether it is marked is a
     * separate decision from how a class marks a private field.
     */
    id: 'module-state',
    question: 'is module-scope mutable state marked with a prefix?',
    options: [
      { id: '_underscore', re: /^(export\s+)?let\s+_[a-zA-Z]/ },
      { id: 'unmarked', re: /^(export\s+)?let\s+[a-z][A-Za-z0-9]*/ },
    ],
  },
];

const CODE_EXTENSIONS = ['.ts', '.js', '.svelte'];

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out, depth + 1);
    else if (CODE_EXTENSIONS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

export type SourceResult = {
  id: string;
  label: string;
  rank: number;
  present: boolean;
  files: number;
  /** metric id -> option id -> count */
  counts: Record<string, Record<string, number>>;
  /** metric id -> the option with the most hits, or null when the source is silent. */
  verdict: Record<string, { option: string; share: number; total: number } | null>;
};

/**
 * THE RATCHET — the only part of this file that can fail a build.
 *
 * A decided rule with no check is a preference, and this project has written that sentence about
 * itself twice already. But a check that fails on 282 existing declarations is a gate nobody can
 * pass, and a gate nobody can pass gets switched off — at which point it protects nothing at all.
 *
 * So the check is a RATCHET: the baseline is the count of existing violations, recorded in the
 * graph beside the rule it belongs to, and the build fails only when that number goes UP. Cleaning
 * some up means lowering the baseline in the same commit, which makes the debt visible in the diff
 * rather than invisible in a backlog. The baselines live in static/reckons-standards.ttl as
 * `kpred:ratchet "<metric>/<option>/<max>"`, so the rule and the number it tolerates are one entity.
 */
export function readRatchets(ttl: string): { metric: string; option: string; max: number }[] {
  const out: { metric: string; option: string; max: number }[] = [];
  for (const m of ttl.matchAll(/kpred:ratchet\s+"([^"]+)"/g)) {
    const [metric, option, max] = m[1].split('/');
    const n = Number(max);
    if (!metric || !option || !Number.isFinite(n)) continue;
    out.push({ metric, option, max: n });
  }
  return out;
}

/** Count every metric over a set of lines. Exported so a test can drive it on a literal file. */
export function countLines(lines: string[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const metric of METRICS) {
    counts[metric.id] = Object.fromEntries(metric.options.map((o) => [o.id, 0]));
  }
  // Exemptions are tallied, never silent. Reported under a key no metric owns, so verdicts — which
  // iterate METRICS — never see it and an exempt declaration cannot vote on what a codebase prefers.
  counts._exempt = {};
  const hasClass = lines.some((l) => /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+[A-Za-z]/.test(l));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const above = i > 0 ? lines[i - 1] : '';
    for (const metric of METRICS) {
      if (metric.classFilesOnly && !hasClass) continue;
      for (const option of metric.options) {
        if (!option.re.test(line)) continue;
        if (option.exemptWhen && (option.exemptWhen.test(line) || option.exemptWhen.test(above))) {
          counts._exempt[option.id] = (counts._exempt[option.id] ?? 0) + 1;
        } else {
          counts[metric.id][option.id] += 1;
        }
        // First match wins within a metric: `const Foo = ...` is PascalCase, not also camelCase.
        break;
      }
    }
  }
  return counts;
}

export function verdictsFrom(counts: Record<string, Record<string, number>>): SourceResult['verdict'] {
  const verdict: SourceResult['verdict'] = {};
  for (const metric of METRICS) {
    const entries = Object.entries(counts[metric.id]).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    // A handful of hits is not a convention, it is a coincidence. Say NO EVIDENCE instead.
    verdict[metric.id] = total < 5 ? null : { option: entries[0][0], share: entries[0][1] / total, total };
  }
  return verdict;
}

function measure(source: (typeof SOURCES)[number]): SourceResult {
  const roots = source.roots.map((r) => join(ROOT, r)).filter((r) => existsSync(r));
  const files = roots.flatMap((r) => walk(r));
  const counts: Record<string, Record<string, number>> = {};
  for (const metric of METRICS) counts[metric.id] = Object.fromEntries(metric.options.map((o) => [o.id, 0]));
  counts._exempt = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fileCounts = countLines(text.split('\n'));
    for (const metric of METRICS) {
      for (const option of metric.options) counts[metric.id][option.id] += fileCounts[metric.id][option.id];
    }
    for (const [option, n] of Object.entries(fileCounts._exempt)) {
      counts._exempt[option] = (counts._exempt[option] ?? 0) + n;
    }
  }
  return {
    id: source.id,
    label: source.label,
    rank: source.rank,
    present: roots.length > 0,
    files: files.length,
    counts,
    verdict: verdictsFrom(counts),
  };
}

function runCheck(ours: SourceResult): void {
  let ttl: string;
  try {
    ttl = readFileSync(STANDARDS, 'utf8');
  } catch {
    console.error(C.red('No static/reckons-standards.ttl, so there are no baselines to check against.'));
    process.exit(1);
  }
  const ratchets = readRatchets(ttl);
  if (ratchets.length === 0) {
    console.error(C.red('static/reckons-standards.ttl records no kpred:ratchet baselines. Nothing is enforced.'));
    process.exit(1);
  }

  console.log(C.bold('\nNAMING RATCHET — a decided rule may not get worse'));
  let failed = 0;
  for (const r of ratchets) {
    const actual = ours.counts[r.metric]?.[r.option];
    if (actual === undefined) {
      console.log(`  ${C.red('✗')} ${r.metric}/${r.option} — no such metric or option. The baseline names a rule this script does not measure.`);
      failed += 1;
      continue;
    }
    if (actual > r.max) {
      console.log(
        `  ${C.red('✗')} ${r.metric}/${r.option}: ${actual}, baseline ${r.max} — ${C.red(`${actual - r.max} new`)}. ` +
          'Use the decided form, or mark a deliberate exception and raise the baseline in the same commit.',
      );
      failed += 1;
    } else if (actual < r.max) {
      console.log(
        `  ${C.yellow('!')} ${r.metric}/${r.option}: ${actual}, baseline ${r.max} — ${actual - r.max} ` +
          C.dim('(lower the baseline in static/reckons-standards.ttl to lock the cleanup in)'),
      );
    } else {
      console.log(`  ${C.green('✓')} ${r.metric}/${r.option}: ${actual}, at baseline`);
    }
  }
  const exempt = Object.entries(ours.counts._exempt ?? {}).filter(([, n]) => n > 0);
  if (exempt.length) {
    console.log(C.dim(`  exempted as deliberate: ${exempt.map(([o, n]) => `${o} ${n}`).join(', ')}`));
  }
  console.log('');
  if (failed) process.exit(1);
}

function main(): void {
  const results = SOURCES.map(measure);
  const ours = results.find((r) => r.id === 'ours')!;

  if (CHECK) {
    runCheck(ours);
    return;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), results }, null, 2));
    return;
  }

  console.log(C.bold('\nNAMING CONVENTIONS — measured, not recalled'));
  console.log(C.dim('  Precedence: framework (SvelteKit, Svelte) > library binding (Threlte) > upstream (three.js) > an individual style guide.'));
  console.log(C.dim('  A source with fewer than 5 hits on a question is reported as NO EVIDENCE and gets no vote.\n'));

  const pad = (s: string, n: number) => s.padEnd(n);
  for (const metric of METRICS) {
    console.log(C.bold(`  ${metric.question}`));
    for (const r of results) {
      if (!r.present) {
        console.log(`    ${pad(r.label, 16)}${C.dim('not installed')}`);
        continue;
      }
      const v = r.verdict[metric.id];
      const detail = Object.entries(r.counts[metric.id])
        .filter(([, n]) => n > 0)
        .map(([o, n]) => `${o} ${n}`)
        .join(', ');
      if (!v) {
        console.log(`    ${pad(r.label, 16)}${C.dim('NO EVIDENCE')}  ${C.dim(detail || 'nothing to count')}`);
        continue;
      }
      const strength = v.share >= 0.75 ? C.green : v.share >= 0.6 ? C.yellow : C.red;
      const agrees = r.id !== 'ours' && ours.verdict[metric.id] && ours.verdict[metric.id]!.option === v.option;
      console.log(
        `    ${pad(r.label, 16)}${strength(pad(v.option, 14))}${pad(`${Math.round(v.share * 100)}% of ${v.total}`, 18)}` +
          `${agrees ? C.dim('agrees with ours') : ''}  ${C.dim(detail)}`,
      );
    }

    // ── Who disagrees with us, in precedence order ──────────────────────────
    const ourV = ours.verdict[metric.id];
    const dissent = results.filter(
      (r) => r.id !== 'ours' && r.verdict[metric.id] && ourV && r.verdict[metric.id]!.option !== ourV.option,
    );
    if (!ourV) {
      console.log(C.yellow('    → we have no convention here.'));
    } else if (ourV.share < 0.6) {
      const ranked = dissent.length ? dissent : results.filter((r) => r.id !== 'ours' && r.verdict[metric.id]);
      const best = ranked.sort((a, b) => a.rank - b.rank)[0];
      console.log(
        C.red(
          `    → WE HAVE NOT DECIDED: ${Math.round(ourV.share * 100)}% is a coin flip, not a convention.` +
            (best ? ` Highest-ranked source with evidence is ${best.label} (${best.verdict[metric.id]!.option}).` : ''),
        ),
      );
    } else if (dissent.length) {
      const top = dissent.sort((a, b) => a.rank - b.rank)[0];
      console.log(
        C.yellow(
          `    → conflict: ${top.label} (rank ${top.rank}) says ${top.verdict[metric.id]!.option}, we say ${ourV.option}.`,
        ),
      );
    } else {
      console.log(C.green(`    → settled: ${ourV.option}, and no ranked source with evidence disagrees.`));
    }
    console.log('');
  }
}

if (process.argv[1] && process.argv[1].endsWith('naming-conventions.ts')) main();
