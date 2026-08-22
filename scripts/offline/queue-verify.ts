#!/usr/bin/env npx tsx
/**
 * Settle the pending facts a RULE can settle, and leave every judgement alone (F74.3, script tier).
 *
 * The routing model has always described a machine lane — facts nobody needs to adjudicate because
 * a check can re-derive them — and it has settled exactly nothing, because no producer ever recorded
 * having checked. So provably-true facts queued up beside genuine questions and a human worked
 * through both at the same cost. 140 dependency edges transcribed verbatim out of the canonical
 * roadmap is the clearest case: nothing about them was ever in doubt.
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
 * A verified row is stamped `verifiedBy`, and the drain imports those as CONFIRMED rather than
 * pending. The verifier's name rides on the statement, so an auto-accepted fact says who accepted
 * it and can be found and reversed. A row that FAILS its check is never auto-rejected — a failed
 * check is a finding for a human, not a licence to delete.
 *
 *   npx tsx scripts/offline/queue-verify.ts            dry-run: what is provable, and what is not
 *   npx tsx scripts/offline/queue-verify.ts --apply    stamp the provable rows
 */
import { copyFileSync, existsSync, readFileSync } from 'fs';
import N3 from 'n3';
import { QUEUE_PATH, transactPendingQueue } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';
const APPLY = process.argv.includes('--apply');
const KPRED = 'urn:kbase:predicate/';
const VERIFIER = 'script:queue-verify';

// Canonical roadmap edges, read once — the ground truth for depends-on.
const roadmapEdges = new Set<string>();
try {
  for (const q of new N3.Parser().parse(readFileSync('static/reckons-roadmap.ttl', 'utf8'))) {
    if (q.predicate.value === `${KPRED}depends-on`) roadmapEdges.add(`${q.subject.value}|${q.object.value}`);
  }
} catch { /* absent — depends-on simply stays unverifiable */ }

type Verdict = { ok: true; by: string } | { ok: false; why: string } | null;

/** null = not machine-checkable at all; that is the common and correct answer. */
function verify(r: Record<string, unknown>): Verdict {
  const p = String(r.predicate ?? '');
  const o = typeof r.object === 'string' ? r.object : '';
  if (!o) return null;                                    // a question has nothing to check

  if (p === `${KPRED}depends-on`) {
    return roadmapEdges.has(`${String(r.subject)}|${o}`)
      ? { ok: true, by: `${VERIFIER}/roadmap-edge` }
      : { ok: false, why: 'edge is not stated in static/reckons-roadmap.ttl' };
  }

  if (p === `${KPRED}has-file` || p === `${KPRED}tested-by`) {
    // Only a repo-relative path is checkable; a URL or prose is not this predicate's business.
    if (!/^[\w.@-]+(\/[\w.@-]+)+\.\w+$/.test(o)) return null;
    return existsSync(o)
      ? { ok: true, by: `${VERIFIER}/path-exists` }
      : { ok: false, why: `path does not exist: ${o}` };
  }

  return null;
}

if (APPLY) copyFileSync(QUEUE_PATH, `${QUEUE_PATH}.verify-backup-${Date.now()}.jsonl`);

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

    if (typeof row.verifiedBy === 'string' && row.verifiedBy) { already++; out.push(line); continue; }

    const v = verify(row);
    if (v === null) { judgement++; out.push(line); continue; }
    if (!v.ok) {
      // Left pending ON PURPOSE. A failed check means a human should look, not that a script
      // may delete somebody's finding.
      failed++;
      if (failures.length < 8) failures.push(`${String(row.subject).replace(/^urn:kbase:concept\//, 'kb:')} — ${v.why}`);
      out.push(line);
      continue;
    }
    stamped++;
    byRule.set(v.by, (byRule.get(v.by) ?? 0) + 1);
    out.push(JSON.stringify({ ...row, verifiedBy: v.by }));
  }
  const content = out.join('\n') + '\n';
  return APPLY ? { content, result: stamped } : { result: stamped };
});

console.log(`\n${B}Queue verify${X} ${D}${total} row(s)${X}`);
console.log(`${D}${'─'.repeat(74)}${X}`);
console.log(`  ${G}${String(stamped).padStart(4)} provable${X} ${D}— a rule re-derived them; the drain will confirm these${X}`);
if (already) console.log(`  ${D}${String(already).padStart(4)} already verified${X}`);
if (failed) console.log(`  ${R}${String(failed).padStart(4)} FAILED their check${X} ${D}— kept pending for you, never auto-rejected${X}`);
console.log(`  ${C}${String(judgement).padStart(4)} judgement${X} ${D}— no rule can settle these, and none will try${X}`);
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`\n  ${D}${String(n).padStart(4)}  via ${rule}${X}`);
if (failures.length) {
  console.log(`\n${R}${B}  failed checks — worth your attention${X}`);
  for (const f of failures) console.log(`    ${f}`);
}
console.log(`\n${D}${'─'.repeat(74)}${X}`);
console.log(APPLY
  ? `${G}✓ stamped ${stamped} row(s)${X} — they import as confirmed, tagged ${VERIFIER}.`
  : `${Y}dry-run — nothing written.${X} Re-run with ${B}--apply${X}.`);
console.log('');
