#!/usr/bin/env npx tsx
/**
 * Prune the review queue — the review-mode prune, applied to knowledge.pending.jsonl (F80).
 *
 * Runs the shared analyzer (src/lib/rdf/prune.ts, analyzeSuggestionPrune) over the pending queue
 * and removes the suggestions it flags: re-derivable findings (a check regenerates them), empty /
 * malformed entries, and stale suggestions that block nothing and are not high priority. Decisions,
 * blocking items, and fresh or important suggestions are kept.
 *
 * SAFE BY DEFAULT: dry-run unless --apply, and --apply backs the file up first. An agent must never
 * quietly shrink the shared queue — pruning is destructive, so it announces exactly what it removed
 * and leaves a restore path.
 *
 *   npm run prune                 dry-run: show what WOULD be pruned, grouped by reason
 *   npm run prune -- --apply      back up, then remove the flagged suggestions
 *   npm run prune -- --stale 30   only treat suggestions older than N days as stale (default 14)
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { analyzeSuggestionPrune, type SuggestionPruneReason } from '../../src/lib/rdf/prune.js';
import type { PendingItem } from '../../src/lib/rdf/triage.js';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const staleIdx = argv.indexOf('--stale');
const staleDays = staleIdx >= 0 ? Number(argv[staleIdx + 1] ?? 14) : 14;

if (!existsSync(PENDING)) {
  console.log('  (no pending queue — nothing to prune)');
  process.exit(0);
}

// Keep each raw line beside its parsed item, so kept lines are written back byte-for-byte and a
// malformed line is preserved rather than silently dropped.
const rows = readFileSync(PENDING, 'utf8').split('\n').filter(Boolean).map((line) => {
  let item: PendingItem | null = null;
  try { item = JSON.parse(line); } catch { /* keep unparseable lines untouched */ }
  return { line, item };
});

const scored = rows.map((r) => (r.item ? analyzeSuggestionPrune([r.item], { staleDays })[0] : null));
const pruneRows = rows.filter((_, i) => scored[i]?.prune);
const keptRows = rows.filter((_, i) => !scored[i]?.prune);

const byReason = new Map<SuggestionPruneReason, number>();
for (const s of scored) if (s?.prune) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);

const short = (iri = '') => iri.replace(/^.*[/#:]/, '');

console.log(`${B}Queue prune${X} ${D}— ${rows.length} entries: ${pruneRows.length} prunable, ${keptRows.length} kept${X}\n`);
if (pruneRows.length === 0) {
  console.log(`  ${G}✓ nothing to prune — the queue is already clean.${X}\n`);
  process.exit(0);
}

for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${Y}${n.toString().padStart(3)}${X}  ${reason}`);
}
console.log('');
for (let i = 0; i < scored.length; i++) {
  const s = scored[i];
  if (!s?.prune) continue;
  const q = (rows[i].item?.question ?? short(rows[i].item?.subject)) ?? '(malformed)';
  console.log(`  ${D}${s.reason.padEnd(11)}${X} ${String(q).replace(/^\[[\w /-]+\]\s*/, '').slice(0, 90)}`);
}
console.log('');

if (!APPLY) {
  console.log(`  ${D}dry-run. Re-run with --apply to remove these (a backup is written first).${X}\n`);
  process.exit(0);
}

const backup = `${PENDING}.prune-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
copyFileSync(PENDING, backup);
writeFileSync(PENDING, keptRows.map((r) => r.line).join('\n') + '\n');
console.log(`  ${G}✓ pruned ${pruneRows.length}, kept ${keptRows.length}.${X}`);
console.log(`  ${D}backup: ${backup}${X}\n`);
