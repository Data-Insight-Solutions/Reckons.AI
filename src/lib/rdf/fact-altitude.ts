/**
 * ALTITUDE (F139) — how much does this fact MATTER, and what does it decide?
 *
 * Matt, 2026-08-19: "Real conflicting statements or deciding factors, not a long list of
 * datetime stamps of work being done, or statuses that can be verified with automated
 * testing... We need to elevate the type of facts higher than simplified logs."
 *
 * The review pipeline already classifies a fact three ways, and every one of them answers
 * "how do I HANDLE this":
 *
 *   verifiability.ts   WHO is competent to settle it        (machine / agent / user)
 *   finding-class.ts   WHAT KIND OF WRONG it reports        (form / drift / defect)
 *   dichotomy.ts       IS IT CONTESTED                      (conflict / natural dichotomy)
 *
 * None of them answers whether the fact is WORTH A HUMAN'S ATTENTION AT ALL. That is why
 * routing alone did not fix review: `kpred:relates-to` (476 facts in the roadmap, the single
 * most common predicate) is `unknown`-verifiable, so F88 routes all 476 to the user, ranks
 * them by blast radius, and presents a wall. Nothing in the system can say "this one is
 * bookkeeping and this one forecloses a direction".
 *
 * THE DISCRIMINATING TEST — and note it is about being WRONG, not about being interesting:
 *
 *     If this fact were wrong, what would we do differently?
 *
 *       choose a different path            -> DECISION   forecloses options
 *       believe the wrong thing about
 *         whether something is any good    -> JUDGMENT   a verdict no check can settle
 *       lose the footing under a judgment  -> EVIDENCE   a measurement that supports one
 *       fix a link                         -> RECORD     mechanical, a script settles it
 *       nothing                            -> LOG        it asserts only that a thing happened
 *
 * WHY LOG IS A CLASS AND NOT A FILTER. A log is not merely low-value — it has NO REVIEWABLE
 * CONTENT. "REMEDIATED 2026-08-16. Removed obsolete Storybook-8 addon..." cannot be accepted
 * or rejected, because the only claim it makes is that somebody did something, and the person
 * being asked is the person who did it. Putting it in a review queue is not inefficient, it is
 * incoherent. But it MUST STILL BE CLASSIFIED RATHER THAN DROPPED, because a log that
 * contradicts the evidence under a live decision is a deciding factor — see `liftedAltitude`.
 *
 * ORTHOGONAL TO EVERYTHING ABOVE, AND THAT IS THE POINT. Altitude does not say who settles a
 * fact (F88 does) or what kind of wrong it is (finding-class does). A `record` can be the
 * user's to approve; a `decision` can be perfectly well-formed. The axes compose, and the one
 * place they interact is stated explicitly below: AUTHORITY CAN LIFT, IT NEVER LOWERS.
 *
 * HONEST LIMIT, MEASURED, READ THIS BEFORE TRUSTING THE OUTPUT: this is a PREDICATE table, so
 * its coverage is exactly as good as a graph's predicate discipline. On this repo's roadmap it
 * classifies well because that graph has a rich, deliberate vocabulary. On `static/knowledge.ttl`
 * it will not, and on a user's business graph it will not either — the same trap
 * kb:verifiability-axis flags about itself ("the tooling must not assume its own conditions
 * generalize"). Run `npx tsx scripts/offline/altitude-report.ts` on the real graph and read the
 * unclassified share before believing any tree built on top of this.
 */
import type { Statement } from './types';
import { isLit } from './types';
import { requiresUserAuthority } from './verifiability';

const KPRED = 'urn:kbase:predicate/';

/**
 * Highest to lowest. The order IS the review tree's depth.
 *
 * Derived from `Statement['altitude']` so a hand-set override and the classifier can never come to
 * mean different things — this module imports Statement, so the union has to live there.
 */
export type Altitude = NonNullable<Statement['altitude']>;

