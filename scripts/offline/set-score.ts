/**
 * SET SCORING (F187.3) — did extraction find the GROUPINGS, and did it refuse the fake one.
 *
 * Its own module rather than more of extraction-score.ts, because Matt's 2026-09-08 direction is
 * that the stages are separate and separately scored: "we need all of these extraction steps as
 * potentially separate ... this is not simple, so neither should be the testing and benchmarking."
 * A stage with its own file has its own tests and can be run, changed and reasoned about without
 * touching the relation scorer that has been stable since 2026-09-04.
 *
 * WHAT A SET LOOKS LIKE IN EXTRACTOR OUTPUT. Nothing emits skos:Collection today, so this reads
 * MEMBERSHIP rather than typing: a subject with two or more membership edges IS a candidate set,
 * whatever it calls itself. Both directions are read, because models emit either and picking one
 * would score a naming convention instead of a grouping:
 *
 *     shortlist  --has-member-->  aprimo        (forward)
 *     aprimo     --member-of-->   shortlist     (inverse)
 *
 * FOUR NUMBERS, NEVER ONE. A single "set score" would hide exactly the failures that matter:
 *
 *   RECALL     of the expected members, how many are in the matched candidate
 *   PRECISION  how many of the candidate's members belong — a model that sweeps in every nearby
 *              noun scores high recall and low precision, and an average would conceal that
 *   ORDER      for sequenced sets only, whether matched members are in the stated sequence
 *   COHESION   whether the members landed in ONE set or were scattered across several. A model
 *              that emits three two-member sets instead of one six-member set has full recall and
 *              has not understood the grouping.
 *
 * AND THE TRAP IS SCORED APART FROM ALL OF THEM (Matt, 2026-09-08). A list the source explicitly
 * says is not a group must NOT be grouped. Averaging that into recall would let a model that
 * groups every bullet list score well, and "bullet list => collection" is precisely the rule that
 * would fill a real graph with junk. So it is reported beside recall and never inside it.
 */

import { norm, normPredicate } from './extraction-score.js';
import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor.js';

/** A set the corpus says should be found. Shape mirrors expectations.json `sets`. */
export interface SetExpectation {
  id: string;
  why: string;
  label: string[];
  /** One accepted-slug array per member, matched the way s/p/o slots are. */
  members: string[][];
  ordered?: boolean;
  exclusive?: boolean;
  /** For an OVERLAP assertion: this member must appear in every set id listed. */
  mustAppearInSets?: string[];
}

/** A list in the source that must NOT become a set. */
export interface NotSetExpectation {
  id: string;
  why: string;
  members: string[][];
  insteadExpect?: string;
}

/**
 * Membership predicates, forward and inverse.
 *
 * Deliberately generous on the FORWARD side and narrow on the INVERSE. "part-of" and "in" are
 * everyday relations that mean many things — a phase is part of a migration, but a wheel is also
 * part of a car and that is not membership of a set. Reading them as membership would manufacture
 * candidate sets out of ordinary structural facts and inflate every score here. So the inverse
 * list carries only terms whose primary sense IS membership.
 */
const MEMBER_FORWARD = [
  'member', 'has-member', 'include', 'contain', 'comprise', 'consist-of', 'made-up-of',
  'group', 'list', 'shortlist', 'candidate',
];
const MEMBER_INVERSE = ['member-of', 'belong-to', 'in-group', 'listed-in', 'shortlisted-in'];

/** Predicates that carry a position. Order is read from these, never from emission order. */
const ORDINAL = ['order', 'position', 'step', 'phase', 'index', 'rank', 'sequence', 'number'];

const hits = (accepted: string[], actual: string): boolean => {
  const a = normPredicate(actual);
  if (!a) return false;
  return accepted.some((e) => {
    const n = normPredicate(e);
    return n === a || (n.length > 3 && a.length > 3 && (a.startsWith(n) || a.endsWith(n)));
  });
};

const memberMatches = (accepted: string[], actual: string): boolean => {
  const a = norm(actual);
  if (!a) return false;
  return accepted.some((e) => {
    const n = norm(e);
    return n === a || (n.length > 4 && a.length > 4 && (a.startsWith(n) || n.startsWith(a)));
  });
};

