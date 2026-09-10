#!/usr/bin/env npx tsx
/**
 * Tenet alignment — does the roadmap still agree with what we say we believe? (F74.3, SCRIPT tier)
 *
 * WHY THIS IS A JOB AND NOT A CONVERSATION. Reading 247 features against ten tenets by hand is the
 * definition of something Opus should do once and then never again: it costs a fortune, it is not
 * reproducible, and the answer goes stale the moment someone adds a feature. Everything here is
 * decidable by a rule, so it runs for free, in CI, every session — which is the only way an
 * alignment check becomes a habit rather than an event.
 *
 * WHAT IT CANNOT DO, said plainly. A regex cannot read intent. It finds features whose own words
 * TOUCH a tenet's subject — an account, a hosted server, a closed dependency, a claim of safety —
 * and asks whether the feature acknowledges the tension. A feature can pass every check here and
 * still betray a tenet in spirit, and a flag here can be entirely correct design that simply says
 * so out loud. The output is a reading list for a human, not a verdict. That is why nothing here
 * writes to a TTL.
 *
 * The checks, each one earned rather than invented:
 *
 *   ACCOUNT PRESSURE   — kb:tenet-no-account. A feature whose text needs a login, a sign-up, or a
 *                        server holding user state, and does not say whose account it is. The tenet
 *                        names publishing and cross-device sync as the two places this pressure is
 *                        expected, so a feature in those areas must acknowledge it explicitly.
 *   CLOSED BY DEFAULT  — kb:tenet-open. Names a proprietary service where an open one exists, with
 *                        no stated reason for the choice.
 *   EXPORT REACHABLE   — kb:tenet-export. A feature that stores something the user creates must
 *                        leave it reachable by export; a store with no export is a lock-in.
 *   UNVERIFIED CLAIM   — kb:tenet-evidence / kb:tenet-honesty. A feature marked `functional` or
 *                        `production` with no kpred:tested-by and no kpred:measured is a claim
 *                        made by the party it benefits.
 *   OVERCLAIM          — kb:tenet-honesty. A feature that is NOT built (planned/speculative) whose
 *                        description is written in the present tense as though it were.
 *   ORPHAN TENET       — kb:tenet-link. A tenet nothing in the roadmap relates to is decoration.
 *   DANGLING DEPEND    — a kpred:depends-on pointing at a feature that does not exist.
 *   STATUS REGRESSION  — depends-on a feature LESS built than itself: you cannot be production on
 *                        top of something speculative.
 *
 * Usage:
 *   npx tsx scripts/offline/tenet-align.ts            # report
 *   npx tsx scripts/offline/tenet-align.ts --pending  # also queue findings for human review
 *   npx tsx scripts/offline/tenet-align.ts --tenet=no-account   # one tenet only
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';
import { transactPendingQueue } from './pending-queue.js';
import { readTextOr } from '../lib/read-file.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const QUEUE = argv.includes('--pending');
const ONLY = flag('tenet');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const TENET_TYPE = 'urn:kbase:type/Tenet';

/** Lifecycle, ordered. A feature may not depend on something earlier in this list than itself. */
const BUILT_RANK: Record<string, number> = {
  speculative: 0, planned: 1, 'in-progress': 2, scaffolded: 3, functional: 4, production: 5,
};
const IS_BUILT = (s: string | undefined) => (BUILT_RANK[s ?? ''] ?? 0) >= 4;

// ── Load every graph, because a feature can be described in more than one ────

const quads: Quad[] = [];
for (const f of readdirSync('static').filter((n) => n.endsWith('.ttl'))) {
  try { quads.push(...new Parser().parse(readFileSync(path.join('static', f), 'utf8'))); }
  catch { /* graph-lint reports unparseable graphs; this job must not die on one. */ }
}
const objectsOf = (s: string, p: string) =>
  quads.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value);
const label = (s: string) => objectsOf(s, RDFS_LABEL)[0] ?? s.split('/').pop() ?? s;

/** Every subject any graph says anything about — the test for whether a reference points at all. */
const defined = new Set(quads.map((q) => q.subject.value));

const features = [...new Set(
  quads.filter((q) => q.predicate.value === `${KPRED}feature-id`).map((q) => q.subject.value),
)];
const tenets = [...new Set(
  quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === TENET_TYPE)
    .map((q) => q.subject.value),
)];

/** Everything a feature says about itself, lowercased, for keyword work. */
function textOf(subject: string): string {
  return quads
    .filter((q) => q.subject.value === subject && q.object.termType === 'Literal')
    .map((q) => q.object.value)
    .join(' \n ')
    .toLowerCase();
}

interface Finding {
  check: string; tenet: string; subject: string; detail: string;
  severity: 'high' | 'medium' | 'low';
}
const findings: Finding[] = [];
const add = (f: Finding) => { if (!ONLY || f.tenet.includes(ONLY)) findings.push(f); };

