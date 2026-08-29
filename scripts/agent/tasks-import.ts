#!/usr/bin/env npx tsx
/**
 * Read filled-in task documents back into the review queue. THE BRIDGE, HALF TWO.
 *
 * A person or an agent has opened a document written by `tasks-export.ts` and supplied the two
 * things a dictated transcript cannot contain — the effects the task may have, and how a machine
 * will know it worked. This turns those answers into PENDING FACTS.
 *
 * PENDING, ALWAYS. This writes to knowledge.pending.jsonl, the same queue every other proposal
 * arrives through, and the app imports it for review. It does NOT edit the graph. That matters
 * more here than anywhere else in the codebase: an effect declaration is an authority boundary,
 * and a file that could set one directly would let anyone who can write a file grant a runner
 * permission to touch the outside world.
 *
 * THE PROMOTION IS PROPOSED, NOT PERFORMED. A `proposed` task must leave that state before any
 * runner may take it, and nothing here does that on its own. Instead the importer emits its OWN
 * task-state row — generated here, never read from the document — so accepting it in review is
 * the human act that authorizes the task. `taskFromMarkdown` separately refuses any document
 * claiming a state of claimed, done or failed, and says so.
 *
 * AT-LEAST-ONCE, LIKE EVERY OTHER CAPTURE PATH HERE. Rows are appended FIRST and the document is
 * moved to `imported/` only afterwards. A crash between the two produces a duplicate proposal,
 * never a lost answer. The other order would trade a harmless duplicate for silently discarding
 * work somebody typed.
 *
 * Usage:
 *   npx tsx scripts/agent/tasks-import.ts              import every filled document
 *   npx tsx scripts/agent/tasks-import.ts --dry-run    show what would be queued, move nothing
 *   npx tsx scripts/agent/tasks-import.ts --in <dir>   default reckons-workspace/tasks-inbox
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, renameSync } from 'fs';
import path from 'path';
import { taskFromMarkdown, type ParsedTaskDocument } from '../../src/lib/rdf/task-markdown.js';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const WORKSPACE = arg('--workspace', 'reckons-workspace');
const IN_DIR = arg('--in', path.join(WORKSPACE, 'tasks-inbox'));
const DONE_DIR = path.join(IN_DIR, 'imported');
const PENDING = path.join(WORKSPACE, 'knowledge.pending.jsonl');
const KPRED = 'urn:kbase:predicate/';
const AGENT = 'tasks-import';

type PendingRow = Record<string, unknown>;

/**
 * The rows one filled document contributes.
 *
 * `kb` is required by the pending parser and is read from the document's `section`, which
 * tasks-export wrote from the graph the task came from — so an answer returns to the graph that
 * asked, rather than to whichever graph happens to be open.
 */
export function rowsFor(parsed: ParsedTaskDocument, kb: string): PendingRow[] {
  if (!parsed.iri) return [];
  const base = { subject: parsed.iri, objectKind: 'literal', kb, agent: AGENT, type: 'suggestion' };
  const rows: PendingRow[] = [];

  for (const effect of parsed.effects) {
    rows.push({
      ...base,
      predicate: `${KPRED}effect`,
      object: effect,
      note: 'Authority boundary supplied in the task document. Accepting this lets a runner cross it.',
      priority: 'high',
    });
  }
  if (parsed.doneWhen) {
    rows.push({
      ...base,
      predicate: `${KPRED}done-when`,
      object: parsed.doneWhen,
      note: 'Acceptance check supplied in the task document. A task is assigned only once this exists.',
    });
  }
  if (parsed.command) {
    rows.push({
      ...base,
      predicate: `${KPRED}command`,
      object: parsed.command,
      note: 'The command this task would run. Read it before accepting anything else on this task.',
      priority: 'high',
    });
  }

  // The promotion out of `proposed`, generated HERE and never read from the document. Accepting
  // it is the human act that authorizes the task; without it the task stays refused.
  if (rows.length > 0) {
    rows.push({
      ...base,
      predicate: `${KPRED}task-state`,
      object: 'open',
      note: 'Proposed promotion out of `proposed`. Accept only after the effect and done-when above.',
      priority: 'high',
    });
  }
  return rows;
}

/** The graph a document belongs to, from its frontmatter `section`. */
export function sectionOf(markdown: string): string | undefined {
  const m = /^section:\s*"?([^"\n]+)"?\s*$/m.exec(markdown);
  return m ? m[1].trim() : undefined;
}

function main(): void {
  if (!existsSync(IN_DIR)) {
    console.log(`Nothing to import: ${IN_DIR} does not exist. Run tasks-export.ts first.`);
    return;
  }
  const files = readdirSync(IN_DIR).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.log(`No documents in ${IN_DIR}.`);
    return;
  }

  let imported = 0;
  let queued = 0;
  let untouched = 0;
  let refused = 0;

  for (const file of files) {
    const full = path.join(IN_DIR, file);
    const markdown = readFileSync(full, 'utf8');
    const parsed = taskFromMarkdown(markdown);

    // Issues are REPORTED and the document is left in place. A refused document is somebody's
    // work with a mistake in it, not garbage — moving it to imported/ would hide the mistake.
    if (parsed.issues.length > 0) {
      refused++;
      console.log(`  ✗ ${file}`);
      for (const issue of parsed.issues) console.log(`      ${issue}`);
      continue;
    }

    const kb = sectionOf(markdown);
    if (!kb) {
      refused++;
      console.log(`  ✗ ${file}\n      no \`section:\` — cannot tell which graph this answer belongs to`);
      continue;
    }

    const rows = rowsFor(parsed, kb);
    if (rows.length === 0) {
      // Still blank. Not an error — nobody has filled it in yet.
      untouched++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  + ${file}  →  ${rows.length} row(s) into ${kb}`);
      for (const r of rows) console.log(`      ${String(r.predicate).split('/').pop()} = ${JSON.stringify(r.object)}`);
      imported++;
      queued += rows.length;
      continue;
    }

    mkdirSync(WORKSPACE, { recursive: true });
    appendFileSync(PENDING, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');  // WRITE FIRST
    mkdirSync(DONE_DIR, { recursive: true });
    renameSync(full, path.join(DONE_DIR, file));                                            // then move
    console.log(`  + ${file}  →  ${rows.length} row(s) into ${kb}`);
    imported++;
    queued += rows.length;
  }

  console.log(
    `\n${DRY_RUN ? 'Would queue' : 'Queued'} ${queued} row(s) from ${imported} document(s); ` +
      `${untouched} still blank, ${refused} refused.`,
  );
  if (imported > 0 && !DRY_RUN) {
    console.log(`\nThey are proposals. Open the review queue to accept the effect and done-when.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('tasks-import.ts')) main();
