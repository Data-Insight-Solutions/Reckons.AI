/**
 * `reckons review` — the review procedure at a terminal (F199).
 *
 * Matt, 2026-09-10: "we need a cli and mcp review procedure… I will ideally use Claude Code chat
 * to review critical decisions, and choose a claim."
 *
 * THE LOGIC IS NOT HERE, DELIBERATELY. review-session.ts is a symlink to the MCP server's copy, so
 * the CLI and the MCP tools run the SAME grouping, the same ranking and the same refusals. Two
 * implementations of "may a terminal settle this" is how one of them quietly loses a refusal, and
 * the refusals are the part that protects the graph. This file is argument parsing and printing.
 *
 * WHAT IT DOES NOT DO: write a graph. A verdict is journalled beside the queue and applied by the
 * app on its next drain. `reckons review` can be wrong and cost nothing but a line in a file.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { currentActor, actorLine } from './actor.js';
import { readPendingRows } from './review-links.js';
import {
  buildVerdict, filterDecisions, groupDecisions, predicateArity, recordVerdicts, renderDecision,
  renderQueue, renderVerdict, ReviewRefusal, settledIds,
  type Decision, type VerdictKind,
} from './review-session.js';

export interface ReviewDeps {
  /** Read one .ttl. Injected so this file needs no parser and stays testable without one. */
  readTriples: (path: string) => readonly { subject: string; predicate: string; object: string }[];
  /** The .ttl path the CLI resolved, so the queue can be found beside it. */
  kbPath: string;
  json: boolean;
  limit?: number;
}

/**
 * Every graph the workspace holds, not just the one that happens to be open.
 *
 * WHY IT MATTERS, measured 2026-09-10: pointed at reckons-workspace/knowledge.ttl the CLI saw 46
 * triples, so predicateArity knew nothing, every predicate resolved to `multi`, and NO decision
 * was ever presented as a choice. The queue's rows target `roadmap`, `production`, `codebase` and
 * the rest — which live in kbs/<name>/<name>.ttl beside it. Measuring arity from one small graph
 * is measuring the wrong corpus, and the failure is silent: the review still runs, it just never
 * offers a claim to choose.
 */
export function workspaceGraphs(kbPath: string): string[] {
  const found = new Set<string>();
  if (existsSync(kbPath)) found.add(kbPath);
  const root = dirname(kbPath);
  for (const dir of [root, join(root, 'kbs')]) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (entry.endsWith('.ttl')) { found.add(full); continue; }
        // kbs/<name>/<name>.ttl — one graph per folder, named after it.
        if (statSync(full).isDirectory()) {
          for (const inner of readdirSync(full)) {
            if (inner.endsWith('.ttl')) found.add(join(full, inner));
          }
        }
      } catch { /* an unreadable entry is not a reason to review nothing */ }
    }
  }
  return [...found];
}

export const REVIEW_USAGE = `reckons review — settle a pending claim without opening the app

  reckons review                       list the decisions waiting, highest consequence first
  reckons review next                  the top decision, in full
  reckons review show <id>             one decision, in full
  reckons review accept <id> [claim]   accept a claim ('all' takes a whole batch)
  reckons review reject <id>           reject it
  reckons review defer  <id>           not now — record why with --note
  reckons review ask    <id>           turn it back into an open question

  --contested    only decisions whose claims cannot both stand
  --high         only high priority
  --agent <s>    only decisions proposed by an agent matching <s>
  --note  <s>    why — the only part of a verdict nobody can reconstruct later
  -n, --limit    how many to list (default 10)
  -j, --json     machine-readable

A verdict is written to knowledge.decisions.jsonl and applied by the app on its next drain.
Nothing here edits a graph, and no accept deletes anything.`;

/**
 * Where the queue lives for a given graph file.
 *
 * TWO LAYOUTS EXIST and both are in use: the repository workspace keeps
 * `knowledge.pending.jsonl` beside `knowledge.ttl`, while a multi-graph workspace keeps
 * `pending.jsonl` inside each graph's folder. Checking for both is cheaper than making a person
 * discover that a correctly-typed command reviewed an empty queue.
 */
