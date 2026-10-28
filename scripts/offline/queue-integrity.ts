#!/usr/bin/env npx tsx
/**
 * QUEUE INTEGRITY (SCRIPT tier) — catch malformed lines in knowledge.pending.jsonl.
 *
 * WHY. On 2026-10-28 the queue held 1,621 parseable rows and 15 lines that were not rows at all.
 * Nothing had ever said so: every reader skips or retains what it cannot parse (deliberately — an
 * unparseable line is evidence, not rubbish), so a damaged queue looks exactly like a healthy one.
 * "Does this line parse, and is it a row" is decided by a rule, so a rule should say it, for free.
 *
 * WHAT THE DAMAGE LOOKED LIKE. Most bad lines were TAIL FRAGMENTS: the end of a row ('8-27T02:27:
 * 53.657Z","addedAt":"..."}') whose head is missing, sitting directly after a row that parsed
 * cleanly. A token-limit cutoff would leave a truncated HEAD instead. A fragment after a complete
 * row is what a shorter write over a longer file leaves behind: stale bytes from the previous
 * content that the new content did not reach. Two writers overlapping, or a non-truncating write.
 *
 * CLASSES, per non-empty line:
 *   ok               parses to an object with a subject, a predicate and (if present) a known type
 *   tail-fragment    does not parse, does not start with `{`, ends with `}` — head missing
 *   truncated-head   does not parse, starts with `{` — tail missing
 *   unparseable      does not parse and is neither of the above
 *   non-object       parses to an array, string, number or null
 *   missing-subject  object with no non-empty string `subject`
 *   missing-predicate  object with no non-empty string `predicate`
 *   unknown-type     `type` present but not one of TYPES
 *
 *   npx tsx scripts/offline/queue-integrity.ts                 report; exit 0 clean, 1 findings, 2 missing
 *   npx tsx scripts/offline/queue-integrity.ts --quarantine    back up, then move bad lines to
 *                                                              knowledge.pending.quarantine.jsonl
 *     --classes=tail-fragment,truncated-head   quarantine only those classes
 *   npx tsx scripts/offline/queue-integrity.ts --file=<path>   check another queue file
 *
 * Quarantine runs inside transactPendingQueue, the same lock every queue writer is meant to hold.
 * Blank lines are not findings and are dropped by a quarantine rewrite along with the bad lines.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { transactPendingQueue } from './pending-queue.js';
import { pendingQueuePath } from './lib/main-workspace.js';

export const TYPES = ['observation', 'question', 'suggestion', 'status-update', 'drift-warning'] as const;

export type LineClass =
  | 'ok'
  | 'tail-fragment'
  | 'truncated-head'
  | 'unparseable'
  | 'non-object'
  | 'missing-subject'
  | 'missing-predicate'
  | 'unknown-type';

export type LineReport = { index: number; cls: LineClass };
export type ScanResult = {
  /** Non-empty lines examined. */
  total: number;
  counts: Record<LineClass, number>;
  /** Only the non-ok lines, 0-based line indexes as they sit in the file. */
  findings: LineReport[];
};

const nonEmpty = (s: unknown): boolean => typeof s === 'string' && s.trim() !== '';

export function classifyLine(line: string): LineClass {
  const t = line.trim();
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    if (t.startsWith('{')) return 'truncated-head';
    if (t.endsWith('}') && !t.startsWith('{')) return 'tail-fragment';
    return 'unparseable';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'non-object';
  const row = value as Record<string, unknown>;
  if (!nonEmpty(row.subject)) return 'missing-subject';
  if (!nonEmpty(row.predicate)) return 'missing-predicate';
  if (row.type !== undefined && !(TYPES as readonly unknown[]).includes(row.type)) return 'unknown-type';
  return 'ok';
}

export function scanQueue(text: string): ScanResult {
  const counts: Record<LineClass, number> = {
    ok: 0, 'tail-fragment': 0, 'truncated-head': 0, unparseable: 0, 'non-object': 0,
    'missing-subject': 0, 'missing-predicate': 0, 'unknown-type': 0,
  };
  const findings: LineReport[] = [];
  let total = 0;
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    total++;
    const cls = classifyLine(line);
    counts[cls]++;
    if (cls !== 'ok') findings.push({ index, cls });
  });
  return { total, counts, findings };
}

/** Split a queue into the text to keep and the lines to quarantine. Pure. */
export function splitForQuarantine(
  text: string,
  only?: ReadonlySet<LineClass>,
): { kept: string; bad: string[]; badIndexes: number[] } {
  const keptLines: string[] = [];
  const bad: string[] = [];
  const badIndexes: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const cls = classifyLine(line);
    if (cls === 'ok' || (only && !only.has(cls))) keptLines.push(line);
    else { bad.push(line); badIndexes.push(index); }
  });
  return { kept: keptLines.length ? keptLines.join('\n') + '\n' : '', bad, badIndexes };
}

export function isoStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function quarantinePathFor(queuePath: string): string {
  return queuePath.replace(/pending\.jsonl$/, 'pending.quarantine.jsonl');
}

/**
 * Back up, then move bad lines out of the queue. Returns what moved. A clean queue is left
 * byte-for-byte untouched and no backup is written.
 */
export function quarantineQueue(
  queuePath: string,
  now = new Date(),
  only?: ReadonlySet<LineClass>,
): { moved: number; backup?: string; quarantine: string } {
  const quarantine = quarantinePathFor(queuePath);
  return transactPendingQueue(queuePath, (current) => {
    const { kept, bad } = splitForQuarantine(current, only);
    if (bad.length === 0) return { result: { moved: 0, quarantine } };
    const backup = `${queuePath}.quarantine-backup-${isoStamp(now)}.jsonl`;
    copyFileSync(queuePath, backup);
    // Quarantine file first: if this throws, the queue is unchanged and nothing has been lost.
    const prior = existsSync(quarantine) ? readFileSync(quarantine, 'utf8') : '';
    const sep = prior && !prior.endsWith('\n') ? '\n' : '';
    writeFileSync(quarantine, prior + sep + bad.join('\n') + '\n');
    return { content: kept, result: { moved: bad.length, backup, quarantine } };
  });
}

export function renderReport(r: ScanResult): string {
  const out = [`queue-integrity: ${r.total} non-empty line(s), ${r.counts.ok} ok, ${r.findings.length} malformed`];
  for (const [cls, n] of Object.entries(r.counts)) if (cls !== 'ok' && n > 0) out.push(`  ${cls}: ${n}`);
  if (r.findings.length) {
    out.push('  0-based line indexes: ' + r.findings.map((f) => `${f.index}(${f.cls})`).join(', '));
  }
  return out.join('\n');
}

function main(): number {
  const argFile = process.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length);
  const path = argFile ?? pendingQueuePath();
  if (!existsSync(path)) {
    console.error(`queue-integrity: ${path} does not exist`);
    return 2;
  }
  const result = scanQueue(readFileSync(path, 'utf8'));
  console.log(renderReport(result));
  if (process.argv.includes('--quarantine') && result.findings.length > 0) {
    const classes = process.argv.find((a) => a.startsWith('--classes='))?.slice('--classes='.length);
    const only = classes ? new Set(classes.split(',') as LineClass[]) : undefined;
    const q = quarantineQueue(path, new Date(), only);
    console.log(`quarantined ${q.moved} line(s) to ${q.quarantine}; backup ${q.backup}`);
    return 0;
  }
  return result.findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
