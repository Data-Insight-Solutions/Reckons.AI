#!/usr/bin/env npx tsx
/**
 * UI TERMS AUDIT (F203.7, script tier) — does the screen speak the user's words?
 *
 * Matt, 2026-10-07, after /kb was found full of "graph" where the product says "space": "If the UI
 * displays backend engineering terms, or if the term isn't being used consistently, we should be
 * able to detect and fix that." The model-only job had failed: the local panel judged 59 strings
 * "keep" unanimously and was right 3 times (scripts/agent/fixtures/ui-copy-graph.labels.json).
 *
 * Two checks, both read from static/reckons-terminology.ttl and both on VISIBLE text only (the
 * Svelte compiler's view of text nodes and the attributes a person reads; ui-copy.ts):
 *   jargon      a word naming how the product is built (kpred:ui-jargon, plus every prefixed
 *               standards label such as rdf:Statement). Suggests the concept's user label.
 *   graph       "graph" in the SPACE sense, decided by rules (lib/term-sense-rules.ts); the drawn
 *               picture and the RDF term are left alone; what no rule decides is "undecided".
 *
 * TEMPLATES are counted for the ratchet. Strings in scripts are REPORTED only: many are model
 * prompts, which no person reads, and a ratchet must be right by construction.
 *
 *   report       counts and every template finding with its sentence and suggestion
 *   --check      the RATCHET: template jargon and graph-as-space may fall, never rise. Baselines:
 *                kpred:ui-term-ratchet "jargon/<n>" and "graph-as-space/<n>" on the terminology scheme.
 *   --pending    template findings as proposals in reckons-workspace/knowledge.pending.jsonl
 *   --task=path  a local-panel task for the UNDECIDED template occurrences only
 *
 * WEAKNESSES, said out loud: text assembled at runtime (a space NAMED "Default Graph") is invisible
 * to a source scan; a technical page is only exempt once declared (kpred:technical-surface); the
 * sense rules were tuned on /kb and scored 9 right, 1 wrong, 8 undecided on 18 held-out strings.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Parser } from 'n3';
import { occurrencesIn, scriptBlocks, scriptOccurrences, WORDS, type Occurrence } from './ui-copy.js';
import { graphSense, type Sense } from './lib/term-sense-rules.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const TERMS = 'static/reckons-terminology.ttl';
const SCHEME = 'urn:kbase:vocabulary/terminology';
const KPRED = 'urn:kbase:predicate/';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

export type TermConfig = { jargon: Map<string, string | undefined>; surfaces: string[]; ratchets: Record<string, number> };

/** Pure: the jargon (word -> suggested user word), technical surfaces and ratchet baselines. */
export function readTermConfig(ttl: string): TermConfig {
  const quads = new Parser({ format: 'Turtle' }).parse(ttl);
  const jargon = new Map<string, string | undefined>();
  const surfaces: string[] = [];
  const ratchets: Record<string, number> = {};
  const props = new Map<string, Map<string, string[]>>();
  for (const q of quads) {
    const s = q.subject.value;
    if (s === SCHEME && q.predicate.value === `${KPRED}ui-jargon`) jargon.set(q.object.value, undefined);
    else if (s === SCHEME && q.predicate.value === `${KPRED}technical-surface`) surfaces.push(q.object.value);
    else if (s === SCHEME && q.predicate.value === `${KPRED}ui-term-ratchet`) {
      const m = q.object.value.match(/^([\w-]+)\/(\d+)$/);
      if (m) ratchets[m[1]] = Number(m[2]);
    }
    if (!props.has(s)) props.set(s, new Map());
    const p = props.get(s)!;
    const k = q.predicate.value.replace(KPRED, '').replace(SKOS, '');
    p.set(k, [...(p.get(k) ?? []), q.object.value]);
  }
  // Prefixed standards names are jargon by construction; the concept's user label is the fix.
  for (const p of props.values()) {
    const user = p.get('user-label')?.[0];
    for (const std of p.get('standards-label') ?? []) {
      const name = std.trim();
      if (/^[a-z]+:[A-Z]\w+$/.test(name)) jargon.set(name, user);
    }
    // A listed jargon word that is also a concept's prefLabel or standards label inherits its user word.
    for (const label of [...(p.get('prefLabel') ?? []), ...(p.get('standards-label') ?? [])]) {
      if (jargon.has(label) && !jargon.get(label) && user) jargon.set(label, user);
    }
  }
  return { jargon, surfaces, ratchets };
}