export const ALTITUDE_RANK: Record<Altitude, number> = {
  decision: 4,
  judgment: 3,
  evidence: 2,
  record: 1,
  log: 0,
};

export const ALTITUDE_META: Record<
  Altitude,
  { label: string; ifWrong: string; reviewable: boolean }
> = {
  decision: {
    label: 'Decision — it forecloses options',
    ifWrong: 'we go the wrong direction',
    reviewable: true,
  },
  judgment: {
    label: 'Judgment — a verdict no check can settle',
    ifWrong: 'we believe something untrue about whether the thing is any good',
    reviewable: true,
  },
  evidence: {
    label: 'Evidence — a measurement under a judgment',
    ifWrong: 'a judgment above it loses its footing',
    reviewable: true,
  },
  record: {
    label: 'Record — mechanical, a script settles it',
    ifWrong: 'a link needs fixing',
    // Reviewable in principle, but never by a person: this is F88's machine lane.
    reviewable: false,
  },
  log: {
    label: 'Log — it asserts only that something happened',
    // The person who would review it is the person who did it. There is nothing to weigh.
    ifWrong: 'nothing — there is no claim in it to be wrong about',
    reviewable: false,
  },
};

/**
 * DECISION — authored, and it closes off alternatives.
 *
 * `decided` and `open-question` are the two halves that matter most and they are NOT the same
 * item: a decided fact is standing CONTEXT (the tree shows it so a reviewer knows what was
 * already chosen), an open question is a LIVE ITEM. See `isOpenDecision`.
 */
const DECISION_PREDICATES = new Set([
  `${KPRED}decided`,
  `${KPRED}decision`,
  `${KPRED}decision-owner`,
  `${KPRED}open-question`,
  `${KPRED}scope-decision`,
  `${KPRED}principle`,
  `${KPRED}constraint`,
  `${KPRED}tenet-body`,
  `${KPRED}we-avoid`,
  `${KPRED}avoid-reason`,
  `${KPRED}reason`,
  `${KPRED}priority`,
  // The SHAPE of the plan is an authored choice, not an observation (verifiability.ts agrees).
  `${KPRED}depends-on`,
  `${KPRED}gated-by`,
  `${KPRED}scope`,
  `${KPRED}copy-permitted`,
  // The everyday-decision vocabulary already in static/starter-everyday.ttl, and it is the best
  // primitive in this whole file: `ruled-out-by` marks a fact that DIES if a given option wins,
  // so an option's cost is COMPUTABLE from the graph instead of narrated in prose. See
  // optionCost() in review-tree.ts — this is why the tree never needs a model to invent tradeoffs.
  `${KPRED}ruled-out-by`,
  `${KPRED}decides`,
  `${KPRED}deciding`,
  `${KPRED}gates`,
  `${KPRED}review-gate`,
  `${KPRED}acceptance`,
  `${KPRED}blockedBy`,
  `${KPRED}requires-documentation`,
]);

/** JUDGMENT — qualitative, and no number of green checks settles it (F135.2). */
const JUDGMENT_PREDICATES = new Set([
  // kb:claim-settlement, decided: "STATUS IS A QUALITATIVE CLAIM EVEN WHEN IT RESTS ON
  // CALCULABLE EVIDENCE." A passing suite can never derive has-status "functional".
  `${KPRED}has-status`,
  `${KPRED}tenet-status`,
  `${KPRED}description`,
  `${KPRED}definition`,
  `${KPRED}summary`,
  `${KPRED}honest-note`,
  `${KPRED}honest-limit`,
  `${KPRED}known-issue`,
  `${KPRED}known-gap`,
  `${KPRED}risk`,
  `${KPRED}remaining`,
  `${KPRED}note`,
  `${KPRED}idea`,
  `${KPRED}candidate`,
  `${KPRED}consequence`,
  `${KPRED}status`,
  `${KPRED}disclaimer`,
  'http://www.w3.org/2004/02/skos/core#definition',
  'http://www.w3.org/2000/01/rdf-schema#comment',
]);

