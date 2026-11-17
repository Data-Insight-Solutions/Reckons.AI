/**
 * ODD ROWS — first draft of F89.4.5 (kb:review-sample-gate). NO WIRING.
 *
 * The odd rows, shown before any group control and skipped by it, are the four kinds built 2026-10-27:
 *   - needs an answer (when needsObject is true)
 *   - disagrees with a held fact (when heldValue is set and differs from object)
 *   - confidence under 0.5 (when confidence is a number under 0.5)
 *   - a rival pending value from another source (when rivalSource is set)
 *
 * NOT BUILT here: two further kinds that only a whole run can show (a predicate used by fewer
 * than 1 in 20 of the run's rows; a subject outside the scope the job declares). They need the
 * run's rows, not one row, so oddKinds cannot find them.
 */

export type OddKind = 'needs-answer' | 'disagrees' | 'low-confidence' | 'rival-value';

export type ReviewRow = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  needsObject?: boolean;
  confidence?: number;
  heldValue?: string;
  rivalSource?: string;
};

/**
 * Returns every odd kind that applies to a row.
 */
export function oddKinds(row: ReviewRow): OddKind[] {
  const kinds: OddKind[] = [];

  if (row.needsObject) {
    kinds.push('needs-answer');
  }

  if (row.heldValue !== undefined && row.heldValue !== row.object) {
    kinds.push('disagrees');
  }

  if (row.confidence !== undefined && row.confidence < 0.5) {
    kinds.push('low-confidence');
  }

  if (row.rivalSource !== undefined) {
    kinds.push('rival-value');
  }

  return kinds;
}

/**
 * Splits rows into odd rows and rest, preserving input order.
 */
export function splitOdd(rows: ReviewRow[]): { odd: { row: ReviewRow; kinds: OddKind[] }[]; rest: ReviewRow[] } {
  const odd: { row: ReviewRow; kinds: OddKind[] }[] = [];
  const rest: ReviewRow[] = [];

  for (const row of rows) {
    const kinds = oddKinds(row);
    if (kinds.length > 0) {
      odd.push({ row, kinds });
    } else {
      rest.push(row);
    }
  }

  return { odd, rest };
}