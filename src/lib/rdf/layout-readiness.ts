/**
 * F287.1 — HOW MUCH OF A SPACE EACH DEFAULT LAYOUT CAN PLACE (kb:layout-readiness).
 *
 * TIER: script. One pure function over a space's facts, no UI, no storage. For time, tree and
 * arrange it reports how many of the space's things the layout can place, out of how many, and
 * the short reason word for the rest (undated / no-parent / no-order) — the "time: 12 of 80
 * have a date" sentence kb:layouts-work-by-default asks for, computed by rule.
 *
 * A THING is any IRI that appears as the subject or object of a fact that is not rejected —
 * literals and blank nodes are not things, and a rejected fact is not about anything.
 *
 * THE THREE RULES REUSE THE LAYOUTS' OWN RESOLUTION, so the count can never disagree with what
 * the canvas actually draws:
 *
 *   time    — a subject with a parseable date under a recognised date predicate, exactly the
 *             rule the timeline renders with today (buildNodeTimes in rdf/timeline-layout.ts,
 *             event mode). A statement's createdAt is NEVER a date of the thing ("ADDED IS NOT
 *             DATED", the kb:layouts-work-by-default principle; the 2026-07-31 wall-of-nodes bug
 *             this rule was made to prevent).
 *   tree    — the things touched by a hierarchy edge as src/lib/rdf/hierarchy.ts defines them:
 *             skos:broader and kpred:depends-on, in either direction.
 *   arrange — the things carrying a stated order (urn:reckons:nav/order).
 *
 * FIRST DRAFT FOR REVIEW: the job spec names the three fields `placeable`, `total` and `missing`
 * ("a short reason word for the rest"). This draft returns the reason word as `reason` and adds
 * `missing` as its COUNT (`total - placeable`), so "3 of 10, 7 undated" is fully expressible.
 * Fold it into one field if the overseer prefers the spec's shape exactly.
 */

import { buildNodeTimes } from './timeline-layout';
import { KPRED_DEPENDS_ON, NAV_ORDER, SKOS_BROADER } from './hierarchy';
import { type Statement } from './types';

export type MissingReason = 'undated' | 'no-parent' | 'no-order';

export interface LayoutReadiness {
  /** How many of the space's things this layout can place. */
  placeable: number;
  /** How many things the space has. */
  total: number;
  /** How many it cannot place: `total - placeable`. */
  missing: number;
  /** The short reason word for the rest. */
  reason: MissingReason;
}

export interface SpaceReadiness {
  total: number;
  time: LayoutReadiness;
  tree: LayoutReadiness;
  arrange: LayoutReadiness;
}

/** A fact that is not rejected — the only facts a thing or a placement may rest on. */
function isLive(s: Statement): boolean {
  return s.status !== 'rejected';
}

/** The space's things: every IRI in a non-rejected fact's subject or object. */
export function thingIris(statements: readonly Statement[]): ReadonlySet<string> {
  const things = new Set<string>();
  for (const st of statements) {
    if (!isLive(st)) continue;
    if (st.s.kind === 'iri') things.add(st.s.value);
    if (st.o.kind === 'iri') things.add(st.o.value);
  }
  return things;
}

const HIERARCHY_PREDICATES = new Set([SKOS_BROADER, KPRED_DEPENDS_ON]);

function readiness(placeable: number, total: number, reason: MissingReason): LayoutReadiness {
  return { placeable, total, missing: total - placeable, reason };
}

/**
 * How much of this space each of the three always-offered layouts can place.
 * Deterministic: same facts, same answer, on every run and device.
 */
export function layoutReadiness(statements: readonly Statement[]): SpaceReadiness {
  const total = thingIris(statements).size;

  // TIME — the timeline's own rule (event mode): never createdAt, never a guess,
  // and a superseded date is not a date either, the way the renderer treats it.
  const timePlaceable = buildNodeTimes(statements, 'event').size;

  // TREE + ARRANGE in one pass.
  const tree = new Set<string>();
  const arrange = new Set<string>();
  for (const st of statements) {
    if (!isLive(st)) continue;
    if (HIERARCHY_PREDICATES.has(st.p.value)) {
      if (st.s.kind === 'iri') tree.add(st.s.value);
      if (st.o.kind === 'iri') tree.add(st.o.value);
    }
    if (st.p.value === NAV_ORDER && st.s.kind === 'iri') arrange.add(st.s.value);
  }

  return {
    total,
    time: readiness(timePlaceable, total, 'undated'),
    tree: readiness(tree.size, total, 'no-parent'),
    arrange: readiness(arrange.size, total, 'no-order'),
  };
}