// ── The checks ───────────────────────────────────────────────────────────────

const NEEDS_ACCOUNT = /\b(sign[- ]?up|signup|create an account|user account|log ?in|login|register an?|authenticate(?:d|s)? user|oauth)\b/;
// NOT "session token": in this codebase a token is an LLM token, and F74.4's session-token METRIC
// (how many Opus tokens a session spent) was flagged as an authentication concern. A word that
// means two things in the same repo is not a usable signal.
/** Whose account it is decides everything: the user's own third-party credential is not our login. */
const OWNS_IT = /\b(your own|user'?s own|their own|byo|bring your own|per-user|self-hosted|user-supplied|own api key|own instance)\b/;
const HOSTED_STATE = /\b(our server|hosted backend|central(?:ised|ized)? (?:server|database|store)|server[- ]side (?:state|storage)|multi[- ]tenant)\b/;

const PROPRIETARY = /\b(google drive|dropbox|onedrive|firebase|supabase|auth0|algolia|pinecone|openai|anthropic|notion api|slack api)\b/;
const OPEN_ALTERNATIVE = /\b(open|self-hosted|local|ollama|sqlite|postgres|webdav|filesystem|indexeddb|standard|w3c|mit|apache)\b/;

const STORES_USER_DATA = /\b(stores?|persist(?:s|ed)?|saves?|writes? to (?:disk|indexeddb|the database)|database|archive)\b/;
const EXPORTABLE = /\b(export|download|ttl|turtle|json[- ]?ld|jsonl|markdown|round[- ]trip|portable)\b/;

for (const f of features) {
  const text = textOf(f);
  const status = objectsOf(f, `${KPRED}has-status`)[0];
  const id = objectsOf(f, `${KPRED}feature-id`)[0] ?? '?';

  // ACCOUNT PRESSURE
  if (NEEDS_ACCOUNT.test(text) && !OWNS_IT.test(text)) {
    add({
      check: 'account-pressure', tenet: 'kb:tenet-no-account', subject: f, severity: 'high',
      detail: `${id} needs a login/sign-up and never says whose account it is. The tenet allows an `
        + `account that belongs to the USER and lives with a third party they chose; it does not `
        + `allow one with us. Say which this is, on the entity.`,
    });
  }
  if (HOSTED_STATE.test(text)) {
    add({
      check: 'hosted-state', tenet: 'kb:tenet-no-account', subject: f, severity: 'high',
      detail: `${id} describes server-side state. The app is static files and a browser database — `
        + `"there is nothing to log in TO" is a structural claim, and a hosted store quietly ends it.`,
    });
  }

  // CLOSED BY DEFAULT
  if (PROPRIETARY.test(text) && !OPEN_ALTERNATIVE.test(text)) {
    add({
      check: 'closed-default', tenet: 'kb:tenet-open', subject: f, severity: 'medium',
      detail: `${id} names a proprietary service (${text.match(PROPRIETARY)![0]}) without naming an `
        + `open option or a reason. "Open source wins the tie" needs the tie to be acknowledged.`,
    });
  }

  // EXPORT REACHABLE
  if (STORES_USER_DATA.test(text) && !EXPORTABLE.test(text) && IS_BUILT(status)) {
    add({
      check: 'export-unreachable', tenet: 'kb:tenet-export', subject: f, severity: 'medium',
      detail: `${id} is ${status} and stores something the user made, with no export path named. `
        + `"Export is a right" is only true where a route out actually exists.`,
    });
  }

  // UNVERIFIED CLAIM
  if (IS_BUILT(status)
    && objectsOf(f, `${KPRED}tested-by`).length === 0
    && objectsOf(f, `${KPRED}measured`).length === 0) {
    add({
      check: 'unverified-claim', tenet: 'kb:tenet-evidence', subject: f, severity: 'high',
      detail: `${id} is marked ${status} with no kpred:tested-by and no kpred:measured. `
        + `"An unverifiable claim, made by the party it benefits, is not evidence" — and we are the `
        + `party it benefits.`,
    });
  }

  // OVERCLAIM — present tense about something not built, but ONLY where a reader sees the text
  // without the status beside it. Inside the roadmap, a `planned` entity describing what it will
  // do is not a lie: kpred:has-status is right there, and that is the whole point of the field.
  // The first version ignored this and flagged 27 ordinary roadmap entries. It matters on the
  // LANDING PAGE, where the sentence travels alone.
  const isPublished = objectsOf(f, `${KPRED}show-on-landing`)[0] === 'true';
  if (!IS_BUILT(status) && isPublished) {
    const desc = objectsOf(f, `${KPRED}description`).join(' ');
    const presentTense = /\b(?:automatically |silently )?(?:renders|shows|lets you|allows you to|gives you|provides|displays|keeps|handles|runs|generates|detects)\b/i;
    const hedged = /\b(will|would|planned|intended|not yet|does not exist|unbuilt|no .* yet)\b/i;
    if (desc && presentTense.test(desc) && !hedged.test(desc)) {
      add({
        check: 'overclaim', tenet: 'kb:tenet-honesty', subject: f, severity: 'high',
        detail: `${id} is ${status} but its description is written in the present tense `
          + `("${desc.match(presentTense)![0]}"). Aspiration in the present tense is a lie with `
          + `good manners — the reader cannot tell this does not exist.`,
      });
    }
  }

  // DANGLING + REGRESSING DEPENDENCIES
  for (const dep of objectsOf(f, `${KPRED}depends-on`)) {
    // A dependency is dangling only if NOTHING defines it. The first version tested for a
    // feature-id and produced 39 findings of which ZERO were real: a shipped feature moves to
    // reckons-shipped.ttl and leaves a `kpred:moved-to` stub with no feature-id, so every
    // dependency on anything shipped was reported as broken. Emitting 39 false positives does not
    // move cost off a human, it moves it from generation to triage (F74.3).
    if (!defined.has(dep)) {
      add({
        check: 'dangling-depends', tenet: 'kb:tenet-link', subject: f, severity: 'medium',
        detail: `${id} depends-on <${dep}>, which nothing in any graph defines. A forced link is `
          + `worse than an orphan, and a link to nothing is worse still.`,
      });
      continue;
    }
    if (!features.includes(dep)) continue; // defined, but carries no status to compare
    const depStatus = objectsOf(dep, `${KPRED}has-status`)[0];
    if ((BUILT_RANK[status ?? ''] ?? 0) > (BUILT_RANK[depStatus ?? ''] ?? 0) + 1) {
      add({
        check: 'status-regression', tenet: 'kb:tenet-honesty', subject: f, severity: 'high',
        detail: `${id} is ${status} but depends on ${label(dep)} which is only ${depStatus}. `
          + `One of the two statuses is wrong.`,
      });
    }
  }
}

// ORPHAN TENET — a principle nothing is built against.
for (const t of tenets) {
  const referenced = quads.some((q) =>
    q.object.value === t && q.subject.value !== t && !q.predicate.value.endsWith('part-of'));
  if (!referenced) {
    add({
      check: 'orphan-tenet', tenet: t.replace('urn:kbase:concept/', 'kb:'), subject: t,
      severity: 'low',
      detail: `Nothing in any graph relates to "${label(t)}". A tenet no feature is measured `
        + `against is decoration — either something should point at it, or it is not load-bearing.`,
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const RANK = { high: 0, medium: 1, low: 2 } as const;
findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.check.localeCompare(b.check));

const byCheck = new Map<string, Finding[]>();
for (const f of findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);

console.log(`\nTenet alignment — ${features.length} features against ${tenets.length} tenets\n`);
for (const [check, list] of [...byCheck].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${check.toUpperCase()} (${list.length})  ${list[0].tenet}`);
  for (const f of list.slice(0, 4)) console.log(`     ${label(f.subject)}\n       ${f.detail}`);
  if (list.length > 4) console.log(`     … and ${list.length - 4} more`);
  console.log();
}
const high = findings.filter((f) => f.severity === 'high').length;
console.log(`${findings.length} finding(s) — ${high} high.`);
console.log(
  'These are a READING LIST, not a verdict: a rule cannot read intent, so a flag may be correct '
  + 'design that simply says so out loud, and a pass proves only that the words did not trip a check.',
);

if (QUEUE && findings.length) {
  const rows = findings.map((f) => JSON.stringify({
    subject: f.subject, predicate: `${KPRED}tenet-conflict`, object: f.tenet, objectKind: 'iri',
    type: 'drift-warning', agent: 'offline:tenet-align', priority: f.severity === 'high' ? 'high' : 'low',
    addedAt: new Date().toISOString(), note: `[${f.check}] ${f.detail}`,
  }));
  const before = readTextOr(PENDING, '').split('\n').filter(Boolean).length;
  transactPendingQueue(PENDING, (current) => {
    // Recomputed from scratch every run, so this run's findings replace the last one's rather than
    // stacking a duplicate queue every time the job runs (RECOMPUTABLE_AGENTS semantics).
    const kept = current.split('\n').filter(Boolean).filter((l) => {
      try { return (JSON.parse(l) as { agent?: string }).agent !== 'offline:tenet-align'; }
      catch { return true; }
    });
    return { content: [...kept, ...rows].join('\n') + '\n', result: true };
  });
  const after = readTextOr(PENDING, '').split('\n').filter(Boolean).length;
  console.log(`\nQueued ${rows.length} finding(s) for review (queue ${before} → ${after}).`);
}

process.exitCode = 0; // a reading list never fails the build