export interface CandidateSet {
  /** Normalized slug of the subject acting as the set. */
  slug: string;
  /** Normalized member slugs, insertion-ordered. */
  members: string[];
  /** member slug -> ordinal, where the extractor stated one. */
  ordinals: Map<string, number>;
}

/**
 * Every subject that groups two or more things.
 *
 * TWO IS THE FLOOR, and it is a real choice. A single membership edge is indistinguishable from
 * an ordinary fact — "aprimo member-of shortlist" alone is just a claim about Aprimo — so treating
 * it as a set would turn any relation into a grouping and make the metric meaningless.
 */
export function findCandidateSets(triples: ExtractedTriple[]): CandidateSet[] {
  const byslug = new Map<string, CandidateSet>();
  const get = (slug: string): CandidateSet => {
    let c = byslug.get(slug);
    if (!c) { c = { slug, members: [], ordinals: new Map() }; byslug.set(slug, c); }
    return c;
  };

  for (const t of triples) {
    if (hits(MEMBER_INVERSE, t.predicate)) {
      const c = get(norm(t.object));
      const m = norm(t.subject);
      if (m && !c.members.includes(m)) c.members.push(m);
    } else if (hits(MEMBER_FORWARD, t.predicate)) {
      const c = get(norm(t.subject));
      const m = norm(t.object);
      if (m && !c.members.includes(m)) c.members.push(m);
    }
  }

  // Ordinals are attached afterwards so they apply however membership was expressed.
  for (const t of triples) {
    if (!hits(ORDINAL, t.predicate)) continue;
    const n = parseInt(String(t.object).replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n)) continue;
    const m = norm(t.subject);
    for (const c of byslug.values()) if (c.members.includes(m)) c.ordinals.set(m, n);
  }

  return [...byslug.values()].filter((c) => c.members.length >= 2);
}

export interface SetScore {
  id: string;
  found: boolean;
  /** The candidate this expectation was matched to, if any. */
  matched?: string;
  recall: number;
  /** Only meaningful when the expectation is exclusive; null otherwise. */
  precision: number | null;
  /** Only meaningful when the expectation is ordered; null otherwise. */
  order: number | null;
  /** How many distinct candidates hold at least one expected member. >1 means fragmented. */
  spread: number;
  /** Members of the matched candidate that do not belong. */
  extras: string[];
  /** Expected members found nowhere. */
  missing: string[];
}

