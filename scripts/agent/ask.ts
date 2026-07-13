#!/usr/bin/env npx tsx
/**
 * Ask the graph, not the human (F80 / kb:async-orchestration, SCRIPT tier).
 *
 * When an agent needs a decision it must NOT block on Matt — he is AFK most of the time,
 * and a question that takes him ten seconds can stall the pipeline for hours. Instead the
 * agent leaves the question IN THE GRAPH as a partial fact (F32) and picks up other work.
 *
 * A partial fact is a triple whose object is unknown: subject and predicate are asserted,
 * the object is '?', and `needsObject: true` makes the Review tab render an entity picker
 * instead of accept/reject. Matt answers whenever he likes — in the picker, in Shelly, or
 * by editing the triple — and recordAnswer() writes it to knowledge.answers.jsonl, where
 * a polling agent resumes (see `answers.ts`).
 *
 * Why the graph rather than chat: a question left as a partial fact is reviewable,
 * searchable, dated, mergeable, and still there tomorrow. A question asked in chat dies
 * with the session.
 *
 * NEVER GUESS. An agent that cannot proceed asks and moves on. A guess quietly entered
 * into a knowledge graph is worse than a stalled task — it is indistinguishable from a
 * fact.
 *
 * Usage:
 *   npx tsx scripts/agent/ask.ts \
 *     --subject kb:async-orchestration \
 *     --predicate kpred:merge-threshold \
 *     --question "What confidence should auto-merge at, without review?" \
 *     [--blocks kb:auto-merge] [--agent claude-code] [--priority high] [--note "..."]
 *
 * Prints the question id. Exits 0. Does not wait.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const KB = 'urn:kbase:concept/';
const KPRED = 'urn:kbase:predicate/';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

/** `kb:foo` → full IRI; anything already absolute is left alone. */
export function expandIri(term: string, defaultNs = KB): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(term) && !term.startsWith('kb:') && !term.startsWith('kpred:')) return term;
  if (term.startsWith('kb:')) return KB + term.slice(3);
  if (term.startsWith('kpred:')) return KPRED + term.slice(6);
  return defaultNs + term;
}

export interface Question {
  subject: string;
  predicate: string;
  question: string;
  /**
   * Target graph, by name. A question about kb:auto-merge belongs in the Reckons.AI
   * roadmap graph, NOT in whatever the user happens to have open. The app leaves entries
   * addressed elsewhere in the file rather than misfiling them.
   * Omit to mean "any graph".
   */
  kb?: string;
  /** The work this question blocks. Lets other agents pick up what is NOT waiting. */
  blocks?: string;
  agent?: string;
  priority?: 'low' | 'medium' | 'high';
  note?: string;
}

/**
 * Emit a question as a partial fact. Idempotent: asking the same thing twice does not
 * queue it twice — the reviewer should never triage the same question again.
 */
export function askGraph(q: Question, pendingPath = PENDING): { queued: boolean; line: string } {
  const subject = expandIri(q.subject);
  const predicate = expandIri(q.predicate, KPRED);

  const entry = {
    subject,
    predicate,
    // NO `object` key: that is what makes this a PARTIAL FACT rather than an assertion.
    // drainWorkspacePending() sees the missing object and sets needsObject:true, object '?'.
    question: q.question,
    note: q.note,
    ...(q.kb ? { kb: q.kb } : {}),
    ...(q.blocks ? { blocks: expandIri(q.blocks) } : {}),
    type: 'question' as const,
    agent: q.agent ?? 'agent',
    priority: q.priority ?? 'medium',
    addedAt: new Date().toISOString(),
    addedByMcp: true,
  };

  const line = JSON.stringify(entry);

  mkdirSync(path.dirname(pendingPath), { recursive: true });
  const existing = existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8') : '';

  // Dedupe on (subject, predicate, question) — not on the whole line, which carries a
  // timestamp and would never match.
  const already = existing
    .split('\n')
    .filter(Boolean)
    .some((l) => {
      try {
        const d = JSON.parse(l);
        return d.subject === subject && d.predicate === predicate && d.question === q.question;
      } catch {
        return false;
      }
    });
  if (already) return { queued: false, line };

  appendFileSync(pendingPath, line + '\n');
  return { queued: true, line };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const subject = flag('subject');
  const predicate = flag('predicate');
  const question = flag('question');

  if (!subject || !predicate || !question) {
    console.error('Usage: ask.ts --subject <kb:x> --predicate <kpred:y> --question "..." [--kb <graph name>] [--blocks kb:z] [--agent name] [--priority high]');
    process.exit(2);
  }

  const { queued } = askGraph({
    subject,
    predicate,
    question,
    blocks: flag('blocks'),
    kb: flag('kb'),
    agent: flag('agent'),
    priority: flag('priority') as Question['priority'],
    note: flag('note'),
  });

  console.log(
    queued
      ? `Asked. It is a pending partial fact — answer it in the Review tab, in Shelly, or by editing the triple.\n  ${subject} ${predicate} ?\n  "${question}"`
      : `Already asked (not re-queued). The reviewer should never see the same question twice.`,
  );
  console.log(`\nDo NOT wait. Pick up unblocked work; poll with: npm run agent:answers`);
}
