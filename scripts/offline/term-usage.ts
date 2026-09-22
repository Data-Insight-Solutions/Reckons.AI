#!/usr/bin/env npx tsx
/**
 * TERM USAGE (F203, SCRIPT tier) — where every term in the terminology graph is actually used,
 * and what it would cost to change it. Deterministic, zero tokens, zero triage.
 *
 * WHY IT EXISTS. static/reckons-terminology.ttl records four different meanings for the bare word
 * `node` and says only one of them is ours to name. That is a claim about a codebase, and a claim
 * about a codebase is worth exactly as much as the count behind it. The counts in that file and in
 * the F203 roadmap entry were produced on 2026-09-17 by two shell one-liners that exist nowhere —
 * unreproducible, already drifting, and cited as evidence. This is those one-liners, checked in.
 *
 * WHAT IT ANSWERS, per term, which is more than a grep can:
 *
 *   HOW MANY / WHERE   occurrences and distinct files, counted over identifier SEGMENTS so that
 *                      `nodeMap`, `MAX_NODES` and `node` all count as the term `node`, which is
 *                      what a rename would actually have to touch.
 *   BINDING CLASS      free / contract / foreign, per occurrence (F203's cost axis). This is the
 *                      number that matters: the free count is the rename headroom, the contract
 *                      count is a data migration, the foreign count can never move at all.
 *   REGISTER           standards / developer / user, per occurrence (F203's audience axis). A term
 *                      with user-register occurrences is interface copy and a rename is visible to
 *                      people; one with none is purely internal.
 *   BLOCKED            terms whose user label is still UNDECIDED, with the occurrence count each
 *                      decision is holding. That is the number that makes a naming decision urgent
 *                      rather than interesting.
 *
 * HOW HONEST IS THE CLASSIFICATION. It is a LINE-LEVEL HEURISTIC and it is wrong at the margins.
 * A line mentioning `urn:kbase:` is called contract even if the occurrence on it is a local
 * variable; a `.svelte` line outside <script> is called user-visible even if it is a CSS class.
 * It is deliberately biased toward over-reporting contract and foreign, because the failure that
 * costs something is renaming a serialized name by mistake, not leaving a free one alone. Treat
 * the free count as an UPPER BOUND on what is safe to rename, never as a work order.
 *
 * It also does not disambiguate homonyms and cannot: nothing in a line tells a script whether
 * `node` there means an RDF term or a drawn marker. Tokens with several candidate meanings are
 * reported as one token with all its meanings listed — measuring the ambiguity is the point.
 *
 * Usage:
 *   npx tsx scripts/offline/term-usage.ts               report
 *   npx tsx scripts/offline/term-usage.ts --term=node   one term, with its top files
 *   npx tsx scripts/offline/term-usage.ts --json        machine-readable
 *   npx tsx scripts/offline/term-usage.ts --pending      queue findings for review in Reckons.AI
 */

import { Parser, type Quad } from 'n3';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { queueFindings } from './pending-queue.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const TERMINOLOGY = join(ROOT, 'static/reckons-terminology.ttl');
const SCAN_ROOTS = ['src', 'content'];
const SCAN_EXTENSIONS = ['.ts', '.svelte', '.md'];

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const PENDING_OUT = argv.includes('--pending');
const ONLY_TERM = argv.find((a) => a.startsWith('--term='))?.slice('--term='.length);

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const KPRED = 'urn:kbase:predicate/';
const KBIND = 'urn:kbase:type/binding/';

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

export type BindingClass = 'free' | 'contract' | 'foreign';
export type Register = 'standards' | 'developer' | 'user';

export type Term = {
  iri: string;
  id: string;
  prefLabel: string;
  standardsLabel?: string;
  userLabel?: string;
  binding: BindingClass;
  tokens: string[];
};

/**
 * CONTRACT MARKERS — a line touching one of these is serializing or addressing something, so any
 * identifier on it may be part of a name somebody's stored data depends on. Over-inclusive on
 * purpose: the cost of a false contract is that a rename is reviewed by a human, and the cost of a
 * false free is a migration nobody planned.
 */