/** Longest common subsequence length — how much of the stated sequence survived. */
function lcs(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

export function scoreSets(expected: SetExpectation[], triples: ExtractedTriple[]): SetScore[] {
  const candidates = findCandidateSets(triples);

  return expected.filter((e) => !e.mustAppearInSets).map((exp) => {
    // Match on MEMBER OVERLAP, not on label. A grouping with the right members and a name nobody
    // expected is a success; one named "shortlist" holding the wrong things is not.
    let best: CandidateSet | undefined;
    let bestHits = 0;
    for (const c of candidates) {
      const n = exp.members.filter((m) => c.members.some((cm) => memberMatches(m, cm))).length;
      if (n > bestHits) { bestHits = n; best = c; }
    }

    const spread = candidates.filter((c) =>
      exp.members.some((m) => c.members.some((cm) => memberMatches(m, cm)))).length;

    if (!best || bestHits === 0) {
      return {
        id: exp.id, found: false, recall: 0, precision: exp.exclusive ? 0 : null,
        order: exp.ordered ? 0 : null, spread: 0, extras: [],
        missing: exp.members.map((m) => m[0]),
      };
    }

    const matchedFor = (m: string[]) => best!.members.find((cm) => memberMatches(m, cm));
    const foundMembers = exp.members.map(matchedFor);
    const recall = foundMembers.filter(Boolean).length / exp.members.length;
    const extras = best.members.filter((cm) => !exp.members.some((m) => memberMatches(m, cm)));
    const precision = exp.exclusive
      ? (best.members.length ? (best.members.length - extras.length) / best.members.length : 0)
      : null;

    let order: number | null = null;
    if (exp.ordered) {
      const want = foundMembers.filter((x): x is string => Boolean(x));
      // Prefer a stated ordinal; fall back to the candidate's own member order, and say so in the
      // report rather than pretending emission order is an assertion about sequence.
      const got = [...want].sort((x, y) => {
        const ox = best!.ordinals.get(x), oy = best!.ordinals.get(y);
        if (ox !== undefined && oy !== undefined) return ox - oy;
        return best!.members.indexOf(x) - best!.members.indexOf(y);
      });
      order = want.length ? lcs(want, got) / want.length : 0;
    }

    return {
      id: exp.id, found: true, matched: best.slug, recall, precision, order, spread, extras,
      missing: exp.members.filter((m) => !matchedFor(m)).map((m) => m[0]),
    };
  });
}

export interface OverlapScore { id: string; held: boolean; presentIn: string[]; requiredIn: string[] }

/**
 * Did a member that belongs to several sets actually land in several?
 *
 * This is the assertion F187 is built around — sets OVERLAP and do not partition — and it cannot
 * be read off the per-set scores, because a model that puts OpenText in the shortlist and removes
 * it from the deployed set scores full recall on one and merely-low on the other. Only asking the
 * question directly catches partitioning.
 */
export function scoreOverlap(
  expected: SetExpectation[], scores: SetScore[], triples: ExtractedTriple[],
): OverlapScore[] {
  const candidates = findCandidateSets(triples);
  return expected.filter((e) => e.mustAppearInSets).map((exp) => {
    const member = exp.members[0] ?? [];
    const presentIn = exp.mustAppearInSets!.filter((setId) => {
      const s = scores.find((x) => x.id === setId);
      if (!s?.matched) return false;
      const cand = candidates.find((c) => c.slug === s.matched);
      return Boolean(cand?.members.some((cm) => memberMatches(member, cm)));
    });

    /*
     * THE MATCHED CANDIDATES MUST BE DISTINCT, and a test caught this being wrong.
     *
     * When a model PARTITIONS — putting OpenText in the shortlist and leaving it out of the
     * deployed set — the deployed set drops to one member, falls below the candidate floor, and
     * the expectation for it then matches the SHORTLIST instead, on their one shared member. Both
     * expected sets resolve to the same grouping, that grouping contains OpenText, and the overlap
     * reads as held. It is the exact failure the check exists to detect, reported as a pass.
     *
     * So overlap holds only when the member is in several sets that are actually SEVERAL. One
     * grouping doing double duty is a partition with a matching error on top of it.
     */
    const matchedSlugs = presentIn
      .map((setId) => scores.find((x) => x.id === setId)?.matched)
      .filter((x): x is string => Boolean(x));
    const distinct = new Set(matchedSlugs).size;

    return {
      id: exp.id,
      held: presentIn.length === exp.mustAppearInSets!.length
        && distinct === exp.mustAppearInSets!.length,
      presentIn: distinct === presentIn.length ? presentIn : presentIn.slice(0, distinct),
      requiredIn: exp.mustAppearInSets!,
    };
  });
}

export interface TrapScore { id: string; refused: boolean; groupedAs?: string; grouped: string[] }

/**
 * Was a list the source calls "not a group" left ungrouped?
 *
 * A MAJORITY is the threshold, not any single member. Two of the three concern-vendors appearing
 * together in some other legitimate grouping is not evidence of the failure — the shortlist itself
 * contains all three vendors, and it is a real set. What the trap detects is a candidate whose
 * membership IS the concern list, which is why it also requires the candidate to hold no more than
 * the trap members plus one.
 */
export function scoreTraps(notSets: NotSetExpectation[], triples: ExtractedTriple[]): TrapScore[] {
  const candidates = findCandidateSets(triples);
  return notSets.map((exp) => {
    for (const c of candidates) {
      const grouped = exp.members.filter((m) => c.members.some((cm) => memberMatches(m, cm)));
      const isMajority = grouped.length > exp.members.length / 2;
      const isTight = c.members.length <= exp.members.length + 1;
      if (isMajority && isTight) {
        return { id: exp.id, refused: false, groupedAs: c.slug, grouped: grouped.map((m) => m[0]) };
      }
    }
    return { id: exp.id, refused: true, grouped: [] };
  });
}
