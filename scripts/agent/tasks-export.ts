#!/usr/bin/env npx tsx
/**
 * Write the tasks that need a human as markdown documents. THE BRIDGE, HALF ONE.
 *
 * THE GAP THIS CLOSES. A dictated instruction becomes a `proposed` AgentTask in the app's graph
 * (rdf/note-intent.ts), and `scripts/agent/runner.ts` can drain a queue and execute it — but
 * nothing ever moved a task from one to the other. The app's graph lives in IndexedDB, which no
 * Node script can read, so the two halves have been staring past each other.
 *
 * THE CROSSING POINT IS THE WORKSPACE SYNC, which already writes every graph to disk as Turtle.
 * So this needs no app change, no MCP, and no harness adapter: read the synced TTL, find the
 * tasks a person still has to author, and write each one as a form. `tasks-import.ts` reads them
 * back. Text is the interface (F154).
 *
 * WHICH TASKS. Not "blocked" — a task blocked by an unmet DEPENDENCY needs no human, it needs its
 * dependency to finish. This exports tasks MISSING THE FIELDS ONLY A PERSON CAN SUPPLY: the
 * effects it may have, and how a machine will know it worked. That is `missingForExecution`, and
 * it is the same list the document renders as a checklist.
 *
 * IT NEVER OVERWRITES. A document on disk may already have someone's answers in it, and
 * clobbering that would destroy the only copy of work this whole path exists to collect. An
 * existing file is skipped and reported; --force is available and says what it is doing.
 *
 * Usage:
 *   npx tsx scripts/agent/tasks-export.ts                 write documents for anything unauthored
 *   npx tsx scripts/agent/tasks-export.ts --dry-run       list what would be written
 *   npx tsx scripts/agent/tasks-export.ts --force         overwrite existing documents
 *   npx tsx scripts/agent/tasks-export.ts --out <dir>     default reckons-workspace/tasks-inbox
 *   npx tsx scripts/agent/tasks-export.ts --notify        also POST each document to n8n (F162)
 *
 * DELIVERY IS OPT-IN AND BEST-EFFORT. `--notify` posts each document to the user's own n8n at
 * `/webhook/reckons-document`, which they wire to an email however they like — the importable
 * template is static/n8n/task-document-email.workflow.json. It is a SIDE EFFECT, so it never
 * decides whether the export succeeded: a delivery failure is reported and the documents are
 * still on disk. n8n owns web side-effects; the graph owns state (Integration Boundaries).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';
import { parseTasks, type AgentTask } from '../../src/lib/rdf/agent-task.js';
import { taskToMarkdown, missingForExecution } from '../../src/lib/rdf/task-markdown.js';
import type { Statement, Term } from '../../src/lib/rdf/types.js';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const WORKSPACE = arg('--workspace', 'reckons-workspace');
const OUT_DIR = arg('--out', path.join(WORKSPACE, 'tasks-inbox'));
const NOTIFY = argv.includes('--notify');
const DOCUMENT_WEBHOOK = '/webhook/reckons-document';

/** Read .env the same way notes-pull does, so one file configures both directions. */
function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * Hand one document to n8n. Never throws: delivery is a side effect and must not be able to fail
 * an export whose real output is already safely on disk.
 */