/** One pattern over every jargon word: whole words, an optional plural, exact case for acronyms. */
export function jargonPattern(input: Iterable<string>): RegExp {
  // Read once: a Map's keys() is a one-shot iterator, and reading it twice silently dropped every
  // acronym and prefixed name from the pattern (caught by the unit test, 2026-10-07).
  const words = [...input];
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Acronyms and prefixed names match their exact case; ordinary words match any case.
  const ci = words.filter((w) => !(/^[A-Z][A-Za-z]*[A-Z]/.test(w) || w.includes(':')));
  const cs = words.filter((w) => !ci.includes(w));
  const body = [...cs.map((w) => `${esc(w)}s?`), ...ci.map((w) => [...w].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : esc(c))).join('') + 's?')];
  return new RegExp(`(?<![\\w_:./#-])(${body.join('|')})(?![\\w_/-])`, 'g');
}

export type Finding = { file: string; line: number; where: Occurrence['where']; word: string; sentence: string; check: 'jargon' | 'graph'; sense?: Sense; rule?: string; suggest?: string };

/** Pure: findings for one file's occurrences. Surfaces declared technical are exempt from both checks. */
export function findings(occ: Occurrence[], cfg: TermConfig): Finding[] {
  const out: Finding[] = [];
  const nth = new Map<string, number>(); // the k-th "graph" of a sentence is judged at its own position
  for (const o of occ) {
    if (cfg.surfaces.some((s) => o.file.startsWith(s))) continue;
    if (o.kind === 'jargon') {
      const key = [...cfg.jargon.keys()].find((k) => o.word.toLowerCase().replace(/s$/, '') === k.toLowerCase() || o.word.toLowerCase() === k.toLowerCase());
      out.push({ file: o.file, line: o.line, where: o.where, word: o.word, sentence: o.sentence, check: 'jargon', suggest: key ? cfg.jargon.get(key) : undefined });
    } else if (o.kind === 'graph' && /^graphs?$/i.test(o.word)) {
      const key = `${o.file}\u0000${o.where}\u0000${o.sentence}`;
      const k = nth.get(key) ?? 0;
      nth.set(key, k + 1);
      const hits = [...o.sentence.matchAll(/(?<![\w-])graphs?(?![\w-])/gi)];
      const idx = hits[Math.min(k, hits.length - 1)]?.index ?? 0;
      const r = graphSense(o.sentence, idx, o.word);
      if (r.sense !== 'keep') out.push({ file: o.file, line: o.line, where: o.where, word: o.word, sentence: o.sentence, check: 'graph', sense: r.sense, rule: r.rule, suggest: r.sense === 'space' ? (/s$/i.test(o.word) ? 'spaces' : 'space') : undefined });
    }
  }
  return out;
}

/** Ratchet counts: TEMPLATE findings only (text and attributes a person sees). */
export function ratchetCounts(f: Finding[]): Record<string, number> {
  const t = f.filter((x) => x.where !== 'script');
  return { jargon: t.filter((x) => x.check === 'jargon').length, 'graph-as-space': t.filter((x) => x.check === 'graph' && x.sense === 'space').length };
}