export const CONTRACT_MARKERS: { why: string; re: RegExp }[] = [
  { why: 'urn: namespace', re: /urn:(kbase|reckons):/ },
  { why: 'dexie store or database name', re: /\.stores\(|\.version\(\s*\d|indexedDB|dbName|databaseName|resolveDbName/ },
  { why: 'browser storage key', re: /localStorage|sessionStorage/ },
  { why: 'url parameter', re: /searchParams|URLSearchParams|\?kb=/ },
  { why: 'turtle prefix or predicate', re: /@prefix|\bkpred:|\bktype:|\bkmeta:|\bkterm:|\bkbind:|\bkreg:/ },
  { why: 'export or import format', re: /\.ttl\b|\.trig\b|text\/turtle|application\/ld\+json/ },
];

/**
 * FOREIGN MARKERS — a line mentioning somebody else's API. Their word is not ours to change; the
 * only available move is to qualify OUR uses so the bare word never stands alone beside theirs.
 */
export const FOREIGN_MARKERS: { why: string; re: RegExp }[] = [
  { why: 'three.js / threlte', re: /\bTHREE\b|from ['"]three|@threlte|\bObject3D\b|\bBufferGeometry\b|\bWebGLRenderer\b/ },
  { why: 'rdf-js / n3', re: /\bNamedNode\b|\bBlankNode\b|\bDataFactory\b|from ['"]n3['"]|\bQuad\b|\bDatasetCore\b/ },
  { why: 'node.js runtime', re: /from ['"]node:|require\(['"]node:|\bprocess\.(env|argv|cwd)\b|\b__dirname\b/ },
  { why: 'w3c vocabulary', re: /\b(skos|sh|prov|rdfs|rdf|xsd|dcterms|foaf|owl):[A-Za-z]/ },
];

/**
 * KEYWORD COLLISIONS — tokens that are also language or markup syntax, and the contexts in which
 * an occurrence is therefore NOT about our concept at all.
 *
 * Without this the report is worthless for exactly the terms that matter most. `type` is a
 * TypeScript keyword before it is our word for a kind of thing; `class` is an HTML attribute on
 * nearly every element we render; `set` is the prefix of every setter and the name of a built-in
 * collection. A first run counted 6030 uses of `class`, of which essentially all were `class="..."`.
 *
 * Every exclusion is COUNTED AND REPORTED, never silently dropped — a filter you cannot see is a
 * filter you cannot check.
 */
export const KEYWORD_EXCLUSIONS: Record<string, RegExp> = {
  class: /class\s*=|className|\bclass\s+[A-Z]|\bclass\b\s*\{/,
  type: /\b(import|export)\s+type\b|\btype\s+[A-Z][A-Za-z0-9_]*\s*[=<]|\btypeof\b|\btype\s*=\s*['"]|:\s*type\b|\btype\s*:\s*['"]/,
  set: /\bnew\s+Set\b|\bSet</,
  group: /\brole\s*=\s*['"]group|<g\b|\bgroup\s*\(/,
};

/** Does the immediate context around this occurrence make it syntax rather than our term? */
export function isKeywordUse(token: string, line: string, at: number): boolean {
  const rule = KEYWORD_EXCLUSIONS[token];
  if (!rule) return false;
  return rule.test(line.slice(Math.max(0, at - 32), at + 32));
}

/** A .ts line whose string is bound to something a person reads on screen. */
export const USER_COPY_RE =
  /\b(title|label|placeholder|tooltip|heading|caption|summary|description|message|aria-label|ariaLabel)\s*[:=]\s*['"`]/;

/** Split an identifier into lowercase segments: nodeMap -> [node, map], MAX_NODES -> [max, nodes]. */
export function segmentsOf(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Crude singular: `nodes` and `node` are the same term for renaming purposes, `status` is not. */
export function singular(seg: string): string {
  if (seg.length > 3 && seg.endsWith('ies')) return `${seg.slice(0, -3)}y`;
  if (seg.length > 3 && seg.endsWith('ses')) return seg.slice(0, -2);
  if (seg.length > 2 && seg.endsWith('s') && !seg.endsWith('ss') && !seg.endsWith('us')) return seg.slice(0, -1);
  return seg;
}

export function bindingOfLine(line: string): { binding: BindingClass; why?: string } {
  for (const m of CONTRACT_MARKERS) if (m.re.test(line)) return { binding: 'contract', why: m.why };
  for (const m of FOREIGN_MARKERS) if (m.re.test(line)) return { binding: 'foreign', why: m.why };
  return { binding: 'free' };
}

export function registerOfLine(line: string, file: string): Register {
  if (file.endsWith('.md')) return 'user';
  if (USER_COPY_RE.test(line)) return 'user';
  for (const m of FOREIGN_MARKERS) if (m.re.test(line)) return 'standards';
  return 'developer';
}

/**
 * Is this position inside a markup TAG rather than in the text a person reads?
 *
 * The distinction is the whole user register. `<button class="graph-toggle">Graph</button>` has
 * two occurrences of the word and only the second one is copy; counting the attribute as
 * user-facing was what made a first run claim 3748 user-register uses of `class`.
 */
export function insideTag(line: string, at: number): boolean {
  const before = line.slice(0, at);
  return before.lastIndexOf('<') > before.lastIndexOf('>');
}

function literal(quads: Quad[], subject: string, predicate: string): string | undefined {
  return quads.find((q) => q.subject.value === subject && q.predicate.value === predicate)?.object.value;
}

function literals(quads: Quad[], subject: string, predicate: string): string[] {
  return quads.filter((q) => q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object.value);
}

export function readTerms(ttl: string): Term[] {
  const quads = new Parser().parse(ttl);
  const subjects = [...new Set(quads.map((q) => q.subject.value))].filter((s) => s.startsWith('urn:kbase:term/'));
  const terms: Term[] = [];
  for (const iri of subjects) {
    const prefLabel = literal(quads, iri, `${SKOS}prefLabel`);
    if (!prefLabel) continue;
    const bindingIri = literal(quads, iri, `${KPRED}binding-class`) ?? `${KBIND}free`;
    const binding = bindingIri.slice(KBIND.length) as BindingClass;
    // The tokens a rename would have to find: what people actually type (hiddenLabel) plus the
    // preferred label when it is a single word. Multi-word labels ("named graph") are matched by
    // their hidden labels instead, because no identifier contains a space.
    const tokens = new Set<string>();
    for (const h of literals(quads, iri, `${SKOS}hiddenLabel`)) {
      for (const seg of segmentsOf(h)) tokens.add(singular(seg));
    }
    const prefSegments = segmentsOf(prefLabel);
    if (prefSegments.length === 1) tokens.add(singular(prefSegments[0]));
    terms.push({
      iri,
      id: iri.slice('urn:kbase:term/'.length),
      prefLabel,
      standardsLabel: literal(quads, iri, `${KPRED}standards-label`),
      userLabel: literal(quads, iri, `${KPRED}user-label`),
      binding: (['free', 'contract', 'foreign'] as const).includes(binding) ? binding : 'free',
      tokens: [...tokens],
    });
  }
  return terms.sort((a, b) => a.id.localeCompare(b.id));
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

export type TokenUsage = {
  token: string;
  meanings: Term[];
  occurrences: number;
  /** Occurrences discarded as language or markup syntax. Reported, never silent. */
  excluded: number;
  files: Set<string>;
  binding: Record<BindingClass, number>;
  register: Record<Register, number>;
  byFile: Map<string, number>;
  bindingWhy: Map<string, number>;
};

function emptyUsage(token: string, meanings: Term[]): TokenUsage {
  return {
    token,
    meanings,
    occurrences: 0,
    excluded: 0,
    files: new Set(),
    binding: { free: 0, contract: 0, foreign: 0 },
    register: { standards: 0, developer: 0, user: 0 },
    byFile: new Map(),
    bindingWhy: new Map(),
  };
}

/** One file, line by line. Exported so a test can drive it without touching the filesystem. */
export function scanText(text: string, file: string, tokens: Map<string, TokenUsage>): void {
  const isSvelte = file.endsWith('.svelte');
  let inScript = false;
  let inStyle = false;
  for (const raw of text.split('\n')) {
    if (isSvelte) {
      if (/<script\b/.test(raw)) inScript = true;
      if (/<style\b/.test(raw)) inStyle = true;
    }
    const inMarkup = isSvelte && !inScript && !inStyle;
    const { binding, why } = bindingOfLine(raw);
    const lineRegister = registerOfLine(raw, file);
    const words = raw.matchAll(/[A-Za-z][A-Za-z0-9_$]*/g);
    for (const match of words) {
      const at = match.index ?? 0;
      const register: Register = inMarkup && !insideTag(raw, at) ? 'user' : lineRegister;
      for (const seg of segmentsOf(match[0])) {
        const token = singular(seg);
        const usage = tokens.get(token);
        if (!usage) continue;
        if (isKeywordUse(token, raw, at)) {
          usage.excluded += 1;
          continue;
        }
        usage.occurrences += 1;
        usage.files.add(file);
        usage.binding[binding] += 1;
        usage.register[register] += 1;
        usage.byFile.set(file, (usage.byFile.get(file) ?? 0) + 1);
        if (why) usage.bindingWhy.set(why, (usage.bindingWhy.get(why) ?? 0) + 1);
      }
    }
    if (isSvelte) {
      if (/<\/script>/.test(raw)) inScript = false;
      if (/<\/style>/.test(raw)) inStyle = false;
    }
  }
}

function main(): void {
  let ttl: string;
  try {
    ttl = readFileSync(TERMINOLOGY, 'utf8');
  } catch {
    console.error(C.red(`No terminology graph at ${relative(ROOT, TERMINOLOGY)}. Nothing to measure.`));
    process.exit(1);
  }

  const terms = readTerms(ttl);
  if (terms.length === 0) {
    console.error(C.red('The terminology graph parsed but defines no urn:kbase:term/ concepts.'));
    process.exit(1);
  }

  const tokens = new Map<string, TokenUsage>();
  for (const term of terms) {
    for (const token of term.tokens) {
      if (ONLY_TERM && token !== ONLY_TERM) continue;
      const existing = tokens.get(token);
      if (existing) existing.meanings.push(term);
      else tokens.set(token, emptyUsage(token, [term]));
    }
  }
  if (tokens.size === 0) {
    console.error(C.red(ONLY_TERM ? `No term in the graph uses the token "${ONLY_TERM}".` : 'No tokens to scan.'));
    process.exit(1);
  }

  const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));
  for (const file of files) {
    const rel = relative(ROOT, file);
    scanText(readFileSync(file, 'utf8'), rel, tokens);
  }

  const usages = [...tokens.values()].sort((a, b) => b.occurrences - a.occurrences);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          measuredAt: new Date().toISOString().slice(0, 10),
          scanned: { roots: SCAN_ROOTS, files: files.length },
          tokens: usages.map((u) => ({
            token: u.token,
            occurrences: u.occurrences,
            excluded: u.excluded,
            files: u.files.size,
            binding: u.binding,
            register: u.register,
            meanings: u.meanings.map((m) => ({ id: m.id, prefLabel: m.prefLabel, binding: m.binding })),
            topFiles: [...u.byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => ({ file: f, n })),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(C.bold('\nTERM USAGE — static/reckons-terminology.ttl against the source tree'));
  console.log(
    C.dim(
      `  ${terms.length} terms, ${tokens.size} tokens, scanned ${files.length} files under ${SCAN_ROOTS.join(', ')}\n` +
        '  Binding class is a LINE-LEVEL heuristic biased toward contract/foreign. free = upper bound on safe renames.',
    ),
  );

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    C.bold(
      `\n  ${pad('TOKEN', 14)}${pad('USES', 7)}${pad('FILES', 7)}${pad('FREE', 7)}${pad('CONTRACT', 10)}${pad('FOREIGN', 9)}${pad('USER', 7)}MEANINGS`,
    ),
  );
  for (const u of usages) {
    const homonym = u.meanings.length > 1;
    const name = homonym ? C.yellow(pad(u.token, 14)) : pad(u.token, 14);
    console.log(
      `  ${name}${pad(String(u.occurrences), 7)}${pad(String(u.files.size), 7)}` +
        `${C.green(pad(String(u.binding.free), 7))}${C.magenta(pad(String(u.binding.contract), 10))}` +
        `${C.dim(pad(String(u.binding.foreign), 9))}${C.cyan(pad(String(u.register.user), 7))}` +
        `${u.meanings.length} ${u.meanings.map((m) => m.prefLabel).join(' / ')}`,
    );
  }

  if (ONLY_TERM) {
    for (const u of usages) {
      console.log(C.bold(`\n  ${u.token} — top files`));
      for (const [f, n] of [...u.byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        console.log(`    ${pad(String(n), 6)}${f}`);
      }
      if (u.bindingWhy.size) {
        console.log(C.bold(`\n  ${u.token} — why lines were called contract or foreign`));
        for (const [why, n] of [...u.bindingWhy.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`    ${pad(String(n), 6)}${why}`);
        }
      }
    }
  }

  const filtered = usages.filter((u) => u.excluded > 0).sort((a, b) => b.excluded - a.excluded);
  if (filtered.length) {
    console.log(
      C.dim(
        '\n  Discarded as language or markup syntax, not as our term: ' +
          filtered.map((u) => `${u.token} ${u.excluded}`).join(', '),
      ),
    );
  }

  // ── The decisions this measurement is waiting on ──────────────────────────
  const undecided = terms.filter((t) => /UNDECIDED/i.test(t.userLabel ?? ''));
  const held = undecided.map((t) => {
    const n = t.tokens.reduce((sum, tok) => sum + (tokens.get(tok)?.occurrences ?? 0), 0);
    const f = new Set(t.tokens.flatMap((tok) => [...(tokens.get(tok)?.files ?? [])]));
    return { term: t, occurrences: n, files: f.size };
  });
  if (held.length) {
    console.log(C.bold(C.red('\n  BLOCKED ON A NAMING DECISION')));
    for (const h of held) {
      console.log(
        `    ${C.bold(h.term.prefLabel)} — ${h.occurrences} occurrences across ${h.files} files are waiting on it ` +
          C.dim(`(${h.term.binding})`),
      );
    }
  }

  // ── Terms the graph defines that the code never uses ──────────────────────
  const unused = terms.filter((t) => t.tokens.every((tok) => (tokens.get(tok)?.occurrences ?? 0) === 0));
  if (unused.length && !ONLY_TERM) {
    console.log(C.bold(C.yellow('\n  DEFINED BUT NEVER USED')));
    for (const t of unused) console.log(`    ${t.prefLabel} ${C.dim(t.iri)}`);
  }

  console.log('');

  if (PENDING_OUT) {
    const now = new Date().toISOString().slice(0, 10);
    const findings = [
      ...held.map((h) => ({
        subject: h.term.iri,
        predicate: `${KPRED}user-label`,
        question:
          `[term-usage] "${h.term.prefLabel}" has no decided user-facing word, and ${h.occurrences} occurrences ` +
          `across ${h.files} files are waiting on it (binding class: ${h.term.binding}). Measured ${now}.`,
        kb: 'roadmap',
        type: 'question' as const,
        priority: 'high' as const,
        blocks: 'urn:kbase:concept/terminology-ontology',
      })),
      ...usages
        .filter((u) => u.meanings.length > 1 && u.binding.free > 0)
        .map((u) => ({
          subject: 'urn:kbase:concept/terminology-ontology',
          predicate: `${KPRED}measured`,
          question:
            `[term-usage] The token "${u.token}" carries ${u.meanings.length} meanings ` +
            `(${u.meanings.map((m) => m.prefLabel).join(', ')}) over ${u.occurrences} occurrences in ${u.files.size} files. ` +
            `${u.binding.free} are free to rename, ${u.binding.contract} are contract-bound and ${u.binding.foreign} are foreign. ` +
            `Measured ${now}.`,
          kb: 'roadmap',
          type: 'observation' as const,
          priority: 'normal' as const,
        })),
    ];
    const result = queueFindings(findings, { agent: 'offline:term-usage', recomputes: true, kb: 'roadmap' });
    console.log(
      C.dim(`  queued ${result.queued}, skipped ${result.skipped} duplicates, superseded ${result.superseded}\n`),
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith('term-usage.ts')) main();