async function deliver(doc: { filename: string; title: string; markdown: string }, graph: string, taskIri: string): Promise<boolean> {
  const base = process.env.N8N_API_URL?.replace(/\/+$/, '');
  if (!base) {
    console.warn('  ! --notify given but N8N_API_URL is unset — documents written, nothing sent');
    return false;
  }
  const headerName = process.env.N8N_CAPTURE_HEADER_NAME;
  const headerValue = process.env.N8N_CAPTURE_HEADER_VALUE;
  try {
    const res = await fetch(`${base}${DOCUMENT_WEBHOOK}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headerName && headerValue ? { [headerName]: headerValue } : {}),
      },
      body: JSON.stringify({
        kind: 'task-document',
        graph,
        task: taskIri,
        filename: doc.filename,
        title: doc.title,
        markdown: doc.markdown,
        at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.warn(`  ! delivery of ${doc.filename} failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`  ! delivery of ${doc.filename} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * A quad as the minimal Statement the RDF helpers need.
 *
 * Deliberately minimal: `parseTasks` reads subject, predicate and object and nothing else, so
 * inventing plausible values for status or confidence here would be fabricating provenance for
 * facts that came out of a file.
 */
function toStatement(q: Quad, index: number): Statement {
  const term = (t: Quad['object']): Term =>
    t.termType === 'Literal'
      ? { kind: 'literal', value: t.value }
      : { kind: 'iri', value: t.value };
  return {
    id: `q${index}`,
    s: term(q.subject),
    p: { kind: 'iri', value: q.predicate.value },
    o: term(q.object),
    g: { kind: 'iri', value: 'urn:kbase:source/workspace' },
    sourceId: 'workspace',
    confidence: 1,
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  };
}

export type GraphTasks = { graph: string; file: string; tasks: AgentTask[] };

/** Every synced graph on disk, and the tasks in it. A graph that fails to parse is reported, not fatal. */
export function readGraphTasks(workspace = WORKSPACE): GraphTasks[] {
  const kbs = path.join(workspace, 'kbs');
  if (!existsSync(kbs)) return [];

  const out: GraphTasks[] = [];
  for (const entry of readdirSync(kbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(kbs, entry.name, `${entry.name}.ttl`);
    if (!existsSync(file)) continue;
    let quads: Quad[];
    try {
      quads = new Parser().parse(readFileSync(file, 'utf8')) as Quad[];
    } catch (err) {
      console.warn(`  ! ${file} did not parse: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const tasks = parseTasks(quads.map(toStatement));
    if (tasks.length > 0) out.push({ graph: entry.name, file, tasks });
  }
  return out;
}

/** Tasks a person still has to author. See the header for why this is not simply "blocked". */
export function needsAuthoring(tasks: AgentTask[]): AgentTask[] {
  return tasks.filter(
    (t) => t.state !== 'done' && t.state !== 'failed' && missingForExecution(t).length > 0,
  );
}

async function main(): Promise<void> {
  if (NOTIFY) loadDotEnv();
  const graphs = readGraphTasks();
  if (graphs.length === 0) {
    console.log(`No graphs with tasks under ${WORKSPACE}/kbs. Is the workspace synced?`);
    return;
  }

  let written = 0;
  let skipped = 0;
  let complete = 0;
  let delivered = 0;

  for (const { graph, tasks } of graphs) {
    const pending = needsAuthoring(tasks);
    complete += tasks.length - pending.length;
    for (const task of pending) {
      const doc = taskToMarkdown(task, { section: graph });
      const target = path.join(OUT_DIR, doc.filename);

      if (existsSync(target) && !FORCE) {
        // It may already hold somebody's answers, and this path exists to collect those.
        skipped++;
        console.log(`  = ${doc.filename}  (exists — not overwritten)`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`  + ${doc.filename}  [${graph}] ${doc.title}`);
        written++;
        continue;
      }
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(target, doc.markdown, 'utf8');   // ON DISK FIRST, always
      if (NOTIFY && (await deliver(doc, graph, task.iri))) delivered++;
      if (existsSync(target) && FORCE) console.log(`  ! ${doc.filename}  (OVERWRITTEN)`);
      else console.log(`  + ${doc.filename}  [${graph}] ${doc.title}`);
      written++;
    }
  }

  // Say what was NOT exported as loudly as what was: a run that writes nothing because every task
  // is already authored looks identical to one that writes nothing because the sync is broken.
  console.log(
    `\n${DRY_RUN ? 'Would write' : 'Wrote'} ${written}, skipped ${skipped} existing, ` +
      `${complete} task(s) already carry their effects and done-when.`,
  );
  if (NOTIFY) console.log(`Delivered ${delivered} of ${written} to n8n${DRY_RUN ? ' (dry run: none)' : ''}.`);
  if (written > 0 && !DRY_RUN) {
    console.log(`\nFill in effect / done_when in ${OUT_DIR}/*.md, then:`);
    console.log('  npx tsx scripts/agent/tasks-import.ts');
  }
}

if (process.argv[1] && process.argv[1].endsWith('tasks-export.ts')) {
  main().catch((e) => { console.error('tasks-export failed:', e); process.exit(1); });
}
