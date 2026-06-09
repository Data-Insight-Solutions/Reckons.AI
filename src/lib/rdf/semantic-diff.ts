/**
 * Semantic enrichment pass for structural diffs.
 *
 * computeDiff() works on exact IRI equality — it cannot see that
 * "matt-roe" and "matthew-roe" are likely the same person, or that
 * "loves" and "adores" are synonyms, or that "supports" and "opposes"
 * are antonyms.
 *
 * semanticEnrichDiff() runs AFTER computeDiff() and upgrades entries:
 *
 *   'new'       → 'near-duplicate'      if subject ≈ existing subject  (cosine ≥ 0.88)
 *   'new'       → 'synonym-reinforces'  if near-subject + synonym pred  (cosine ≥ 0.82)
 *   'new'       → 'antonym-conflicts'   if near-subject + antonym pred
 *   'conflicts' → 'synonym-reinforces'  if structural conflict is really synonym predicates
 *   'conflicts' → 'antonym-conflicts'   if predicates are known antonyms
 *
 * Entries that don't match any semantic pattern are returned unchanged.
 *
 * Antonym detection uses two signals:
 *   1. Negation morphology: one predicate is the other prefixed with
 *      not-, no-, non-, un-, dis-, anti-, counter-, never-
 *   2. A curated lookup table of common semantic opposites
 *
 * MiniLM embedding similarity alone does NOT reliably distinguish
 * antonyms from synonyms (both are semantically close). The morphology
 * and lookup signals are therefore required for antonym detection.
 */

import { embedMany, cosine } from '../embed';
import type { Diff, DiffEntry } from './diff';
import type { Statement } from './types';

// ── Thresholds ─────────────────────────────────────────────────────────────

/** Subject IRIs with cosine ≥ this are treated as the same entity. */
const SUBJECT_NEAR_DUPLICATE_THRESHOLD = 0.88;

/** Predicate IRIs with cosine ≥ this are treated as synonyms. */
const PREDICATE_SYNONYM_THRESHOLD = 0.82;

/**
 * Antonym predicates must have cosine in [MIN, MAX] — semantically related
 * but not identical — AND match a negation/antonym signal.
 * Prevents distant unrelated predicates from being flagged as antonyms.
 */
const ANTONYM_COSINE_MIN = 0.30;
const ANTONYM_COSINE_MAX = 0.79;

// ── Antonym knowledge ──────────────────────────────────────────────────────

const NEGATION_PREFIXES = ['not-', 'no-', 'non-', 'un-', 'dis-', 'anti-', 'counter-', 'never-'];

/** Symmetric antonym pairs for common predicates. */
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['love', 'hate'], ['loves', 'hates'],
  ['like', 'dislike'], ['likes', 'dislikes'],
  ['support', 'oppose'], ['supports', 'opposes'],
  ['agree', 'disagree'], ['agrees', 'disagrees'],
  ['confirm', 'deny'], ['confirms', 'denies'],
  ['enable', 'disable'], ['enables', 'disables'],
  ['accept', 'reject'], ['accepts', 'rejects'],
  ['trust', 'distrust'], ['trusts', 'distrusts'],
  ['include', 'exclude'], ['includes', 'excludes'],
  ['increase', 'decrease'], ['increases', 'decreases'],
  ['promote', 'demote'], ['promotes', 'demotes'],
  ['hire', 'fire'],
  ['start', 'stop'], ['starts', 'stops'],
  ['open', 'close'], ['opens', 'closes'],
  ['buy', 'sell'], ['buys', 'sells'],
  ['create', 'destroy'], ['creates', 'destroys'],
  ['remember', 'forget'], ['remembers', 'forgets'],
  ['succeed', 'fail'], ['succeeds', 'fails'],
  ['is-happy', 'is-sad'],
  ['is-true', 'is-false'],
  ['is-valid', 'is-invalid'],
  ['is-active', 'is-inactive'],
  ['is-present', 'is-absent'],
  ['is-healthy', 'is-sick'],
  ['is-rich', 'is-poor'],
  ['is-safe', 'is-dangerous'],
  ['is-legal', 'is-illegal'],
];

// ── Label extraction ────────────────────────────────────────────────────────

/** Extract a human-readable label from an IRI slug.
 *  urn:kbase:concept/matt-roe     → "matt roe"
 *  urn:kbase:predicate/loves      → "loves"
 *  http://example.org/has-name    → "has name"
 */
export function labelFromIRI(iriValue: string): string {
  const last = iriValue.split('/').pop() ?? iriValue;
  return last.replace(/-/g, ' ').replace(/_/g, ' ').trim();
}

function termLabel(term: Statement['s'] | Statement['o']): string {
  if (term.kind === 'iri') return labelFromIRI(term.value);
  return term.value;
}

