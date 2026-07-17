#!/usr/bin/env npx tsx
/**
 * Return a routed answer to the graph that asked (F91 phase 2 / kb:qr-throw-forget).
 *
 * This closes the loop. `route-question.ts` throws a question to the graph most related to it,
 * stamped with a RETURN ADDRESS (`askedByGraph` = the origin that could not answer). When that
 * question gets answered, the answer must not just sit in the shared answers file — it has to go
 * BACK to the origin, where the question came from.
 *
 * So: correlate each new answer to the routed question it settles (same subject+predicate,
 * carrying `askedByGraph`), and emit the answer into the ORIGIN graph's pending queue as a fact —
 * but an EXTERNAL one:
 *
 *   verifiable-by external-graph · answered-by-graph <the answerer> · hop-chain [origin, answerer]
 *
 * A returned answer is another party's CLAIM, not our verified knowledge. It enters pending and
 * is always reviewed (F88: competentGate('external-graph') is never 'machine'). An unverifiable
 * claim, made by the party it benefits, is not evidence — so it arrives labelled as exactly what
 * it is, and a human decides whether to accept another graph's word into their own graph.
 *
 * Throw and forget: the asker never waited. The answer arrives here, on a later pass, possibly a
 * different session — because the question outlived the conversation by living in the graph.
 *
 * Usage:
 *   npx tsx scripts/agent/return-answer.ts            return new answers to their origin graphs
 *   npx tsx scripts/agent/return-answer.ts --peek     show what would return, advance nothing
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { readAnswers } from './answers.js';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const ANSWERS = 'reckons-workspace/knowledge.answers.jsonl';
const CURSOR = 'reckons-workspace/.reckons-return-cursor';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
const argv = process.argv.slice(2);
const PEEK = argv.includes('--peek');

interface Pending {
  subject: string;
  predicate: string;
  kb?: string; // the graph the question was addressed TO — i.e. the answerer
  askedByGraph?: string; // the RETURN ADDRESS — the origin that could not answer
  question?: string;
}

const readJsonl = (f: string): any[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];

// Routed questions: the ones that carry a return address. Keyed by subject+predicate so an
// answer can be matched back to the graph that asked and the graph that was asked.
const routed = new Map<string, Pending>();
for (const p of readJsonl(PENDING) as Pending[]) {
  if (p.askedByGraph) routed.set(`${p.subject}|${p.predicate}`, p);
}

const allAnswers = readAnswers(ANSWERS);
const cursor = existsSync(CURSOR) ? Number(readFileSync(CURSOR, 'utf8').trim()) || 0 : 0;
const from = cursor <= allAnswers.length ? cursor : 0;
const fresh = allAnswers.slice(from);

console.log(`${B}Return routed answers${X} ${D}— ${routed.size} routed question(s) outstanding, ${fresh.length} new answer(s)${X}\n`);

let returned = 0;
const existingPending = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';

for (const a of fresh) {
  const q = routed.get(`${a.subject}|${a.predicate}`);
  if (!q) continue; // not a routed question — an ordinary local answer, not our concern

  const origin = q.askedByGraph!;
  const answerer = q.kb ?? '__unknown__';

  // The returned fact: an ASSERTION (has an object) addressed back to the origin graph, labelled
  // as an external claim so it is reviewed, never machine-accepted.
  const entry = {
    subject: a.subject,
    predicate: a.predicate,
    object: a.object,
    objectKind: a.objectKind ?? 'literal',
    kb: origin, // deliver to the origin graph's queue
    verifiableBy: 'external-graph',
    answeredByGraph: answerer,
    hopChain: [origin, answerer],
    type: 'observation' as const,
    agent: 'question-router:return',
    priority: 'medium' as const,
    note: `Answer to a routed question, returned from ${answerer}. Another graph's claim — review before accepting.`,
    addedAt: new Date().toISOString(),
    addedByMcp: true,
  };

  // Idempotent: do not return the same answer to the same origin twice.
  const dupe = existingPending.includes(`"answeredByGraph":"${answerer}"`) &&
    existingPending.includes(`"subject":"${a.subject}"`) &&
    existingPending.includes(`"object":${JSON.stringify(a.object)}`);

  console.log(`  ${G}←${X} ${a.subject.split('/').pop()} ${a.predicate.split('/').pop()} = "${String(a.object).slice(0, 40)}"`);
  console.log(`     ${D}${answerer} → ${origin}  ·  external-graph, hop [${origin} → ${answerer}]${dupe ? ' (already returned)' : ''}${X}`);

  if (!PEEK && !dupe) {
    appendFileSync(PENDING, JSON.stringify(entry) + '\n');
    returned++;
  }
}

if (fresh.length > 0 && !PEEK) writeFileSync(CURSOR, String(allAnswers.length));

console.log('');
if (returned === 0) console.log(`${Y}No routed answers to return.${X} ${D}Nobody's question came back this pass.${X}`);
else console.log(`${G}Returned ${returned} answer(s)${X} ${D}to their origin graphs, as reviewable external claims.${X}`);
