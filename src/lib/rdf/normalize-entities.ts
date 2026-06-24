/**
 * Ingest-time entity normalisation.
 *
 * Runs AFTER LLM extraction and triplesToStatements(), BEFORE the statements
 * are persisted or diffed. Rewrites incoming IRIs to match existing KB entities
 * and predicates when embedding similarity is high enough.
 *
 * This prevents duplicate entities like "common-octopus" vs "octopus-vulgaris"
 * from entering the review queue as separate entities — they get normalised to
 * the existing IRI before the user ever sees them.
 *
 * Thresholds are intentionally conservative (slightly above semantic-diff) to
 * avoid false merges. The review queue is the safety net for borderline cases.
 */

import { embedMany, cosine } from '../embed';
import type { Statement } from './types';
import { labelFromIRI } from './semantic-diff';

/** Subject IRIs with cosine >= this are treated as the same entity. */
const SUBJECT_MATCH_THRESHOLD = 0.90;

/** Predicate IRIs with cosine >= this are treated as the same predicate. */
const PREDICATE_MATCH_THRESHOLD = 0.88;

/** Don't bother embedding if the KB has more entities than this (perf guard). */
const MAX_EXISTING_ENTITIES = 500;

/** Don't normalise predicates from the standard vocabularies. */
const PROTECTED_PREFIXES = [
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2004/02/skos/core#',
  'http://www.w3.org/2001/XMLSchema#',
];

function isProtected(iri: string): boolean {
  return PROTECTED_PREFIXES.some(p => iri.startsWith(p));
}

export interface NormalizeResult {
  /** The (potentially rewritten) statements */
  statements: Statement[];
  /** Number of subject IRIs that were remapped */
  subjectRemaps: number;
  /** Number of predicate IRIs that were remapped */
  predicateRemaps: number;
  /** Details of each remap for logging */
  remaps: Array<{ from: string; to: string; kind: 'subject' | 'predicate'; similarity: number }>;
}

/**
 * Normalise incoming statements against existing KB entities.
 *
 * Falls back to returning statements unchanged if embeddings fail
 * (model not downloaded, consent declined, etc.).
 */
export async function normalizeEntities(
  incoming: Statement[],
  existing: Statement[]
): Promise<NormalizeResult> {
  const identity: NormalizeResult = {
    statements: incoming,
    subjectRemaps: 0,
    predicateRemaps: 0,
    remaps: [],
  };

  if (incoming.length === 0 || existing.length === 0) return identity;

  try {
    return await _normalize(incoming, existing);
  } catch (err) {
    console.warn('[normalize] entity normalisation failed, using raw statements:', err);
    return identity;
  }
}

