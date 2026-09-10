#!/usr/bin/env npx tsx
/**
 * Check the pending facts a deterministic RULE can re-derive, and leave every judgement alone.
 *
 * Deterministic checks give a reviewer better evidence than an unsupported proposal. They do not,
 * by themselves, grant this file authority to settle the fact: the queue has no authenticated
 * writer identity. This script records what it independently reproduced while keeping every row in
 * review. An authenticated verifier transport can become a separate machine lane in the future.
 *
 * WHAT THIS WILL VERIFY — each re-derived from the thing it describes, not believed:
 *
 *   depends-on     the same edge is stated in static/reckons-roadmap.ttl.
 *   has-file       the path exists in the working tree.
 *   tested-by      the test file exists in the working tree.
 *
 * WHAT IT WILL NEVER VERIFY. Anything whose truth is a judgement: is this a real defect, should
 * this predicate be renamed, is this feature ready. A model stating one confidently does not make
 * it checkable, and auto-accepting opinions is how a review queue stops meaning anything.
 *
 * A verified row is stamped with an advisory `verificationClaim`. It still imports as PENDING.
 * The pending JSONL is writable by MCP clients and local jobs, so no field inside that same row can
 * authenticate its author or bypass review. This script re-derives useful evidence for the human;
 * a future auto-settle lane needs a separately authenticated channel. A row that FAILS its check
 * is never auto-rejected — a failed check is a finding for a human, not a licence to delete.
 *
 *   npx tsx scripts/offline/queue-verify.ts            dry-run: what is provable, and what is not
 *   npx tsx scripts/offline/queue-verify.ts --apply    annotate the provable rows
 */
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import N3 from 'n3';
import { QUEUE_PATH, transactPendingQueue } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';
const KPRED = 'urn:kbase:predicate/';
const VERIFIER = 'script:queue-verify';

// Canonical roadmap edges, read once — the ground truth for depends-on.
const roadmapEdges = new Set<string>();
try {
  for (const q of new N3.Parser().parse(readFileSync('static/reckons-roadmap.ttl', 'utf8'))) {
    if (q.predicate.value === `${KPRED}depends-on`) roadmapEdges.add(`${q.subject.value}|${q.object.value}`);
  }
} catch { /* absent — depends-on simply stays unverifiable */ }

export type VerificationVerdict = { ok: true; by: string } | { ok: false; why: string } | null;

export type PendingVerificationContext = {
  roadmapEdges?: ReadonlySet<string>;
  pathExists?: (path: string) => boolean;
};

/** null = not machine-checkable at all; that is the common and correct answer. */
export function verifyPendingRow(
  r: Record<string, unknown>,
  context: PendingVerificationContext = {},
): VerificationVerdict {
  const edges = context.roadmapEdges ?? roadmapEdges;
  const pathExists = context.pathExists ?? existsSync;
  const p = String(r.predicate ?? '');
  const o = typeof r.object === 'string' ? r.object : '';
  if (!o) return null;                                    // a question has nothing to check

  if (p === `${KPRED}depends-on`) {
    return edges.has(`${String(r.subject)}|${o}`)
      ? { ok: true, by: `${VERIFIER}/roadmap-edge` }
      : { ok: false, why: 'edge is not stated in static/reckons-roadmap.ttl' };
  }

  if (p === `${KPRED}has-file` || p === `${KPRED}tested-by`) {
    // Only a repo-relative path is checkable; a URL or prose is not this predicate's business.
    if (!/^[\w.@-]+(\/[\w.@-]+)+\.\w+$/.test(o)) return null;
    return pathExists(o)
      ? { ok: true, by: `${VERIFIER}/path-exists` }
      : { ok: false, why: `path does not exist: ${o}` };
  }

  return null;
}

/**
 * Migrate the old authority-sounding field and attach evidence without changing review status.
 * The result remains a claim because it is stored in the untrusted queue itself.
 */
export function recordVerificationClaim(
  row: Record<string, unknown>,
  by?: string,
): Record<string, unknown> {
  const { verifiedBy, ...rest } = row;
  const claim = by ?? (typeof rest.verificationClaim === 'string'
    ? rest.verificationClaim
    : typeof verifiedBy === 'string' && verifiedBy.trim()
      ? verifiedBy.trim()
      : undefined);
  return claim ? { ...rest, verificationClaim: claim } : rest;
}

function main(): void {
  const apply = process.argv.includes('--apply');
  if (apply) copyFileSync(QUEUE_PATH, `${QUEUE_PATH}.verify-backup-${Date.now()}.jsonl`);

  let total = 0, stamped = 0, failed = 0, judgement = 0, already = 0;
  const failures: string[] = [];
  const byRule = new Map<string, number>();

  transactPendingQueue(QUEUE_PATH, (cur) => {
    const out: string[] = [];
    for (const line of cur.split('\n')) {
      if (!line.trim()) continue;
      total++;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { out.push(line); continue; }

      // Never trust a pre-existing label. Re-run the rule against its source on every invocation.
      const v = verifyPendingRow(row);
      if (v === null) {
        judgement++;
        out.push(apply ? JSON.stringify(recordVerificationClaim(row)) : line);
        continue;
      }
      if (!v.ok) {
        // Left pending ON PURPOSE. A failed check means a human should look, not that a script
        // may delete somebody's finding.
        failed++;
        if (failures.length < 8) failures.push(`${String(row.subject).replace(/^urn:kbase:concept\//, 'kb:')} — ${v.why}`);
        out.push(apply ? JSON.stringify(recordVerificationClaim(row)) : line);
        continue;
      }
      const annotated = recordVerificationClaim(row, v.by);
      if (row.verificationClaim === v.by && row.verifiedBy === undefined) already++;
      else stamped++;
      byRule.set(v.by, (byRule.get(v.by) ?? 0) + 1);
      out.push(apply ? JSON.stringify(annotated) : line);
    }
    const content = out.join('\n') + '\n';
    return apply ? { content, result: stamped } : { result: stamped };
  });

  console.log(`\n${B}Queue verify${X} ${D}${total} row(s)${X}`);
  console.log(`${D}${'─'.repeat(74)}${X}`);
  console.log(`  ${G}${String(stamped).padStart(4)} provable${X} ${D}— a rule re-derived them; they still enter human review${X}`);
  if (already) console.log(`  ${D}${String(already).padStart(4)} already carries matching evidence (re-checked)${X}`);
  if (failed) console.log(`  ${R}${String(failed).padStart(4)} FAILED their check${X} ${D}— kept pending for you, never auto-rejected${X}`);
  console.log(`  ${C}${String(judgement).padStart(4)} judgement${X} ${D}— no rule can settle these, and none will try${X}`);
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`\n  ${D}${String(n).padStart(4)}  via ${rule}${X}`);
  if (failures.length) {
    console.log(`\n${R}${B}  failed checks — worth your attention${X}`);
    for (const f of failures) console.log(`    ${f}`);
  }
  console.log(`\n${D}${'─'.repeat(74)}${X}`);
  console.log(apply
    ? `${G}✓ recorded ${stamped} verification claim(s)${X} — advisory evidence only; review still decides.`
    : `${Y}dry-run — nothing written.${X} Re-run with ${B}--apply${X}.`);
  console.log('');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
