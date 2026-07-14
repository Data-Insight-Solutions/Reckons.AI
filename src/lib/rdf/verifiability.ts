/**
 * Verifiability (F88 / kb:verifiability-axis) — HOW could this fact be checked, and
 * therefore WHO is competent to approve it.
 *
 * Provenance answers "where did this fact come from". Verifiability answers a different and
 * more consequential question: "could anyone check it, and with what?" The review queue has
 * always assumed the answer is *the user*, for every fact. That is wrong in both directions:
 *
 *   - It puts facts in front of the user that a SCRIPT could settle in a millisecond
 *     ("does src/lib/foo.ts exist?"). Asking a human that wastes the scarcest resource in
 *     the system, and worse, it trains them to click Accept without reading.
 *
 *   - It implies the user is the competent reviewer for everything. They are not. They may
 *     not be the expert on this code, or on this domain. A queue that cannot say "this one
 *     is not yours to judge" will get judged badly.
 *
 * So a fact carries what would SETTLE it, and the gate follows from that:
 *
 *   code     a file, a path, a symbol — a script settles it. Nobody need be asked.
 *   test     a suite asserts it — run the suite.
 *   source   a cited passage backs it — check the excerpt actually says that.
 *   user     only the person knows. Their business, their intent, their preference.
 *   unknown  NOBODY has established this. It is not false — it is unsettled, and saying so
 *            is the honest move. This is where a partial fact belongs.
 *
 * THE THESIS, APPLIED: a `user` fact is not worthless, but it is not the same KIND of fact
 * as a `code` one. It is self-attested — an unverifiable claim, made by the party it
 * benefits. Recording it is fine. LAUNDERING it into looking verified is not. This type is
 * what keeps the two apart.
 */
import type { Statement, Verifiability } from './types';

export type { Verifiability };

/** Who is competent to approve a pending statement of that class. */
export type Gate = 'machine' | 'agent' | 'user';

const KPRED = 'urn:kbase:predicate/';

/**
 * VERIFIABLE IS NOT THE SAME AS APPROVABLE, and conflating them is how a graph quietly
 * stops being yours.
 *
 * A script can verify that a principle IS WRITTEN. It cannot approve that it is the RIGHT
 * principle. The roadmap and the tenets are not observations to be checked — they are
 * DECISIONS, and the user is their author, not merely their auditor. `kpred:has-status
 * "functional"` is a claim about the code and a machine should absolutely check it. But
 * ADDING a feature, changing what we are trying to build, or editing a core principle is an
 * act of authorship, and no amount of verifiability makes it a machine's call.
 *
 * These predicates express INTENT or VALUE rather than fact. They are reserved to the user
 * however checkable they happen to be — and the more critical they are (the tenets, the
 * thesis), the more absolutely so.
 */
const USER_AUTHORITY_PREDICATES = new Set([
  `${KPRED}principle`,
  `${KPRED}reason`,
  `${KPRED}avoid-reason`,
  `${KPRED}decided`,
  `${KPRED}decision-owner`,
  `${KPRED}scope`,
  `${KPRED}feature-id`, // minting a feature is planning, not observing
  `${KPRED}has-phase`,
  `${KPRED}depends-on`, // the shape of the plan
  `${KPRED}remaining`,
  `${KPRED}we-avoid`,
]);

/** Types whose every fact is the user's to decide. The tenets are the product's spine. */
const USER_AUTHORITY_TYPES = new Set(['urn:kbase:type/Tenet', 'urn:kbase:type/Decision']);

/**
 * Is this fact the user's to DECIDE, rather than anyone's to verify?
 *
 * `typeOf` is the rdf:type of the subject, when known — a Tenet or a Decision is reserved
 * whatever the predicate says.
 */
export function requiresUserAuthority(st: Statement, typeOf?: string): boolean {
  if (USER_AUTHORITY_PREDICATES.has(st.p.value)) return true;
  if (typeOf && USER_AUTHORITY_TYPES.has(typeOf)) return true;
  return false;
}