function collect(cfg: TermConfig): Finding[] {
  const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !/__tests__|\.test\.ts$|\.spec\.ts$|\.stories\./.test(f));
  const jp = jargonPattern(cfg.jargon.keys());
  const all: Finding[] = [];
  for (const f of tracked) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const occ: Occurrence[] = [];
    if (f.endsWith('.svelte')) {
      occ.push(...occurrencesIn(f, src), ...occurrencesIn(f, src, jp, () => 'jargon'));
      for (const b of scriptBlocks(src)) occ.push(...scriptOccurrences(f, b.code, b.offset, src), ...scriptOccurrences(f, b.code, b.offset, src, jp, () => 'jargon'));
    } else if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
      occ.push(...scriptOccurrences(f, src, 0, src), ...scriptOccurrences(f, src, 0, src, jp, () => 'jargon'));
    }
    all.push(...findings(occ, cfg));
  }
  return all;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cfg = readTermConfig(readFileSync(join(ROOT, TERMS), 'utf8'));
  const all = collect(cfg);
  const counts = ratchetCounts(all);
  const script = all.filter((x) => x.where === 'script');
  const undecided = all.filter((x) => x.where !== 'script' && x.check === 'graph' && x.sense === 'undecided');
  console.log(`ui terms: templates — jargon ${counts.jargon} · graph meaning space ${counts['graph-as-space']} · graph undecided ${undecided.length}; script strings (reported, not ratcheted) — jargon ${script.filter((x) => x.check === 'jargon').length} · graph meaning space ${script.filter((x) => x.sense === 'space').length}`);
  for (const x of all.filter((y) => y.where !== 'script' && (y.check === 'jargon' || y.sense === 'space'))) {
    console.log(`  ${x.check === 'jargon' ? 'JARGON' : 'SPACE '} ${x.file}:${x.line}  "${x.word}"${x.suggest ? ` → ${x.suggest}` : ''}  ·  ${x.sentence.slice(0, 90)}`);
  }

  if (argv.includes('--check')) {
    const over = Object.entries(counts).filter(([k, n]) => cfg.ratchets[k] === undefined || n > cfg.ratchets[k]);
    if (over.length) {
      for (const [k, n] of over) console.error(cfg.ratchets[k] === undefined ? `✗ no kpred:ui-term-ratchet "${k}/<n>" in ${TERMS}: nothing is enforced for ${k}.` : `✗ ${k}: ${n} on screen, baseline ${cfg.ratchets[k]}. Use the user's word (the line above says which), or declare the file a kpred:technical-surface.`);
      process.exit(1);
    }
    const lower = Object.entries(counts).filter(([k, n]) => n < cfg.ratchets[k]);
    console.log(lower.length ? `! below baseline (${lower.map(([k, n]) => `${k} ${n} < ${cfg.ratchets[k]}`).join(', ')}): lower it to lock the improvement in.` : '✓ at baseline.');
  }

  if (argv.includes('--pending')) {
    const path = join(ROOT, 'reckons-workspace/knowledge.pending.jsonl');
    const lines = all.filter((x) => x.where !== 'script' && (x.check === 'jargon' || x.sense === 'space')).map((x) => JSON.stringify({
      subject: `urn:reckons:file/${x.file}`, predicate: `${KPRED}ui-term`, object: `${x.file}:${x.line} shows "${x.word}"${x.suggest ? `; the user word is "${x.suggest}"` : ''}. Sentence: ${x.sentence.slice(0, 200)}`,
      type: 'suggestion', priority: 'medium', agent: 'offline:ui-terms', addedAt: new Date().toISOString(),
    }));
    if (lines.length) appendFileSync(path, lines.join('\n') + '\n');
    console.log(`--pending: ${lines.length} proposal(s) → ${path}`);
  }

  const taskPath = argv.find((a) => a.startsWith('--task='))?.slice(7);
  if (taskPath) {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts/agent/fixtures/ui-copy-graph.labels.json'), 'utf8')) as { items: { sentence: string; label: string }[] };
    const examples = ['space', 'keep', 'reword'].flatMap((l) => fixture.items.filter((i) => i.label === l).slice(0, 3)).map((i) => `- "${i.sentence.slice(0, 120)}" → ${i.label}`).join('\n');
    writeFileSync(taskPath, JSON.stringify({
      id: 'ui-terms-graph',
      instruction: `A Reckons.AI user sees this sentence containing "graph". The product calls the collection a person opens, names, filters and stars a SPACE. "graph" stays only for the DRAWN picture (nodes and edges on screen) or a standard RDF term (named graph). Answer space, keep or reword. Judged examples:\n${examples}`,
      answer: { type: 'object', properties: { verdict: { type: 'string', enum: ['space', 'keep', 'reword'] }, reason: { type: 'string', maxLength: 200 } }, required: ['verdict', 'reason'] },
      agreeOn: 'verdict',
      items: undecided.map((x) => ({ id: `${x.file}:${x.line}`, context: `FILE ${x.file}\nSENTENCE ${x.sentence}` })),
    }, null, 2));
    console.log(`panel task → ${taskPath} (${undecided.length} undecided). Calibrate first: the panel was right 3 of 59 on this question without examples.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('ui-terms.ts')) main();
