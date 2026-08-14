/**
 * WHICH COPY OF A DUPLICATED GRAPH SHOULD SURVIVE?
 *
 * The graphs page reports duplicated names and deliberately never auto-removes them, because
 * which copy is real is a judgement about CONTENT. That is the right default and it is also
 * where the user is left stranded: the notice says two graphs share a name and offers nothing
 * to tell them apart, and several copies show "not opened" because the registry only records
 * a statement count once a graph has been loaded.
 *
 * This module supplies the missing half — measure each copy, then RECOMMEND one, with the
 * reason stated and the confidence stated separately. It never deletes anything.
 *
 * WHY CONFIDENCE IS A SEPARATE FIELD, and the most important thing here. "Most facts" and
 * "most recently edited" usually agree, and when they do the choice is easy. When they
 * DISAGREE — the newer copy has fewer facts — that is the dangerous case, because it is
 * exactly what a truncated import, a failed sync or an accidental partial edit looks like.
 * Picking either one silently could destroy the only complete version. So a disagreement
 * lowers confidence and says so, rather than resolving itself with a tiebreak nobody saw.
 *
 * FACT COUNT IS COMPLETENESS, NOT ACCURACY. A bigger graph is not a more correct one; it is
 * only a bigger one. The recommendation is therefore always phrased as "more complete", and
 * a human is still the one deciding. That distinction is not pedantry — a stale copy that
 * accumulated junk imports will win on count while being the wrong answer.
 */

/** What we can measure about one copy without switching the app into it. */
export type KbProbe = {
  id: string;
  name: string;
  /** False when the registry lists an entry whose IndexedDB database does not exist. */
  exists: boolean;
  confirmed: number;
  pending: number;
  entities: number;
  /** max(updatedAt, createdAt) across statements — the graph's real content edit date. */
  lastEditedAt: number;
  /** Set when the copy could not be read; it is then never recommended. */
  error?: string;
};

export type DuplicateChoice = {
  keep: KbProbe;
  discard: KbProbe[];
  reason: string;
  /** high — safe to act on. low — the signals disagree; a human must look. */
  confidence: 'high' | 'low';
  /** True when every readable copy holds identical counts; the choice is then arbitrary. */
  identical: boolean;
};

function readable(p: KbProbe): boolean {
  return p.exists && !p.error;
}

/**
 * Recommend which copy to keep.
 *
 * Order of reasoning, and each step exists because of a case it gets right:
 *   1. Unreadable or absent copies lose outright — a registry row with no database behind it
 *      is a dangling entry, and unlinking it costs nothing.
 *   2. If exactly one copy is readable, keep it. Nothing to weigh.
 *   3. If the readable copies hold the same counts, say so and keep the OLDEST, because that
 *      is the one other things (leaps, sync baselines) are most likely to already reference.
 *   4. Otherwise prefer the most facts, and drop confidence when the fact-count winner is not
 *      also the most recently edited one.
 */
export function recommendDuplicateChoice(probes: KbProbe[]): DuplicateChoice | null {
  if (probes.length < 2) return null;

  const live = probes.filter(readable);
  const dead = probes.filter((p) => !readable(p));

  if (live.length === 0) return null;

  if (live.length === 1) {
    return {
      keep: live[0],
      discard: dead,
      reason:
        dead.length === 1 && !dead[0].exists
          ? 'The other entry has no database behind it — it is a dangling registry row, and unlinking it loses nothing.'
          : 'Only one copy could be read; the others are missing or unreadable.',
      confidence: 'high',
      identical: false,
    };
  }

  const byFacts = [...live].sort(
    (a, b) => b.confirmed - a.confirmed || b.entities - a.entities || a.lastEditedAt - b.lastEditedAt,
  );
  const newest = [...live].sort((a, b) => b.lastEditedAt - a.lastEditedAt)[0];
  const most = byFacts[0];

  const allSameCounts = live.every(
    (p) => p.confirmed === live[0].confirmed && p.entities === live[0].entities,
  );
  if (allSameCounts) {
    const oldest = [...live].sort((a, b) => a.lastEditedAt - b.lastEditedAt)[0];
    return {
      keep: oldest,
      discard: [...live.filter((p) => p.id !== oldest.id), ...dead],
      reason: `All copies hold the same ${live[0].confirmed} confirmed facts across ${live[0].entities} entities, so the choice is arbitrary. Keeping the oldest, since anything already referencing this graph is most likely pointing at it.`,
      confidence: 'high',
      identical: true,
    };
  }

  const agrees = most.id === newest.id;
  return {
    keep: most,
    discard: [...live.filter((p) => p.id !== most.id), ...dead],
    reason: agrees
      ? `Most complete (${most.confirmed} confirmed facts vs ${byFacts[1].confirmed}) and also the most recently edited, so both signals agree.`
      : `Most complete (${most.confirmed} confirmed facts vs ${byFacts[1].confirmed}) — BUT a different copy was edited more recently (${new Date(newest.lastEditedAt).toISOString().slice(0, 10)}). That disagreement is what a truncated import or a partial edit looks like, so open both before discarding either.`,
    confidence: agrees ? 'high' : 'low',
    identical: false,
  };
}

/** One-line summary for a copy, for the notice UI. */
export function describeProbe(p: KbProbe): string {
  if (!p.exists) return 'no database — dangling registry entry';
  if (p.error) return `unreadable (${p.error})`;
  const edited = p.lastEditedAt
    ? new Date(p.lastEditedAt).toISOString().slice(0, 10)
    : 'unknown date';
  const pending = p.pending > 0 ? `, ${p.pending} pending` : '';
  return `${p.confirmed} facts${pending} · ${p.entities} entities · edited ${edited}`;
}
