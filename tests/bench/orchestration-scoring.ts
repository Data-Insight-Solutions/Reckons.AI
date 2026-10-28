/**
 * ORCHESTRATION SCORING — parse a model's answer once, then score each expectation as a
 * predicate over the PARSED output, never over keywords in the raw text.
 *
 * The first version of this bench scored by keyword presence, and every "syntax/valid"
 * expectation passed unconditionally — so an answer that only said "script opus immediate
 * @prefix" scored well, and 34/36 vs 33/36 did not discriminate between models
 * (Opus review, 2026-10-27). Here TTL must parse with N3 (an undeclared prefix is a parse
 * error), JSON must parse, and a routing answer must name a tier for the right finding.
 * `__tests__/orchestration-scoring.test.ts` holds a reference answer per task (full marks)
 * and a keyword-stuffed one (near zero), which is the evidence that the scorer discriminates.
 */

import { Parser, type Quad } from 'n3';
import type { OrchestrationTask } from './orchestration-tasks.js';

export const NS = {
  kpred: 'urn:kbase:predicate/',
  ktype: 'urn:kbase:type/',
  sched: 'urn:reckons:schedule/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
} as const;

export interface Ttl {
  quads: Quad[];
  prefixes: Record<string, string>;
  error?: string;
}

export interface ParsedOutput {
  /** Answer text with any <think>…</think> block removed. */
  text: string;
  /** Every JSON value found: fenced blocks, the whole answer, or one per JSONL line. */
  json: unknown[];
  /** The Turtle in the answer, parsed; null when the answer contains none. */
  ttl: Ttl | null;
  /** `FINDING <n> → tier=…, model=…, action=…` lines, keyed by n. */
  findings: Map<number, { tier: string; model: string; action: string }>;
}

const FENCE = /```([\w-]*)\s*\n([\s\S]*?)```/g;

function tryJson(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

function extractJson(text: string): unknown[] {
  const out: unknown[] = [];
  const perLine = (block: string) => {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{') && !t.startsWith('[')) continue;
      const v = tryJson(t);
      if (v !== undefined) out.push(v);
    }
  };
  const fences = [...text.matchAll(FENCE)].filter(([, lang]) => !/^(ttl|turtle|n3)$/i.test(lang));
  for (const [, , body] of fences) {
    const whole = tryJson(body.trim());
    if (whole !== undefined) out.push(whole); else perLine(body);
  }
  if (out.length) return out;
  const whole = tryJson(text.trim());
  if (whole !== undefined) return [whole];
  perLine(text);
  if (out.length) return out;
  // Last resort: one bracketed region (prose before/after a single JSON value).
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const a = text.indexOf(open), b = text.lastIndexOf(close);
    if (a >= 0 && b > a) {
      const v = tryJson(text.slice(a, b + 1));
      if (v !== undefined) return [v];
    }
  }
  return out;
}

function extractTurtle(text: string): string | null {
  const fenced = [...text.matchAll(FENCE)]
    .filter(([, lang, body]) => /^(ttl|turtle|n3)$/i.test(lang) || /@prefix/.test(body))
    .map(([, , body]) => body);
  if (fenced.length) return fenced.join('\n');
  const start = text.indexOf('@prefix');
  if (start < 0) return null;
  // Unfenced: from the first @prefix to the last line that ends a statement.
  const lines = text.slice(start).split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (/\.\s*(#.*)?$/.test(l.trim())) last = i; });
  return last >= 0 ? lines.slice(0, last + 1).join('\n') : lines.join('\n');
}

function parseTurtle(src: string): Ttl {
  const prefixes: Record<string, string> = {};
  try {
    const quads = new Parser().parse(src, null, (p, iri) => { prefixes[p] = typeof iri === 'string' ? iri : iri.value; });
    return { quads, prefixes };
  } catch (e) {
    return { quads: [], prefixes, error: (e as Error).message };
  }
}

const FINDING = /FINDING\s*#?\s*(\d+)\s*(?:→|->|:|-)\s*(.*)$/i;

function extractFindings(text: string): ParsedOutput['findings'] {
  const found: ParsedOutput['findings'] = new Map();
  for (const line of text.split('\n')) {
    const m = line.replace(/[*`]/g, '').match(FINDING);
    if (!m) continue;
    const field = (k: string) => m[2].match(new RegExp(`${k}\\s*=\\s*([^,]*)`, 'i'))?.[1].trim() ?? '';
    const action = m[2].match(/action\s*=\s*(.*)$/i)?.[1].trim() ?? '';
    found.set(Number(m[1]), { tier: normalizeTier(field('tier')), model: field('model'), action });
  }
  return found;
}

/** Collapse tier spellings to script | agent-local | agent-subagent | opus | '' (unknown). */
export function normalizeTier(raw: string): string {
  const t = raw.toLowerCase();
  if (/opus/.test(t)) return 'opus';
  if (/sub-?agent|sonnet|haiku/.test(t)) return 'agent-subagent';
  if (/script|determin/.test(t)) return 'script';
  if (/agent|local|model/.test(t)) return 'agent-local';
  return '';
}

export function parseOutput(raw: string): ParsedOutput {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const turtle = extractTurtle(text);
  return {
    text,
    json: extractJson(text),
    ttl: turtle === null ? null : parseTurtle(turtle),
    findings: extractFindings(text),
  };
}

// ── Graph helpers for the per-task checks ─────────────────────────────────────

export const okTtl = (o: ParsedOutput): Ttl | null => (o.ttl && !o.ttl.error && o.ttl.quads.length ? o.ttl : null);

export function subjectsOfType(ttl: Ttl, typeIri: string): string[] {
  return [...new Set(ttl.quads
    .filter((q) => q.predicate.value === `${NS.rdf}type` && q.object.value === typeIri)
    .map((q) => q.subject.value))];
}

export function objectsOf(ttl: Ttl, subject: string, predicate: string): string[] {
  return ttl.quads.filter((q) => q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object.value);
}

export const one = (ttl: Ttl, s: string, p: string): string | undefined => objectsOf(ttl, s, p)[0];

/** Plain objects anywhere in the JSON values (one level of array nesting). */
export function jsonObjects(o: ParsedOutput): Record<string, unknown>[] {
  return o.json.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface ExpectationResult { n: number; text: string; pass: boolean; detail?: string }

export interface ScoredTask {
  score: number;
  maxScore: number;
  expectations: ExpectationResult[];
  /** Why the structured part could not be read, if it could not — reported, not scored twice. */
  parseNote?: string;
}

export function scoreOutput(task: OrchestrationTask, raw: string): ScoredTask {
  const parsed = parseOutput(raw);
  const expectations = task.scoring.map((e) => {
    let pass = false;
    let detail: string | undefined;
    try { pass = e.check(parsed); } catch (err) { detail = `check threw: ${(err as Error).message}`; }
    return { n: e.n, text: e.text, pass, detail };
  });
  let parseNote: string | undefined;
  if (task.output === 'ttl' || task.output === 'jsonl+ttl') {
    if (!parsed.ttl) parseNote = 'no Turtle found';
    else if (parsed.ttl.error) parseNote = `Turtle does not parse: ${parsed.ttl.error}`;
  }
  if (!parseNote && (task.output === 'json' || task.output === 'jsonl+ttl') && parsed.json.length === 0) parseNote = 'no JSON found';
  if (!parseNote && task.output === 'findings' && parsed.findings.size === 0) parseNote = 'no FINDING lines found';
  return { score: expectations.filter((e) => e.pass).length, maxScore: expectations.length, expectations, parseNote };
}