/** EVIDENCE — somebody ran something, or counted something, and this is the reading. */
const EVIDENCE_PREDICATES = new Set([
  `${KPRED}measured`,
  `${KPRED}measurement`,
  `${KPRED}evidence`,
  `${KPRED}proof`,
  `${KPRED}test-coverage`,
  `${KPRED}expected-result`,
  `${KPRED}actual-files`,
  `${KPRED}actual-deps`,
  `${KPRED}estimated-files`,
  `${KPRED}estimated-deps`,
  `${KPRED}example`,
  // Safety-attestation readings: a control either verified or it did not (F66 / SAFETY.md).
  `${KPRED}control`,
  `${KPRED}controls-verified`,
  `${KPRED}controls-total`,
  `${KPRED}checks`,
  `${KPRED}assertion`,
]);

/** RECORD — a link or an identifier. A script opens it or it does not. */
const RECORD_PREDICATES = new Set([
  `${KPRED}has-file`,
  `${KPRED}tested-by`,
  `${KPRED}touches-file`,
  `${KPRED}touches-module`,
  `${KPRED}has-source-file`,
  `${KPRED}enforced-by`,
  `${KPRED}feature-id`,
  `${KPRED}relates-to`,
  `${KPRED}related`,
  `${KPRED}part-of`,
  `${KPRED}has-part`,
  `${KPRED}has-phase`,
  `${KPRED}broader`,
  `${KPRED}moved-to`,
  `${KPRED}repo-url`,
  `${KPRED}license`,
  `${KPRED}icon2d`,
  `${KPRED}icon3d`,
  `${KPRED}page`,
  `${KPRED}order`,
  `${KPRED}show-on-landing`,
  `${KPRED}landing-label`,
  // The code-file graph (F?/reckons-code-files.ttl) is mechanical by construction: 981 imports,
  // 509 paths, 139 is-test flags. A script derived every one of them and a script re-derives them.
  `${KPRED}imports`,
  `${KPRED}path`,
  `${KPRED}is-test`,
  // Which sentence a triple was read out of. Mechanical by construction — the extractor wrote it
  // and re-running extraction re-derives it — so it is a record, not a claim about the world.
  // The FACT "Orange Logic is an enterprise DAM" needs a human; that it came from a note dictated
  // at 16:56 does not.
  `${KPRED}extracted-from`,
  `${KPRED}depends-on-module`,
  `${KPRED}provides`,
  `${KPRED}has-feature`,
  `${KPRED}has-tool`,
  `${KPRED}has-tab`,
  `${KPRED}has-source-type`,
  `${KPRED}closest-to`,
  `${KPRED}photo`,
  `${KPRED}photo-source`,
  `${KPRED}photo-credit`,
  `${KPRED}publishedBy`,
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  'http://www.w3.org/2000/01/rdf-schema#label',
  'http://www.w3.org/2004/02/skos/core#prefLabel',
  'http://www.w3.org/2004/02/skos/core#broader',
]);

/** LOG — a narration of work done, addressed to nobody who can dispute it. */
const LOG_PREDICATES = new Set([
  `${KPRED}progress`,
  `${KPRED}done`,
  `${KPRED}changelog`,
  `${KPRED}updated`,
  `${KPRED}history`,
  // Timestamps. `dcterms:created` alone is 221 facts in static/knowledge.ttl — the largest single
  // block of pure bookkeeping in the public graph, and it was defaulting to `judgment`.
  'http://purl.org/dc/terms/created',
  `${KPRED}date`,
  `${KPRED}git-commit`,
  // Voice capture. A dictated sentence stamped with the time it was said asserts only that
  // somebody said something, and the person who would be asked to confirm it is the person who
  // said it — the definition of a fact with no reviewable content. The KNOWLEDGE in a note is
  // whatever extraction reads out of it, and those triples are reviewed on their own merits.
  // Matt, 2026-08-27: "a raw note with timestamp is not a knowledge point its a log".
  `${KPRED}captured-note`,
  `${KPRED}extracted-at`,
]);

