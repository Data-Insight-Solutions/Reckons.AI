/**
 * WHICH MEANING DOES THIS WORD CARRY, HERE? (F203.4, agent tier via the local panel)
 *
 * The rename cannot start with the ambiguous words, because a script cannot tell `node` the RDF term
 * from `node` the vertex from `node` the three.js object — the graph defines all of them
 * (static/reckons-terminology.ttl), and the difference is in what the code around the word is doing.
 * That is judgment over language, cheap to be wrong about while a human gates the rename, and too
 * voluminous for the orchestrator to do by hand. So:
 *
 *   ground    SCRIPT: the candidate meanings come from the terminology graph (every term whose tokens
 *             include the word, with its definition and scope note), and each item is one real source
 *             site — path, the marked line, and three lines either side. Sites are sampled round-robin
 *             across files in a seeded order, so a sample covers modules instead of one big file.
 *   prompt    the local panel (scripts/agent/local-panel.ts): by default qwen3.6 voting three times,
 *             one question, the meaning ids as an enum plus `other`.
 *   validate  schema per vote; consensus over `sense`.
 *   emit      a per-module table of agreed meanings — which is what a rename batch is planned from —
 *             and every site the panel was not unanimous on — the only sites worth a human's or
 *             Opus's attention. With --pending, those go to the review queue as questions. Nothing
 *             is renamed.
 *
 * Usage:
 *   npx tsx scripts/offline/term-senses.ts --word=node [--sample=30] [--seed=1] [--models=a,b,c]
 *     [--accept=unanimous|majority] [--out=path] [--task-only] [--pending]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Parser, type Quad } from 'n3';
import { type Accept, type PanelTask, type PanelResult, needsReview, runPanel, summarize } from '../agent/local-panel.js';
import { queueFindings, type Finding } from './pending-queue.js';
import { bindingOfLine, isKeywordUse, readTerms, segmentsOf, singular } from './term-usage.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

export type Sense = { id: string; label: string; definition: string; scope: string };
export type Site = { file: string; line: number; token: string; binding: string; context: string };

export function sensesFor(word: string, ttl: string): Sense[] {
  const target = singular(word.toLowerCase());
  const quads: Quad[] = new Parser().parse(ttl);
  const lit = (s: string, p: string) => quads.find((q) => q.subject.value === s && q.predicate.value === p)?.object.value ?? '';
  return readTerms(ttl)
    .filter((t) => t.tokens.includes(target))
    .map((t) => ({
      id: t.id,
      label: t.prefLabel,
      definition: lit(t.iri, `${SKOS}definition`),
      scope: lit(t.iri, `${SKOS}scopeNote`),
    }));
}

/** Every identifier on every line whose segments include the word — the unit a rename moves. */
export function sitesIn(file: string, text: string, word: string): Site[] {
  const target = singular(word.toLowerCase());
  const lines = text.split('\n');
  const out: Site[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const token = m[0];
      if (!segmentsOf(token).map(singular).includes(target)) continue;
      if (isKeywordUse(token, line, m.index ?? 0)) continue;
      const from = Math.max(0, i - 3);
      const to = Math.min(lines.length, i + 4);
      const context = lines
        .slice(from, to)
        .map((l, k) => `${from + k === i ? '>>' : '  '} ${String(from + k + 1).padStart(4)} ${l.slice(0, 200)}`)
        .join('\n');
      out.push({ file, line: i + 1, token, binding: bindingOfLine(line).binding, context });
      break; // one site per line: the question is about the line's meaning, not each spelling on it
    }
  });
  return out;
}