// ── Antonym detection ───────────────────────────────────────────────────────

function isNegationOf(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  for (const prefix of NEGATION_PREFIXES) {
    if (al === prefix + bl || bl === prefix + al) return true;
    // also handle space-separated: "not loves" vs "loves"
    const spacePrefix = prefix.replace('-', ' ');
    if (al === spacePrefix + bl || bl === spacePrefix + al) return true;
  }
  return false;
}

function isKnownAntonym(a: string, b: string): boolean {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  for (const [x, y] of ANTONYM_PAIRS) {
    if ((al.includes(x) && bl.includes(y)) || (al.includes(y) && bl.includes(x))) return true;
  }
  return false;
}

function isAntonymPredicate(aIRI: string, bIRI: string, cosineSim: number): boolean {
  if (cosineSim < ANTONYM_COSINE_MIN || cosineSim > ANTONYM_COSINE_MAX) return false;
  const aLabel = labelFromIRI(aIRI);
  const bLabel = labelFromIRI(bIRI);
  return isNegationOf(aLabel, bLabel) || isKnownAntonym(aLabel, bLabel);
}

// ── Summary recounting ──────────────────────────────────────────────────────

function recountSummary(entries: DiffEntry[]): Diff['summary'] {
  const s = { new: 0, duplicate: 0, reinforces: 0, conflicts: 0, refines: 0, nearDuplicate: 0, synonymReinforces: 0, antonymConflicts: 0 };
  for (const e of entries) {
    switch (e.kind) {
      case 'new':               s.new++;               break;
      case 'duplicate':         s.duplicate++;         break;
      case 'reinforces':        s.reinforces++;        break;
      case 'conflicts':         s.conflicts++;         break;
      case 'refines':           s.refines++;           break;
      case 'near-duplicate':    s.nearDuplicate++;     break;
      case 'synonym-reinforces':s.synonymReinforces++; break;
      case 'antonym-conflicts': s.antonymConflicts++;  break;
    }
  }
  return s;
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * Semantically enrich a structural diff.
 *
 * Falls back to returning the original diff unchanged if embeddings fail
 * (e.g. model not yet downloaded, no network) — the structural diff is
 * always valid and safe to display.
 */
export async function semanticEnrichDiff(diff: Diff, existing: Statement[]): Promise<Diff> {
  if (diff.entries.length === 0) return diff;

  try {
    return await _enrich(diff, existing);
  } catch (err) {
    console.warn('[semantic-diff] enrichment failed, returning structural diff:', err);
    return diff;
  }
}

async function _enrich(diff: Diff, existing: Statement[]): Promise<Diff> {
  const incomingStatements = diff.entries.map(e => e.incoming);

  // ── Collect unique IRIs to embed ──────────────────────────────────────────

  const incomingSubjectIRIs = [...new Set(
    incomingStatements.filter(s => s.s.kind === 'iri').map(s => s.s.value)
  )];
  const existingSubjectIRIs = [...new Set(
    existing.filter(s => s.s.kind === 'iri').map(s => s.s.value)
  )];
  const allSubjectIRIs = [...new Set([...incomingSubjectIRIs, ...existingSubjectIRIs])];

  const incomingPredicateIRIs = [...new Set(incomingStatements.map(s => s.p.value))];
  const existingPredicateIRIs = [...new Set(existing.map(s => s.p.value))];
  const allPredicateIRIs = [...new Set([...incomingPredicateIRIs, ...existingPredicateIRIs])];

  // ── Embed in parallel ─────────────────────────────────────────────────────

  const [subjectVecs, predicateVecs] = await Promise.all([
    embedMany(allSubjectIRIs.map(labelFromIRI)),
    embedMany(allPredicateIRIs.map(labelFromIRI)),
  ]);

  const subjectVecMap = new Map<string, Float32Array>();
  allSubjectIRIs.forEach((iri, i) => subjectVecMap.set(iri, subjectVecs[i]));

  const predicateVecMap = new Map<string, Float32Array>();
  allPredicateIRIs.forEach((iri, i) => predicateVecMap.set(iri, predicateVecs[i]));

  // ── Index existing by subject ─────────────────────────────────────────────

  const existingBySubject = new Map<string, Statement[]>();
  for (const st of existing) {
    if (st.s.kind !== 'iri') continue;
    const k = st.s.value;
    if (!existingBySubject.has(k)) existingBySubject.set(k, []);
    existingBySubject.get(k)!.push(st);
  }

  // ── Build near-duplicate subject index ────────────────────────────────────
  // incSubjectIRI → sorted list of { existingIRI, sim }

  const nearSubjectMap = new Map<string, Array<{ iri: string; sim: number }>>();
  for (const incIRI of incomingSubjectIRIs) {
    const incVec = subjectVecMap.get(incIRI);
    if (!incVec) continue;
    const candidates: Array<{ iri: string; sim: number }> = [];
    for (const exIRI of existingSubjectIRIs) {
      if (exIRI === incIRI) continue;
      const exVec = subjectVecMap.get(exIRI);
      if (!exVec) continue;
      const sim = cosine(incVec, exVec);
      if (sim >= SUBJECT_NEAR_DUPLICATE_THRESHOLD) candidates.push({ iri: exIRI, sim });
    }
    if (candidates.length > 0) {
      nearSubjectMap.set(incIRI, candidates.sort((a, b) => b.sim - a.sim));
    }
  }

  // ── Enrich entries ────────────────────────────────────────────────────────

  const newEntries: DiffEntry[] = [];

  for (const entry of diff.entries) {
    const inc = entry.incoming;
    const incSubjectIRI = inc.s.kind === 'iri' ? inc.s.value : null;
    const nearSubjects = incSubjectIRI ? (nearSubjectMap.get(incSubjectIRI) ?? []) : [];
    const incPredVec = predicateVecMap.get(inc.p.value);

    // ── Case 1: Structural 'new' with a near-duplicate existing subject ──────
    if (entry.kind === 'new' && nearSubjects.length > 0) {
      const best = nearSubjects[0];
      const existingStmts = existingBySubject.get(best.iri) ?? [];

      if (existingStmts.length > 0 && incPredVec) {
        const synonymMatches: Statement[] = [];
        const antonymMatches: Statement[] = [];

        for (const exSt of existingStmts) {
          const exPredVec = predicateVecMap.get(exSt.p.value);
          if (!exPredVec) continue;
          const predSim = cosine(incPredVec, exPredVec);

          if (predSim >= PREDICATE_SYNONYM_THRESHOLD && inc.p.value !== exSt.p.value) {
            synonymMatches.push(exSt);
          } else if (isAntonymPredicate(inc.p.value, exSt.p.value, predSim)) {
            antonymMatches.push(exSt);
          }
        }

        if (synonymMatches.length > 0) {
          newEntries.push({
            kind: 'synonym-reinforces',
            incoming: inc,
            existing: synonymMatches,
            predicateSimilarity: cosine(incPredVec, predicateVecMap.get(synonymMatches[0].p.value)!)
          });
          continue;
        }
        if (antonymMatches.length > 0) {
          const incLabel = labelFromIRI(inc.p.value);
          const exLabels = antonymMatches.map(s => `"${labelFromIRI(s.p.value)}"`).join(', ');
          newEntries.push({
            kind: 'antonym-conflicts',
            incoming: inc,
            existing: antonymMatches,
            note: `"${incLabel}" may contradict ${exLabels} on a related entity`
          });
          continue;
        }
      }

      // Near-duplicate subject, no predicate signal → entity identity question
      newEntries.push({
        kind: 'near-duplicate',
        incoming: inc,
        existing: existingBySubject.get(best.iri)![0],
        subjectSimilarity: best.sim
      });
      continue;
    }

    // ── Case 2: Structural 'conflicts' — check if predicates are synonyms or antonyms ──
    if (entry.kind === 'conflicts' && incPredVec) {
      const synonymExisting = entry.existing.filter(ex => {
        const exVec = predicateVecMap.get(ex.p.value);
        return exVec && inc.p.value !== ex.p.value && cosine(incPredVec, exVec) >= PREDICATE_SYNONYM_THRESHOLD;
      });

      if (synonymExisting.length === entry.existing.length && synonymExisting.length > 0) {
        // All conflicting statements have synonym predicates → really a cross-source reinforcement
        const sim = cosine(incPredVec, predicateVecMap.get(synonymExisting[0].p.value)!);
        newEntries.push({ kind: 'synonym-reinforces', incoming: inc, existing: synonymExisting, predicateSimilarity: sim });
        continue;
      }

      const antonymExisting = entry.existing.filter(ex => {
        const exVec = predicateVecMap.get(ex.p.value);
        if (!exVec) return false;
        return isAntonymPredicate(inc.p.value, ex.p.value, cosine(incPredVec, exVec));
      });

      if (antonymExisting.length > 0) {
        const incLabel = labelFromIRI(inc.p.value);
        const exLabels = antonymExisting.map(s => `"${labelFromIRI(s.p.value)}"`).join(', ');
        newEntries.push({
          kind: 'antonym-conflicts',
          incoming: inc,
          existing: antonymExisting,
          note: `"${incLabel}" directly contradicts ${exLabels}`
        });
        continue;
      }
    }

    // No semantic signal — keep structural entry unchanged
    newEntries.push(entry);
  }

  return { entries: newEntries, summary: recountSummary(newEntries) };
}
