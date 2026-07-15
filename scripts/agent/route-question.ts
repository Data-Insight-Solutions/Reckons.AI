#!/usr/bin/env npx tsx
/**
 * Throw a question to the graph most likely to answer it (F91 phase 2 / kb:qr-throw-forget).
 *
 * Combines the two halves: the RELEVANCE router (src/lib/rdf/question-router.ts) picks WHO could
 * answer, and ask.ts THROWS the question there as a partial fact addressed to that graph. The
 * asker does not wait — the answer returns via the F80 answer-loop whenever it arrives.
 *
 * Candidate graphs here are the repo's own static/*.ttl. In the app they are the user's other
 * graphs; the routing logic is identical, which is the point — a script and the app share one
 * definition of "who could answer this".
 *
 * Usage:
 *   npx tsx scripts/agent/route-question.ts --subject kb:trust-system --predicate confidence \
 *       --question "what confidence should auto-merge use?"
 *   …                                                                     --throw   (actually emit it)
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser } from 'n3';
import { routeQuestion, questionContext, addressees, type CandidateGraph } from '../../src/lib/rdf/question-router.js';
import type { Statement } from '../../src/lib/rdf/types.js';
import { askGraph } from './ask.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const THROW = argv.includes('--throw');

const subjectRaw = flag('subject');
const predicateRaw = flag('predicate');
const question = flag('question');
if (!subjectRaw || !predicateRaw || !question) {
  console.error('Usage: --subject <kb:x> --predicate <kpred:y> --question "…" [--throw]');
  process.exit(2);
}
const KB = 'urn:kbase:concept/', KPRED = 'urn:kbase:predicate/';
const expand = (t: string) => (t.startsWith('kb:') ? KB + t.slice(3) : t.startsWith('kpred:') ? KPRED + t.slice(6) : t);
const subject = expand(subjectRaw);
const predicate = expand(predicateRaw);

/** n3 quads → the app's Statement shape (enough of it for the router). */
function loadGraph(file: string): CandidateGraph {
  const quads = new Parser({ format: 'TriG' }).parse(readFileSync(file, 'utf8'));
  const statements: Statement[] = quads.map((q, i) => ({
    id: `q${i}`,
    s: { kind: q.subject.termType === 'Literal' ? 'literal' : 'iri', value: q.subject.value } as any,
    p: { kind: 'iri', value: q.predicate.value },
    o: { kind: q.object.termType === 'Literal' ? 'literal' : 'iri', value: q.object.value } as any,
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'ttl',
    confidence: 1,
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  }));
  return { id: path.basename(file, '.ttl'), name: path.basename(file), statements };
}

const files = readdirSync('static').filter((f) => f.endsWith('.ttl')).map((f) => path.join('static', f));
const candidates = files.map(loadGraph);

// Build the question's context from whichever graph currently knows the subject (the source).
const source = candidates.find((c) => c.statements.some((s) => s.s.value === subject || s.o.value === subject));
const q = source
  ? questionContext(subject, predicate, source.statements)
  : { subject, predicate };

// Do not route back to the source — it is the graph that could not answer.
const others = candidates.map((c) => (c.id === source?.id ? { ...c, id: '__source__' } : c));
const ranked = routeQuestion(q, others);
const targets = addressees(ranked);

console.log(`${B}Who could answer:${X} ${D}${subjectRaw} · ${predicateRaw}${X}\n`);
if (source) console.log(`  ${D}source (excluded): ${source.name}${X}\n`);
for (const r of ranked.slice(0, 6)) {
  const mark = targets.some((t) => t.id === r.id) ? G + '→' : D + '·';
  console.log(`  ${mark}${X} ${r.score.toFixed(2)}  ${r.name ?? r.id}  ${D}${r.reason}${X}`);
}
console.log('');

if (targets.length === 0) {
  console.log(`${Y}No graph is related enough to address this to. Not throwing — routing, not broadcast.${X}`);
  process.exit(0);
}

if (!THROW) {
  console.log(`${D}Would throw to: ${targets.map((t) => t.name ?? t.id).join(', ')}. Pass --throw to emit.${X}`);
  process.exit(0);
}

// Throw and forget: emit the question addressed to the top graph(s).
for (const t of targets) {
  askGraph({ subject: subjectRaw, predicate: predicateRaw, question, kb: t.id, agent: 'question-router', note: `routed by relatedness (${t.reason})` });
}
console.log(`${G}Thrown to ${targets.length} graph(s): ${targets.map((t) => t.name ?? t.id).join(', ')}.${X}`);
console.log(`${D}The answer returns via the review queue when it arrives. Nobody waited.${X}`);