/**
 * Prefix families, so a graph that grows `proof-ui` / `honest-note-2` does not silently fall
 * through to the default. Checked AFTER the exact sets, longest prefix first.
 */
const PREFIX_FAMILIES: Array<[string, Altitude]> = [
  [`${KPRED}open-question`, 'decision'],
  [`${KPRED}decision`, 'decision'],
  [`${KPRED}decided`, 'decision'],
  [`${KPRED}principle`, 'decision'],
  [`${KPRED}constraint`, 'decision'],
  [`${KPRED}honest`, 'judgment'],
  [`${KPRED}known`, 'judgment'],
  [`${KPRED}has-status`, 'judgment'],
  [`${KPRED}description`, 'judgment'],
  [`${KPRED}remaining`, 'judgment'],
  [`${KPRED}proof`, 'evidence'],
  [`${KPRED}measure`, 'evidence'],
  [`${KPRED}evidence`, 'evidence'],
  [`${KPRED}estimated`, 'evidence'],
  [`${KPRED}actual`, 'evidence'],
  [`${KPRED}has-file`, 'record'],
  [`${KPRED}tested-by`, 'record'],
  [`${KPRED}touches`, 'record'],
  [`${KPRED}progress`, 'log'],
  [`${KPRED}done`, 'log'],
];


/**
 * NAMESPACE FAMILIES — the tier that makes this table generalize instead of growing forever.
 *
 * Measured 2026-08-19: enumerating predicates one at a time reached 92.3% coverage on the
 * roadmap and 11.5% on static/knowledge.ttl. The misses were not a long tail of interesting
 * vocabulary — they were whole NAMESPACES of machinery: app navigation meta, test-story
 * structure, Shelly persona config, schema.org bookkeeping, PROV provenance links. Every one of
 * those is a `record` by construction, and a new predicate added inside any of them will be too.
 *
 * So classify the namespace, not the term. This is the difference between a table that decays
 * and a rule that holds — and it is the promotion-ladder move F74.3 asks for: the reliable part
 * becomes a rule, and the rule is right by construction rather than by enumeration.
 */
const NAMESPACE_FAMILIES: Array<[string, Altitude]> = [
  // App/view machinery. isMetaPredicate already suppresses nav ordering on the canvas; the same
  // facts have no business in a review queue either.
  ['urn:reckons:nav/', 'record'],
  ['urn:reckons:meta/', 'record'],
  ['urn:reckons:leap', 'record'],
  ['urn:reckons:shelly/', 'record'],
  // Test stories are STRUCTURE (partOf/order/title/highlight). `story/content` and
  // `story/question` are prose and are lifted by the suffix rules below.
  ['urn:reckons:story/', 'record'],
  ['urn:sweep:pred/', 'judgment'],
  // Interchange vocabulary: identifiers, links, positions. dcterms:created is a LOG and is
  // listed in the exact set above, which is checked first — order matters here.
  ['https://schema.org/', 'record'],
  ['http://schema.org/', 'record'],
  ['http://purl.org/dc/terms/', 'record'],
  ['http://www.w3.org/ns/prov#', 'record'],
  ['http://www.w3.org/2004/02/skos/core#related', 'record'],
  ['http://www.w3.org/2004/02/skos/core#broader', 'record'],
];

/**
 * SUFFIX RULES — the local name says what kind of thing it is, whatever namespace it lives in.
 *
 * A predicate ending `-at` or `-date` holds a timestamp; a timestamp asserts that something
 * happened at a moment, which is the definition of a log. Applied AFTER namespaces so a
 * `urn:reckons:story/content` can be pulled back up out of its structural family.
 */