export function queueFileFor(kbPath: string): string | null {
  const candidates = [
    kbPath.replace(/\.ttl$/, '.pending.jsonl'),
    join(dirname(kbPath), 'pending.jsonl'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function decisionsFileFor(queueFile: string): string {
  return queueFile.replace(/pending\.jsonl$/, 'decisions.jsonl');
}

interface Loaded { decisions: Decision[]; queueFile: string; totalRows: number; settled: number }

function load(deps: ReviewDeps): Loaded | null {
  const queueFile = queueFileFor(deps.kbPath);
  if (!queueFile) return null;
  const triples = workspaceGraphs(deps.kbPath).flatMap((g) => {
    // One unparseable graph must not stop a review; it only narrows what arity is known.
    try { return [...deps.readTriples(g)]; } catch { return []; }
  });
  const arity = predicateArity(triples);
  const rows = readPendingRows(queueFile);
  const settled = settledIds(decisionsFileFor(queueFile));
  const all = groupDecisions(rows, arity);
  const decisions = all.filter((d) => !settled.has(d.id));
  return { decisions, queueFile, totalRows: rows.length, settled: all.length - decisions.length };
}

function noQueue(kbPath: string): number {
  process.stderr.write(
    `No pending queue beside ${kbPath}.\n`
    + `That is NOT the same as an empty queue — looked for <graph>.pending.jsonl and pending.jsonl.\n`,
  );
  return 1;
}

/**
 * Run one `reckons review …` invocation. Returns the process exit code.
 *
 * A REFUSAL EXITS NON-ZERO, on purpose. Somebody will eventually put this in a script, and a
 * refusal that exits 0 reads as a verdict that landed.
 */
export function cmdReview(
  args: string[],
  flags: { contested?: boolean; high?: boolean; agent?: string; note?: string },
  deps: ReviewDeps,
): number {
  const sub = (args[0] ?? 'list').toLowerCase();

  if (sub === 'help' || sub === '--help') {
    process.stdout.write(REVIEW_USAGE + '\n');
    return 0;
  }

  const loaded = load(deps);
  if (!loaded) return noQueue(deps.kbPath);
  const { decisions, queueFile, totalRows, settled } = loaded;

  if (sub === 'list' || sub === 'ls') {
    const shown = filterDecisions(decisions, {
      contested: flags.contested, high: flags.high, agent: flags.agent,
    });
    if (deps.json) {
      process.stdout.write(JSON.stringify({ total: decisions.length, rows: totalRows, decisions: shown }, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(renderQueue(shown, decisions.length, deps.limit ?? 10, settled) + '\n');
    process.stdout.write(`\nFrom ${totalRows} queue row(s) in ${queueFile}.\n`);
    process.stdout.write('reckons review show <id> reads one in full.\n');
    return 0;
  }

  if (sub === 'next') {
    const shown = filterDecisions(decisions, {
      contested: flags.contested, high: flags.high, agent: flags.agent,
    });
    if (shown.length === 0) {
      process.stdout.write(renderQueue(shown, decisions.length, 10, settled) + '\n');
      return 0;
    }
    return printOne(shown[0], shown, deps);
  }

  const id = args[1];
  if (!id) {
    process.stderr.write(`Usage: reckons review ${sub} <decision-id>\n`);
    return 1;
  }
  const d = decisions.find((x) => x.id === id);
  if (!d) {
    process.stderr.write(
      `No open decision ${id}.\n`
      + `It may already carry a verdict, or the id may be from a stale listing — run reckons review again.\n`,
    );
    return 1;
  }

  if (sub === 'show') return printOne(d, decisions, deps);

  if (sub === 'accept' || sub === 'reject' || sub === 'defer' || sub === 'ask') {
    return record(d, sub as VerdictKind, args[2], flags.note, queueFile, deps);
  }

  process.stderr.write(`Unknown review command: ${sub}\n\n${REVIEW_USAGE}\n`);
  return 1;
}

function printOne(d: Decision, all: Decision[], deps: ReviewDeps): number {
  if (deps.json) {
    process.stdout.write(JSON.stringify(d, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(renderDecision(d, { index: all.indexOf(d), total: all.length }) + '\n');
  process.stdout.write(`\n  reckons review accept ${d.id}${d.claims.length > 1 ? ' <claim>' : ''}   ·   reject   ·   defer --note "…"\n`);
  return 0;
}

function record(
  d: Decision, verdict: VerdictKind, claim: string | undefined, note: string | undefined,
  queueFile: string, deps: ReviewDeps,
): number {
  const actor = currentActor('cli');
  try {
    const v = buildVerdict({ decision: d, verdict, claim, note, actor });
    recordVerdicts(decisionsFileFor(queueFile), [v]);
    if (deps.json) {
      process.stdout.write(JSON.stringify(v, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(renderVerdict(v, d) + '\n');
    return 0;
  } catch (e) {
    if (e instanceof ReviewRefusal) {
      // A refusal is a correct outcome. Say what was refused, and that nothing was written.
      process.stderr.write(`REFUSED. ${e.message}\n\nNothing was recorded. (${actorLine(actor)})\n`);
      return 2;
    }
    throw e;
  }
}
