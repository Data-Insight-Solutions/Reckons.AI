/**
 * ARCHIVE RESTORE GUARD (F97.3) — do not silently duplicate what is merely archived.
 *
 * "When an ingest mentions an entity that currently lives in the archive, offer to restore it
 * rather than minting a duplicate node. REQUIREMENT, not an enhancement: without it, archiving
 * actively worsens the duplicate problem that the merge analysis exists to solve, and every
 * archive sweep seeds the next round of duplicates."
 *
 * The DETECTION already existed (archive-store.findArchivedReferencesForParent) and the
 * RESTORE already existed (restoreArchivedEntityForParent). What was missing was the middle:
 * nothing called the detector at a commit boundary, so both ends were unreachable. This is
 * the decision layer between them, kept pure so it can be tested without a database.
 *
 * WHY ONLY THE MATCHING STATEMENTS ARE HELD. A batch of 200 ingested facts that mentions one
 * archived entity should write 199 of them and pause one. Holding the whole batch would make
 * a single archived match block an entire import — punishing the user for having archived
 * anything, which is the opposite of the feature's purpose.
 *
 * WHY THIS PAUSES RATHER THAN AUTO-RESTORING. Restoring is a real edit to the working graph,
 * and the match is a HEURISTIC — the underlying matcher is a conservative direct-IRI and
 * normalized-label comparison, not proof of identity. Auto-restoring on a label collision
 * would silently resurrect an entity the user deliberately archived. So the guard proposes
 * and the human settles, which is the F52 boundary applied to restores.
 */

import type { Statement } from './types';

/** What the storage-backed detector reports. Structural subset — kept local so this module
 *  does not depend on the storage layer and stays unit-testable. */
export type ArchivedMatch = {
  /** IRI of the archived entity the incoming batch mentions. */
  entity: string;
  /** Human label, when the archive knows one. */
  label?: string;
};

export type GuardDecision = {
  /** Statements safe to write now. */
  write: Statement[];
  /** Statements held back because they mention an archived entity. */
  held: Statement[];
  /** The archived entities implicated, each with the statements waiting on it. */
  prompts: Array<{ entity: string; label?: string; statements: Statement[] }>;
};

function touches(st: Statement, entity: string): boolean {
  return (
    (st.s.kind === 'iri' && st.s.value === entity) || (st.o.kind === 'iri' && st.o.value === entity)
  );
}

/**
 * Split an incoming batch around archived matches.
 *
 * A statement is held if it mentions ANY matched archived entity, as subject or object — an
 * inbound edge to an archived node would mint the duplicate just as surely as a fact about it.
 */
export function guardIncoming(
  incoming: readonly Statement[],
  matches: readonly ArchivedMatch[],
): GuardDecision {
  if (matches.length === 0) return { write: [...incoming], held: [], prompts: [] };

  const held = new Set<Statement>();
  const prompts: GuardDecision['prompts'] = [];

  for (const m of matches) {
    const touching = incoming.filter((st) => touches(st, m.entity));
    if (touching.length === 0) continue;
    for (const st of touching) held.add(st);
    prompts.push({ entity: m.entity, label: m.label, statements: touching });
  }

  return {
    write: incoming.filter((st) => !held.has(st)),
    held: [...held],
    prompts,
  };
}

/**
 * The sentence shown to the user.
 *
 * Names the entity and what is waiting on it, because "an archived entity was matched" tells
 * someone nothing about what their choice will do.
 */
export function describePrompt(p: GuardDecision['prompts'][number]): string {
  // The detector's label falls back to the ENTITY IRI when the archived node has no
  // rdfs:label (archive.ts: `archivedLabels.get(entity) ?? entity`), so `p.label` is never
  // absent and a plain `?? tail` fallback never fires. Found by the end-to-end run, which
  // showed a prompt reading "urn:kbase:concept/old-supplier" is in the archive — technically
  // correct and useless to read. Treat an IRI-shaped label as no label.
  const looksLikeIri = !!p.label && /^[a-z][a-z0-9+.-]*:/i.test(p.label);
  const name = p.label && !looksLikeIri ? p.label : (p.entity.split('/').pop() || p.entity);
  const n = p.statements.length;
  return `"${name}" is in the archive. ${n} incoming fact${n === 1 ? '' : 's'} mention${n === 1 ? 's' : ''} it — restore it, or keep the new one separate?`;
}

/** True when a batch needs a human before any of it can be considered settled. */
export function needsDecision(d: GuardDecision): boolean {
  return d.prompts.length > 0;
}
