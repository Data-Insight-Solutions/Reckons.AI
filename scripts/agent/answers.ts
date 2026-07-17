#!/usr/bin/env npx tsx
/**
 * Collect the answers Matt left, and resume (F80 / kb:async-orchestration, SCRIPT tier).
 *
 * The other half of `ask.ts`. When Matt resolves a partial fact — in the Review tab's
 * entity picker, in Shelly, or by editing the triple — the app calls recordAnswer(),
 * which appends a line to knowledge.answers.jsonl. This reads those lines.
 *
 * A CURSOR (.reckons-agent-cursor) records what has already been consumed, so an agent
 * that runs every few minutes sees each answer exactly once and does not re-do work.
 *
 * The point of the whole design: an agent NEVER waits on a human. It asks, it works on
 * something else, and it picks the answer up on a later pass — possibly in a completely
 * different session, days later. The question outlives the conversation because it lives
 * in the graph.
 *
 * Usage:
 *   npm run agent:answers              new answers since the cursor, then advance it
 *   npm run agent:answers -- --all     every answer ever, cursor untouched
 *   npm run agent:answers -- --peek    new answers, but do NOT advance the cursor
 *   npm run agent:answers -- --json    machine-readable
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';

const ANSWERS = 'reckons-workspace/knowledge.answers.jsonl';
const CURSOR = 'reckons-workspace/.reckons-agent-cursor';

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const PEEK = argv.includes('--peek');
const JSON_OUT = argv.includes('--json');

export interface Answer {
  subject: string;
  predicate: string;
  object: string;
  objectKind: 'iri' | 'literal';
  agent?: string;
  question?: string;
  answeredAt?: string;
}

/** Parse the answers file, skipping malformed lines rather than dying on one bad byte. */
export function readAnswers(file = ANSWERS): Answer[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Answer];
      } catch {
        return [];
      }
    });
}

export function readCursor(file = CURSOR): number {
  if (!existsSync(file)) return 0;
  const n = Number(readFileSync(file, 'utf8').trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writeCursor(n: number, file = CURSOR): void {
  writeFileSync(file, String(n));
}

/** Answers the agent has not yet seen. */
export function newAnswers(file = ANSWERS, cursorFile = CURSOR): { answers: Answer[]; total: number } {
  const all = readAnswers(file);
  const cursor = readCursor(cursorFile);
  // The file is append-only. If it somehow shrank (a manual edit, a reset), do not skip
  // answers — re-read from the start rather than silently swallowing the difference.
  const from = cursor <= all.length ? cursor : 0;
  return { answers: all.slice(from), total: all.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('answers.ts');
if (isMain) {
  const all = readAnswers();
  const { answers, total } = ALL ? { answers: all, total: all.length } : newAnswers();

  if (JSON_OUT) {
    console.log(JSON.stringify(answers, null, 2));
  } else if (answers.length === 0) {
    console.log('No new answers. Matt has not resolved anything since the last pass.');
    console.log('Keep working on unblocked tasks — do not wait.');
  } else {
    const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', X = '\x1b[0m';
    console.log(`${B}${answers.length} answer(s) resolved${X}\n`);
    for (const a of answers) {
      console.log(`  ${G}✓${X} ${B}${a.question ?? `${a.subject} ${a.predicate}`}${X}`);
      console.log(`      → ${a.object}  ${D}(${a.objectKind})${X}`);
      if (a.answeredAt) console.log(`      ${D}${a.answeredAt}${X}`);
    }
    console.log(`\n${D}These questions are now settled. Resume the work they were blocking.${X}`);
  }

  if (!ALL && !PEEK && answers.length > 0) writeCursor(total);
}