/**
 * Who should be gating this.
 *
 * `code` and `test` do NOT route to the human. A script settles them, and where the change
 * needs real judgment (reviewing what a sub-agent actually wrote), the competent reviewer is
 * a frontier coding agent — not the user, who may not be the expert on this code at all.
 *
 * AUTHORITY OVERRIDES VERIFIABILITY. A roadmap change or a principle goes to the user even
 * though a script could check it, because checkable and approvable are different things.
 *
 * UNCLASSIFIED DEFAULTS TO THE USER. Never auto-approve a fact whose verifiability nobody
 * has established: an unclassified fact silently machine-approved is precisely the quiet
 * failure this whole axis exists to prevent. Fail toward the human, always.
 */
export function competentGate(v: Verifiability | undefined, opts?: { userAuthority?: boolean }): Gate {
  if (opts?.userAuthority) return 'user';
  switch (v) {
    case 'code':
    case 'test':
      return 'machine';
    case 'source':
      // Did the cited passage ACTUALLY say this? A model can read the excerpt and judge;
      // a human spot-checks. It is judgment over language, so it is the agent tier (F74.3).
      return 'agent';
    case 'user':
    case 'unknown':
      return 'user';
    default:
      return 'user';
  }
}

/** The gate for a whole statement — the call site that gets this right. */
export function gateFor(st: Statement, typeOf?: string): Gate {
  return competentGate(st.verifiableBy ?? inferVerifiability(st), {
    userAuthority: requiresUserAuthority(st, typeOf),
  });
}

/** True when this fact can be settled without asking a person. */
export function isMachineSettleable(v: Verifiability | undefined): boolean {
  return competentGate(v) === 'machine';
}

/** Predicates whose object IS a repo path — a script can check it exists. */
const PATH_PREDICATES = new Set([
  `${KPRED}has-file`,
  `${KPRED}tested-by`,
  `${KPRED}has-source-file`,
  `${KPRED}enforced-by`,
]);

/** Predicates that assert something a test suite settles. */
const TEST_PREDICATES = new Set([`${KPRED}test-coverage`, `${KPRED}expected-result`]);

/** Looks like a repo-relative source path (not a URL, not prose). */
export function looksLikePath(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (/^https?:\/\//.test(value)) return false;
  return /^[\w.@-]+(\/[\w.@-]+)+\.\w+$/.test(value);
}

/**
 * Infer verifiability from the fact itself (SCRIPT tier — a rule, not a judgment).
 *
 * Deliberately conservative: it returns `unknown` rather than guessing. `unknown` is a
 * correct and useful answer — it means nobody has established how this could be checked,
 * which routes it to a human rather than quietly asserting it is fine. Guessing `code` on a
 * fact that is not code-checkable would hand it to a machine gate that cannot actually
 * settle it, which is worse than admitting we do not know.
 */
export function inferVerifiability(st: Statement): Verifiability {
  const p = st.p.value;
  const o = st.o.value;

  // A path is a path. A script opens it or it does not.
  if (PATH_PREDICATES.has(p) && looksLikePath(o)) return 'code';
  if (TEST_PREDICATES.has(p)) return 'test';

  // A grounded excerpt means a real passage was verified to contain this. That is a source.
  if (st.grounded === true && st.excerpt) return 'source';

  // Hand-entered, with no source behind it, is the user's own word. That is attestation —
  // legitimate, and it must be LABELLED as such rather than blended in with the rest.
  if (st.sourceId === 'manual') return 'user';

  // A partial fact is, by definition, not yet settled by anything. That is the honest label,
  // and it is the most useful node in the graph (kb:mission): a well-formed absence.
  if (st.needsObject) return 'unknown';

  return 'unknown';
}

/** Human-readable, for the review queue. */
export const VERIFIABILITY_LABEL: Record<Verifiability, string> = {
  code: 'checkable in the code',
  test: 'asserted by a test',
  source: 'backed by a cited passage',
  user: 'attested by you — nothing else backs it',
  unknown: 'unsettled — nobody has established this',
};

export const GATE_LABEL: Record<Gate, string> = {
  machine: 'a script settles this',
  agent: 'a reviewing agent settles this',
  user: 'only you can settle this',
};