const SUFFIX_RULES: Array<[RegExp, Altitude]> = [
  [/(^|[/#])(created|updated|modified)$/i, 'log'],
  [/-(at|date|time|timestamp)$/i, 'log'],
  [/(^|[/#])(content|prose|body|rationale|why)$/i, 'judgment'],
  [/(^|[/#])question$/i, 'decision'],
  [/(^|[/#])(id|slug|uri|url|iri|name|label|title)$/i, 'record'],
];

/**
 * A work-completion narration: the literal opens by announcing that something got done.
 *
 * DELIBERATELY APPLIED ONLY TO UNCLASSIFIED PREDICATES, and getting that ordering wrong is a
 * real trap this project already contains. `kpred:evidence "MEASURED 2026-08-15, and it is
 * worse than it reads..."` opens exactly like a log and is the load-bearing measurement behind
 * a whole planned feature. So the predicate table always wins; shape is only a last resort
 * before the default.
 */
const COMPLETION_OPENER =
  /^(DONE|SHIPPED|WIRED|LANDED|APPLIED|COMPLETE[D]?|REMEDIATED|FIXED|RESOLVED|MERGED|IMPLEMENTED|BUILT|ADDED|REMOVED|CORRECTED|MIGRATED|REPLACED|RENAMED|DELIVERED)\b/;

/** A datestamp anywhere in the literal. Weak on its own; meaningful paired with the opener. */
const CARRIES_DATE = /\b20\d\d-\d\d-\d\d\b/;

/**
 * A work-completion narration wearing a JUDGMENT predicate — demote it to `log`.
 *
 * Matt, 2026-08-19: "We do NOT want to represent the user with hundreds of separate 'facts' that
 * are just log lines tracing work completion." Correct, and the predicate table alone could not
 * catch these: `kpred:remaining "PHASE 1 — DONE (2026-07-31), except the OPFS fallback"`,
 * `kpred:note "RESOLVED (2026-07-02): the bare-404 finding was a missing route"`, and
 * `kpred:correction "CORRECTED 2026-08-17: the honest-header check compared…"` are all
 * judgment-class predicates carrying pure narration of finished work. Measured on the roadmap:
 * 13 facts match both signals, 48 match the opener alone.
 *
 * BOTH SIGNALS ARE REQUIRED, and the pairing is the safety mechanism. The opener alone would
 * catch prose that merely begins emphatically; a date alone appears in 197 unattached facts,
 * most of which are real judgments that happen to cite when something was measured. Requiring
 * an opener AND a datestamp narrows it to the shape that is unambiguously a work record.
 *
 * IT CAN STILL BE WRONG, AND HERE IS THE CASE: `kpred:honest-note "RESOLVED 2026-07-31, BOTH
 * HALVES — but the shape of the old failure is the lesson worth keeping."` opens as a log and
 * ends as a judgment. Demoting it loses the lesson from the review surface. That is survivable
 * only because demotion HIDES, never deletes: the fact stays classified, stays in the openable
 * drawer, and `liftedAltitudes` pulls it back up the moment its subject has a live decision. A
 * rule that deleted instead of ranking could not be allowed to be wrong this way.
 */
function isCompletionNarration(st: Statement): boolean {
  if (!isLit(st.o)) return false;
  const v = st.o.value.trim();
  return COMPLETION_OPENER.test(v) && CARRIES_DATE.test(v);
}

/** A literal that is nothing but a date or timestamp — pure bookkeeping. */
const DATE_ONLY = /^\s*\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?\s*$/;

export function isAltitude(v: string): v is Altitude {
  return v === 'decision' || v === 'judgment' || v === 'evidence' || v === 'record' || v === 'log';
}

/**
 * Classify one fact. SCRIPT TIER — a table and two regexes, no model, no judgment call.
 *
 * FAIL DIRECTION IS UPWARD, and it is not the same direction F88 fails in. F88 sends the
 * unclassified to the USER, because auto-approving an unclassified fact is the quiet disaster.
 * Here the quiet disaster is the opposite one: guessing `log` on a fact nobody classified would
 * HIDE a real decision, and hiding it is worse than showing noise. So unclassified lands on
 * `judgment` — high enough that a person still sees it, but not `decision`, because flooding
 * the top of the tree with unclassified prose would destroy the very signal the tree exists to
 * create. Read that as an admission: the default is a compromise, and the fix for it is
 * predicate discipline in the graph, not a cleverer guess here.
 */
/**
 * Predicate -> base altitude, cached.
 *
 * The tables above are constant, so a predicate's classification never changes within a session —
 * but the review pipeline calls altitudeOf three or four times per statement (the tree, the index,
 * the cascade, the roll-up). Measured 2026-08-19 on a 40,433-fact synced graph, that repetition was
 * ~110ms of the ~220ms buildReviewTree cost, on the main thread, inside a $derived that re-runs on
 * every accept. Caching by predicate removes the table walk without changing a single answer.
 *
 * `null` means "the predicate alone does not decide it" — those fall through to the per-statement
 * checks below (a partial fact, or a literal's shape), which genuinely depend on the statement.
 */
const predicateAltitudeCache = new Map<string, Altitude | null>();

/** The part of the classification that depends ONLY on the predicate. */
function predicateAltitude(p: string): Altitude | null {
  const hit = predicateAltitudeCache.get(p);
  if (hit !== undefined) return hit;

  let result: Altitude | null = null;
  if (DECISION_PREDICATES.has(p)) result = 'decision';
  else if (JUDGMENT_PREDICATES.has(p)) result = 'judgment';
  else if (EVIDENCE_PREDICATES.has(p)) result = 'evidence';
  else if (RECORD_PREDICATES.has(p)) result = 'record';
  else if (LOG_PREDICATES.has(p)) result = 'log';
  else {
    for (const [prefix, alt] of PREFIX_FAMILIES) {
      if (p.startsWith(prefix)) { result = alt; break; }
    }
    if (result === null) {
      const ns = NAMESPACE_FAMILIES.find(([prefix]) => p.startsWith(prefix));
      for (const [re, alt] of SUFFIX_RULES) {
        if (re.test(p)) { result = alt; break; }
      }
      if (result === null && ns) result = ns[1];
    }
  }

  predicateAltitudeCache.set(p, result);
  return result;
}

/**
 * Classifications the USER has accepted for this graph's own predicates, and which therefore
 * outrank the built-in table.
 *
 * WHY AN OVERRIDE AT ALL. The table was built from Reckons' authored graphs and reaches 95.1%
 * there; on a captured graph it reaches 39.6%, and everything it misses defaults to `judgment`.
 * `review-tree` already ruled on the remedy — "the fix is predicate discipline in the graph, not
 * a cleverer guess in the classifier" — and discipline in the graph needs somewhere to live.
 *
 * THE USER OUTRANKS THE TABLE, AND ONLY THE USER. This is set from facts a person accepted in
 * review (`<predicate> kpred:altitude "log"`), never from an extractor and never from a proposal.
 * A pipeline that could quietly reclassify predicates could quietly hide decisions, which is the
 * one failure the whole altitude design exists to prevent.
 */
let userAltitudes: ReadonlyMap<string, Altitude> = new Map();

/** Install the accepted classifications. Pass an empty map to clear. */
export function setUserAltitudes(map: ReadonlyMap<string, Altitude>): void {
  userAltitudes = map;
  predicateAltitudeCache.clear();
}

export function altitudeOf(st: Statement): Altitude {
  const p = st.p.value;

  // A hand-set altitude on this fact wins over everything, including the predicate-level
  // override: it is the most specific thing a person has said about this exact statement. No
  // completion-narration demotion applies — the user has looked at this one and ruled.
  if (st.altitude) return st.altitude;

  const byUser = userAltitudes.get(p);
  if (byUser !== undefined) {
    // The completion-narration demotion still applies: a user saying "this predicate is a
    // judgment" is a statement about the PREDICATE, not a promise about every literal under it.
    if (byUser === 'judgment' && isCompletionNarration(st)) return 'log';
    return byUser;
  }

  const byPredicate = predicateAltitude(p);
  if (byPredicate !== null) {
    // The one predicate-classified case that still depends on the statement: a judgment predicate
    // whose literal is pure work-completion narration is a log. Decision- and evidence-class
    // predicates are deliberately exempt (see isCompletionNarration).
    if (byPredicate === 'judgment' && isCompletionNarration(st)) return 'log';
    return byPredicate;
  }

  if (DECISION_PREDICATES.has(p)) return 'decision';
  // A judgment predicate narrating finished work is a log, not a verdict. Decision- and
  // evidence-class predicates are deliberately NOT subject to this: `kpred:evidence "MEASURED
  // 2026-08-15, and it is worse than it reads"` is the load-bearing measurement behind a planned
  // feature and opens exactly like a log.
  if (JUDGMENT_PREDICATES.has(p)) return isCompletionNarration(st) ? 'log' : 'judgment';
  if (EVIDENCE_PREDICATES.has(p)) return 'evidence';
  if (RECORD_PREDICATES.has(p)) return 'record';
  if (LOG_PREDICATES.has(p)) return 'log';

  for (const [prefix, alt] of PREFIX_FAMILIES) {
    if (!p.startsWith(prefix)) continue;
    return alt === 'judgment' && isCompletionNarration(st) ? 'log' : alt;
  }

  // Namespace before suffix, so a structural family is the baseline and a suffix can lift out
  // of it (story/content is prose living in a structural namespace).
  const ns = NAMESPACE_FAMILIES.find(([prefix]) => p.startsWith(prefix));
  for (const [re, alt] of SUFFIX_RULES) if (re.test(p)) return alt;
  if (ns) return ns[1];

  // A partial fact is an open hole, and an open hole is a question — the most useful node in
  // the graph (kb:mission). Never let one fall through to the default.
  if (st.needsObject) return 'decision';

  if (isLit(st.o)) {
    const v = st.o.value.trim();
    if (DATE_ONLY.test(v)) return 'log';
    if (COMPLETION_OPENER.test(v)) return 'log';
  }

  return 'judgment';
}

/** True when this predicate (or its family) is actually in the table — for honest coverage. */
export function isClassified(st: Statement): boolean {
  const p = st.p.value;
  // A predicate the user has ruled on is classified BY DEFINITION — that is what coverage means.
  if (userAltitudes.has(p)) return true;
  if (
    DECISION_PREDICATES.has(p) ||
    JUDGMENT_PREDICATES.has(p) ||
    EVIDENCE_PREDICATES.has(p) ||
    RECORD_PREDICATES.has(p) ||
    LOG_PREDICATES.has(p)
  )
    return true;
  if (PREFIX_FAMILIES.some(([prefix]) => p.startsWith(prefix))) return true;
  if (NAMESPACE_FAMILIES.some(([prefix]) => p.startsWith(prefix))) return true;
  return SUFFIX_RULES.some(([re]) => re.test(p));
}

/**
 * The altitude a fact is REVIEWED at, once authority is taken into account.
 *
 * AUTHORITY CAN LIFT, IT NEVER LOWERS — the one interaction between this axis and F88. Minting
 * a feature (`kpred:feature-id`) or attaching a phase looks like bookkeeping and classifies as
 * `record`, but verifiability.ts reserves it to the user because it is an act of AUTHORSHIP.
 * If altitude were allowed to demote it, the fact would land in the collapsed records drawer
 * and the person whose call it is would never see it. So a user-authority fact floors at
 * `judgment`. The converse is forbidden: authority must not be able to push a decision DOWN,
 * or an authority list becomes a way to hide decisions.
 */
export function reviewAltitude(st: Statement, typeOf?: string): Altitude {
  const base = altitudeOf(st);
  if (ALTITUDE_RANK[base] >= ALTITUDE_RANK.judgment) return base;
  return requiresUserAuthority(st, typeOf) ? 'judgment' : base;
}

/**
 * Is this a decision still OPEN — awaiting a person — rather than one already made?
 *
 * The distinction the flat queue could not express. `kpred:decided` and `kpred:open-question`
 * are both `decision` altitude and they belong in the same place in the tree, but one is
 * standing context and the other is the live item. Showing them alike is how a review surface
 * re-asks a question that was answered in March.
 */
export function isOpenDecision(st: Statement): boolean {
  if (altitudeOf(st) !== 'decision') return false;
  if (st.needsObject) return true;
  return st.p.value.startsWith(`${KPRED}open-question`);
}

/**
 * ROLL-UP: the altitude a fact INHERITS from what depends on it.
 *
 * This is the piece that makes altitude a tree rather than a sort key, and the reason `log` is
 * classified instead of dropped. A log entry on its own decides nothing. A log entry sitting
 * under a live decision, contradicting the evidence that decision rests on, is a DECIDING
 * FACTOR — and a design that filtered logs at the door could never surface it.
 *
 * The dependency relation used here is deliberately the cheap, defensible one: facts about the
 * SAME SUBJECT are part of the same case, so a fact is lifted to the highest OPEN altitude
 * present on its subject. Cross-entity lifting through `blocks` is left to review-routing's
 * blastRadius, which already walks that chain transitively — combining them here would compute
 * the same walk twice and disagree with it at the edges.
 *
 * `lifted` is never written to the statement and never rendered as the fact's own class. It is
 * a view-time ranking, because a log whose neighbours are important is still a log.
 */
export function liftedAltitudes(statements: Statement[]): Map<string, Altitude> {
  const highestOpenBySubject = new Map<string, Altitude>();
  for (const st of statements) {
    // Only OPEN items lift their neighbours. A settled decision is context; if it lifted
    // everything on its subject, every fact under every answered question would rank as urgent.
    if (!isOpenDecision(st)) continue;
    const key = st.s.value;
    const cur = highestOpenBySubject.get(key);
    const alt = altitudeOf(st);
    if (!cur || ALTITUDE_RANK[alt] > ALTITUDE_RANK[cur]) highestOpenBySubject.set(key, alt);
  }

  const out = new Map<string, Altitude>();
  for (const st of statements) {
    const own = altitudeOf(st);
    const lift = highestOpenBySubject.get(st.s.value);
    out.set(st.id, lift && ALTITUDE_RANK[lift] > ALTITUDE_RANK[own] ? lift : own);
  }
  return out;
}

/** One line for a report or a queue note. */
export function explainAltitude(a: Altitude): string {
  const m = ALTITUDE_META[a];
  return `${m.label}. If it were wrong: ${m.ifWrong}.`;
}

export interface AltitudeCensus {
  counts: Record<Altitude, number>;
  total: number;
  /** Facts whose predicate is in the table at all — the honest coverage number. */
  classified: number;
  /** Share of facts a person should never have been shown: record + log. */
  suppressedShare: number;
}

/** Count a graph by altitude. The number that says whether any of this is working. */
export function censusByAltitude(statements: Statement[]): AltitudeCensus {
  const counts: Record<Altitude, number> = { decision: 0, judgment: 0, evidence: 0, record: 0, log: 0 };
  let classified = 0;
  for (const st of statements) {
    counts[altitudeOf(st)]++;
    if (isClassified(st)) classified++;
  }
  const total = statements.length;
  const suppressed = counts.record + counts.log;
  return { counts, total, classified, suppressedShare: total ? suppressed / total : 0 };
}