/** Seeded round-robin over files: coverage of modules first, depth second. Deterministic. */
export function sampleSites(byFile: Map<string, Site[]>, size: number, seed: number): Site[] {
  const h = (s: string) => createHash('sha1').update(`${seed}:${s}`).digest('hex');
  const files = [...byFile.keys()].sort((a, b) => h(a).localeCompare(h(b)));
  const queues = files.map((f) => [...(byFile.get(f) ?? [])].sort((a, b) => h(`${f}:${a.line}`).localeCompare(h(`${f}:${b.line}`))));
  const out: Site[] = [];
  for (let round = 0; out.length < size; round++) {
    let took = false;
    for (const q of queues) {
      if (round < q.length && out.length < size) {
        out.push(q[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

export function buildTask(word: string, senses: Sense[], sites: Site[]): PanelTask {
  const menu = senses
    .map((s) => `- ${s.id} ("${s.label}"): ${s.definition}${s.scope ? ` Scope: ${s.scope}` : ''}`)
    .join('\n');
  return {
    id: `term-senses-${word}`,
    instruction:
      `The marked line (>>) of a TypeScript/Svelte file uses an identifier containing the word "${word}". ` +
      `Which ONE of these meanings does the word carry at that site?\n${menu}\n` +
      `- other: none of the above (a DOM node, a generic tree node, Node.js, or an unrelated word).\n` +
      `Judge from what the code does with the value, and the file path. Give the meaning id and a reason under 20 words.`,
    answer: {
      type: 'object',
      properties: {
        sense: { type: 'string', enum: [...senses.map((s) => s.id), 'other'] },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['sense', 'reason'],
    },
    agreeOn: 'sense',
    items: sites.map((s) => ({
      id: `${s.file}:${s.line}`,
      context: `FILE ${s.file}\nIDENTIFIER ${s.token}\n${s.context}`,
    })),
  };
}

/** Module = the directory a rename batch would be scoped to. */
export function moduleOf(file: string): string {
  const parts = file.split('/');
  return parts.slice(0, Math.min(parts.length - 1, 3)).join('/');
}

export function senseTable(result: PanelResult): Map<string, Map<string, number>> {
  const table = new Map<string, Map<string, number>>();
  for (const v of result.verdicts) {
    const mod = moduleOf(v.item.replace(/:\d+$/, ''));
    const row = table.get(mod) ?? new Map<string, number>();
    // Only unanimous counts as agreed (local-panel.ts, THE TRUST POLICY). A majority is shown as
    // ~value so the table still hints at it without planning a rename batch on a coin flip.
    const key = v.status === 'unanimous' && v.value ? v.value : v.status === 'majority' && v.value ? `~${v.value}` : `?${v.status}`;
    row.set(key, (row.get(key) ?? 0) + 1);
    table.set(mod, row);
  }
  return table;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const word = flag('word');
  if (!word) {
    console.error('Usage: npx tsx scripts/offline/term-senses.ts --word=node [--sample=30] [--seed=1] [--models=a,b,c] [--accept=unanimous|majority] [--out=path] [--task-only] [--pending]');
    process.exit(1);
  }
  const senses = sensesFor(word, readFileSync(join(ROOT, 'static/reckons-terminology.ttl'), 'utf8'));
  if (senses.length < 2) {
    console.error(`"${word}" has ${senses.length} meaning(s) in reckons-terminology.ttl — nothing to disambiguate. Add the meanings to the graph first.`);
    process.exit(1);
  }
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|svelte)$/.test(f) && !f.includes('__tests__') && !/\.test\.ts$/.test(f));
  const byFile = new Map<string, Site[]>();
  let total = 0;
  for (const f of files) {
    const sites = sitesIn(f, readFileSync(join(ROOT, f), 'utf8'), word);
    if (sites.length) byFile.set(f, sites);
    total += sites.length;
  }
  const sites = sampleSites(byFile, Number(flag('sample') ?? 30), Number(flag('seed') ?? 1));
  const accept: Accept = flag('accept') === 'majority' ? 'majority' : 'unanimous';
  const task = buildTask(word, senses, sites);
  const out = flag('out') ?? join(tmpdir(), 'reckons-panel', `${task.id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(task, null, 2));
  console.error(`${word}: ${senses.length} meanings in the graph (${senses.map((s) => s.id).join(', ')}); ${total} sites in ${byFile.size} files; sampled ${sites.length}. task → ${out}`);
  if (argv.includes('--task-only')) return;

  let result: PanelResult;
  try {
    result = await runPanel(task, { models: flag('models')?.split(',').filter(Boolean), onProgress: (m) => console.error(m), resultPath: out.replace(/\.json$/, '.result.json') });
  } catch (e) {
    console.error(`term-senses: ${(e as Error).message}`);
    process.exit(2);
  }
  const resultPath = out.replace(/\.json$/, '.result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(summarize(result, task.agreeOn, 25, accept));
  console.log('\nMEANING BY MODULE (value = unanimous; ~value = majority, unconfirmed; ?split / ?failed = unresolved):');
  for (const [mod, row] of [...senseTable(result).entries()].sort()) {
    console.log(`  ${mod.padEnd(34)} ${[...row.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('  ')}`);
  }
  console.log(`result → ${resultPath}`);

  if (argv.includes('--pending')) {
    const findings: Finding[] = result.verdicts
      .filter((v) => needsReview(v, accept))
      .map((v) => ({
        subject: 'urn:kbase:concept/terminology-ontology',
        predicate: 'urn:kbase:predicate/open-question',
        type: 'question',
        priority: 'low',
        question: `Which meaning of "${word}" is used at ${v.item}? The local panel was not unanimous (${v.status}): ${v.votes.map((x) => `${x.model}=${x.answer ? String(x.answer.sense) : 'error'}`).join(', ')}.`,
      }));
    const r = queueFindings(findings, { agent: `term-senses ${word}` });
    console.log(`pending: ${r.queued} queued, ${r.skipped} already there, ${r.superseded} superseded`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('term-senses.ts')) void main();