async function _normalize(
  incoming: Statement[],
  existing: Statement[]
): Promise<NormalizeResult> {
  // ── Collect unique IRIs ──────────────────────────────────────────────────

  const incomingSubjectIRIs = [...new Set(
    incoming.filter(s => s.s.kind === 'iri').map(s => s.s.value)
  )];
  const incomingPredicateIRIs = [...new Set(
    incoming.filter(s => !isProtected(s.p.value)).map(s => s.p.value)
  )];
  const incomingObjectIRIs = [...new Set(
    incoming.filter(s => s.o.kind === 'iri').map(s => s.o.value)
  )];

  const existingSubjectIRIs = [...new Set(
    existing.filter(s => s.s.kind === 'iri').map(s => s.s.value)
  )];
  const existingPredicateIRIs = [...new Set(
    existing.filter(s => !isProtected(s.p.value)).map(s => s.p.value)
  )];
  const existingObjectIRIs = [...new Set(
    existing.filter(s => s.o.kind === 'iri').map(s => s.o.value)
  )];

  // Perf guard: skip if KB is very large
  const existingEntityIRIs = [...new Set([...existingSubjectIRIs, ...existingObjectIRIs])];
  if (existingEntityIRIs.length > MAX_EXISTING_ENTITIES) {
    console.info(`[normalize] KB has ${existingEntityIRIs.length} entities (>${MAX_EXISTING_ENTITIES}), skipping normalisation`);
    return { statements: incoming, subjectRemaps: 0, predicateRemaps: 0, remaps: [] };
  }

  // ── Build remap tables ─────────────────────────────────────────────────

  const entityRemap = new Map<string, string>(); // incoming IRI → existing IRI
  const predicateRemap = new Map<string, string>();

  // Incoming entity IRIs = subjects + non-literal objects (deduplicated)
  const incomingEntityIRIs = [...new Set([...incomingSubjectIRIs, ...incomingObjectIRIs])];

  // Filter to only IRIs that don't already exist in the KB
  const newEntityIRIs = incomingEntityIRIs.filter(iri => !existingEntityIRIs.includes(iri));
  const newPredicateIRIs = incomingPredicateIRIs.filter(iri => !existingPredicateIRIs.includes(iri));

  // Nothing new to normalise
  if (newEntityIRIs.length === 0 && newPredicateIRIs.length === 0) {
    return { statements: incoming, subjectRemaps: 0, predicateRemaps: 0, remaps: [] };
  }

  // ── Embed and match entities ───────────────────────────────────────────

  if (newEntityIRIs.length > 0 && existingEntityIRIs.length > 0) {
    const newLabels = newEntityIRIs.map(labelFromIRI);
    const existingLabels = existingEntityIRIs.map(labelFromIRI);

    // Quick exact-label check before expensive embeddings
    const existingLabelMap = new Map<string, string>();
    existingEntityIRIs.forEach((iri, i) => existingLabelMap.set(existingLabels[i].toLowerCase(), iri));

    for (let i = 0; i < newEntityIRIs.length; i++) {
      const exactMatch = existingLabelMap.get(newLabels[i].toLowerCase());
      if (exactMatch && exactMatch !== newEntityIRIs[i]) {
        entityRemap.set(newEntityIRIs[i], exactMatch);
      }
    }

    // Embedding-based matching for remaining unmatched
    const unmatchedIndices = newEntityIRIs
      .map((iri, i) => entityRemap.has(iri) ? -1 : i)
      .filter(i => i >= 0);

    if (unmatchedIndices.length > 0) {
      const unmatchedLabels = unmatchedIndices.map(i => newLabels[i]);
      const [unmatchedVecs, existingVecs] = await Promise.all([
        embedMany(unmatchedLabels),
        embedMany(existingLabels),
      ]);

      for (let ui = 0; ui < unmatchedIndices.length; ui++) {
        const idx = unmatchedIndices[ui];
        let bestSim = 0;
        let bestIRI = '';

        for (let ei = 0; ei < existingEntityIRIs.length; ei++) {
          const sim = cosine(unmatchedVecs[ui], existingVecs[ei]);
          if (sim > bestSim) {
            bestSim = sim;
            bestIRI = existingEntityIRIs[ei];
          }
        }

        if (bestSim >= SUBJECT_MATCH_THRESHOLD && bestIRI !== newEntityIRIs[idx]) {
          entityRemap.set(newEntityIRIs[idx], bestIRI);
        }
      }
    }
  }

  // ── Embed and match predicates ─────────────────────────────────────────

  if (newPredicateIRIs.length > 0 && existingPredicateIRIs.length > 0) {
    const newPredLabels = newPredicateIRIs.map(labelFromIRI);
    const existingPredLabels = existingPredicateIRIs.map(labelFromIRI);

    // Quick exact-label check
    const existingPredLabelMap = new Map<string, string>();
    existingPredicateIRIs.forEach((iri, i) => existingPredLabelMap.set(existingPredLabels[i].toLowerCase(), iri));

    for (let i = 0; i < newPredicateIRIs.length; i++) {
      const exactMatch = existingPredLabelMap.get(newPredLabels[i].toLowerCase());
      if (exactMatch && exactMatch !== newPredicateIRIs[i]) {
        predicateRemap.set(newPredicateIRIs[i], exactMatch);
      }
    }

    // Embedding-based matching for remaining
    const unmatchedPredIndices = newPredicateIRIs
      .map((iri, i) => predicateRemap.has(iri) ? -1 : i)
      .filter(i => i >= 0);

    if (unmatchedPredIndices.length > 0) {
      const unmatchedPredLabels = unmatchedPredIndices.map(i => newPredLabels[i]);
      const [unmatchedPredVecs, existingPredVecs] = await Promise.all([
        embedMany(unmatchedPredLabels),
        embedMany(existingPredLabels),
      ]);

      for (let ui = 0; ui < unmatchedPredIndices.length; ui++) {
        const idx = unmatchedPredIndices[ui];
        let bestSim = 0;
        let bestIRI = '';

        for (let ei = 0; ei < existingPredicateIRIs.length; ei++) {
          const sim = cosine(unmatchedPredVecs[ui], existingPredVecs[ei]);
          if (sim > bestSim) {
            bestSim = sim;
            bestIRI = existingPredicateIRIs[ei];
          }
        }

        if (bestSim >= PREDICATE_MATCH_THRESHOLD && bestIRI !== newPredicateIRIs[idx]) {
          predicateRemap.set(newPredicateIRIs[idx], bestIRI);
        }
      }
    }
  }

  // ── Nothing to remap ───────────────────────────────────────────────────

  if (entityRemap.size === 0 && predicateRemap.size === 0) {
    return { statements: incoming, subjectRemaps: 0, predicateRemaps: 0, remaps: [] };
  }

  // ── Apply remaps ───────────────────────────────────────────────────────

  const remaps: NormalizeResult['remaps'] = [];

  for (const [from, to] of entityRemap) {
    remaps.push({ from, to, kind: 'subject', similarity: 0 }); // similarity filled below
  }
  for (const [from, to] of predicateRemap) {
    remaps.push({ from, to, kind: 'predicate', similarity: 0 });
  }

  const rewritten = incoming.map(st => {
    let changed = false;
    let newS = st.s;
    let newP = st.p;
    let newO = st.o;

    if (st.s.kind === 'iri' && entityRemap.has(st.s.value)) {
      newS = { kind: 'iri', value: entityRemap.get(st.s.value)! };
      changed = true;
    }

    if (predicateRemap.has(st.p.value)) {
      newP = { kind: 'iri', value: predicateRemap.get(st.p.value)! };
      changed = true;
    }

    if (st.o.kind === 'iri' && entityRemap.has(st.o.value)) {
      newO = { kind: 'iri', value: entityRemap.get(st.o.value)! };
      changed = true;
    }

    return changed ? { ...st, s: newS, p: newP, o: newO } : st;
  });

  const subjectRemaps = [...entityRemap.keys()].length;
  const predicateRemapCount = [...predicateRemap.keys()].length;

  return {
    statements: rewritten,
    subjectRemaps: subjectRemaps,
    predicateRemaps: predicateRemapCount,
    remaps,
  };
}
