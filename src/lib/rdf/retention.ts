/**
 * RETENTION BY ALTITUDE — age out events without aging out decisions.
 *
 * Matt, 2026-08-21: "log/event style graph nodes should be marked separately, such that archive of
 * older events can be made separately than old decisions that still need referenced."
 *
 * THE PROBLEM THIS FIXES. fact-altitude.ts has classified facts since F139 — decision, judgment,
 * evidence, record, log — and the census says 73.1% of a mature graph is record+log. archive.ts
 * (F97) has retained and pruned snapshots for just as long. NEITHER MODULE HAS EVER READ THE
 * OTHER: grep for "altitude" in archive.ts returns nothing. So retention is age-based and
 * altitude-blind, which means the only safe policy is to keep everything — and a graph that keeps
 * every timestamp forever buys that safety by drowning the decisions in them.
 *
 * A LOG EVENT AND A DECISION DO NOT HAVE THE SAME LIFESPAN. "Ran the migration at 02:10" is worth
 * something for about a week. "We chose the county mast, and here is what it cost us" is worth
 * something for as long as anyone asks why the mast is shared. Age is the right axis for the first
 * and the wrong axis for the second.
 *
 * THE LOAD-BEARING RULE: REFERENCE BEATS AGE. An old event that a decision still cites is not old
 * news — it is the evidence under a live ruling, and archiving it would leave the ruling asserting
 * something with nothing behind it. So nothing ageable is archived while a decision or judgment
 * still points at it, however old it is. That check is what makes this safe to run unattended;
 * without it, "archive events older than N days" quietly hollows out the reasoning.
 *
 * This module DECIDES NOTHING. It partitions and explains; the caller archives, and a person
 * approves. Pure — statements in, three lists out.
 */
import { altitudeOf, type Altitude } from './fact-altitude';
import { isIRI } from './types';
import type { Statement } from './types';

/**
 * What time may do to a fact.
 *
 *   ageable      its value decays and nothing structural depends on it — events, logs.
 *   conditional  bookkeeping: ageable only once nothing points at it any more.
 *   keep         age is not a reason to remove it, ever, at any age.
 */
export type RetentionClass = 'ageable' | 'conditional' | 'keep';

export const RETENTION_BY_ALTITUDE: Record<Altitude, RetentionClass> = {
  // A decision is the thing the graph exists to hold. It gets older, not less true.
  decision: 'keep',
  // A verdict outlives the week it was formed in, and re-deriving one is expensive or impossible.
  judgment: 'keep',
  // A measurement is the support under a verdict. Archive it and the verdict is left asserting
  // something with nothing behind it — worse than never having recorded the measurement.
  evidence: 'keep',
  // Bookkeeping: file links, counts, stamps. Removable, but only once nothing refers to it.
  record: 'conditional',
  // An event. This is the class the user asked to separate, and the only one age alone can settle.
  log: 'ageable',
};

export function retentionClassOf(st: Statement): RetentionClass {
  return RETENTION_BY_ALTITUDE[altitudeOf(st)];
}

export interface ArchivePartition {
  /** Safe to archive under the given age. */
  archive: Statement[];
  /** Kept because of what they ARE, not how old they are. */
  keep: Statement[];
  /**
   * Old enough and of an ageable class, but still pointed at by a live decision or judgment.
   * Reported separately rather than silently kept, so "why is this still here" has an answer.
   */
  heldBack: Array<{ statement: Statement; reason: string }>;
}

export interface RetentionOptions {
  /** Facts created before this timestamp are candidates. Newer facts are never candidates. */
  olderThan: number;
  /**
   * Also age out `conditional` (record) facts, not just `log`. Off by default: bookkeeping is
   * cheap to keep and is what makes a graph auditable later.
   */
  includeRecords?: boolean;
  /**
   * Archive even when a decision still refers to the subject. Off by default, and turning it on
   * is a deliberate choice to break citations — the reason is reported either way.
   */
  ignoreReferences?: boolean;
}

/**
 * Which subjects a live decision or judgment still points at.
 *
 * Exported because "is this still referenced" is the question a UI needs to answer beside a fact,
 * not only something the partitioner uses internally.
 */
export function referencedSubjects(all: readonly Statement[]): Set<string> {
  const referenced = new Set<string>();
  for (const st of all) {
    const alt = altitudeOf(st);
    if (alt !== 'decision' && alt !== 'judgment') continue;
    // A decision refers to a thing either by pointing AT it, or by being about it.
    if (isIRI(st.o)) referenced.add(st.o.value);
    referenced.add(st.s.value);
  }
  return referenced;
}

/**
 * Split a graph into what may be archived, what must be kept, and what is only being kept because
 * something still refers to it.
 *
 * `all` is the whole graph, because reference-checking cannot be done on the candidate slice alone
 * — an event is referenced by facts that are not themselves candidates.
 */
export function partitionForArchive(
  all: readonly Statement[],
  opts: RetentionOptions,
): ArchivePartition {
  const referenced = opts.ignoreReferences ? new Set<string>() : referencedSubjects(all);
  const out: ArchivePartition = { archive: [], keep: [], heldBack: [] };

  for (const st of all) {
    const cls = retentionClassOf(st);
    const ageable = cls === 'ageable' || (cls === 'conditional' && opts.includeRecords === true);

    if (!ageable) { out.keep.push(st); continue; }
    if (st.createdAt >= opts.olderThan) { out.keep.push(st); continue; }

    if (referenced.has(st.s.value)) {
      out.heldBack.push({
        statement: st,
        reason: `a live decision or judgment still refers to ${st.s.value} — archiving it would leave that ruling with nothing behind it`,
      });
      continue;
    }
    out.archive.push(st);
  }
  return out;
}

/** The honest headline: what a run would do, and what it deliberately would not. */
export function retentionSummary(p: ArchivePartition): string {
  if (!p.archive.length && !p.heldBack.length) {
    return `Nothing to archive: ${p.keep.length} fact${p.keep.length === 1 ? '' : 's'} kept, none old enough or of an ageable kind.`;
  }
  const parts = [`${p.archive.length} event${p.archive.length === 1 ? '' : 's'} archivable`];
  if (p.heldBack.length) parts.push(`${p.heldBack.length} held back because a decision still refers to them`);
  parts.push(`${p.keep.length} kept (decisions, judgments and their evidence do not age out)`);
  return `${parts.join('; ')}.`;
}
