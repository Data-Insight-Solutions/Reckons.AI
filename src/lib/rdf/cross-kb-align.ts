/**
 * Cross-KB alignment engine.
 *
 * Reads statements from foreign KBs via temporary Dexie instances,
 * matches entities across KBs by IRI and label similarity, then
 * produces alignment suggestions using the existing diff engine.
 */

import { v4 as uuid } from 'uuid';
import { KBaseDB } from '$lib/storage/db';
import { computeDiff, type DiffEntry } from './diff';
import { labelFromIRI } from './semantic-diff';
import type { Statement } from './types';
import { termKey } from './types';

// ── Types ───────────────────────────────────────────────────────────────────

export type AlignedEntity = {
  activeIri: string;
  foreignIri: string;
  matchType: 'exact-iri' | 'label-similarity';
  similarity: number;
  activeLabel: string;
  foreignLabel: string;
};

export type AlignmentSuggestion = {
  id: string;
  kind: 'add' | 'conflict' | 'reinforce' | 'refine';
  diffEntry?: DiffEntry;
  sourceKbId: string;
  sourceKbName: string;
  targetKbId: string;
  targetKbName: string;
  statement: Statement;
  entityMatch?: AlignedEntity;
  decision: 'pending' | 'accepted' | 'rejected';
};

export type AlignmentResult = {
  suggestions: AlignmentSuggestion[];
  alignedEntities: AlignedEntity[];
  summary: {
    additions: number;
    conflicts: number;
    reinforcements: number;
    refinements: number;
  };
};

// ── Constants ───────────────────────────────────────────────────────────────

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KPRED_NAME = 'urn:kbase:predicate/name';
const LABEL_SIM_THRESHOLD = 0.85;
const MAX_EMBED_ENTITIES = 400;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Open a foreign KB, read its confirmed statements, then close. */
export async function loadKbStatements(kbId: string): Promise<Statement[]> {
  const tempDb = new KBaseDB(kbId);
  try {
    const all = await tempDb.statements.toArray();
    return all.filter(
      s => s.status === 'confirmed' || s.status === 'refined'
    );
  } finally {
    tempDb.close();
  }
}

/** Build a label map from statements (IRI → human-readable label). */
function buildLabelMap(statements: Statement[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const st of statements) {
    if ((st.p.value === RDFS_LABEL || st.p.value === KPRED_NAME) && st.o.kind === 'literal') {
      labels.set(st.s.value, st.o.value);
    }
  }
  return labels;
}

/** Collect unique entity IRIs from statements. */
function collectEntities(statements: Statement[]): Set<string> {
  const entities = new Set<string>();
  for (const st of statements) {
    if (st.s.kind === 'iri') entities.add(st.s.value);
    if (st.o.kind === 'iri') entities.add(st.o.value);
  }
  return entities;
}

// ── Entity matching ─────────────────────────────────────────────────────────

async function matchEntities(
  activeStatements: Statement[],
  foreignStatements: Statement[],
  threshold = LABEL_SIM_THRESHOLD,
): Promise<AlignedEntity[]> {
  const activeLabels = buildLabelMap(activeStatements);
  const foreignLabels = buildLabelMap(foreignStatements);
  const activeEntities = collectEntities(activeStatements);
  const foreignEntities = collectEntities(foreignStatements);

  const aligned: AlignedEntity[] = [];
  const matchedForeign = new Set<string>();
  const matchedActive = new Set<string>();

  // Pass 1: exact IRI matches
  for (const iri of foreignEntities) {
    if (activeEntities.has(iri)) {
      aligned.push({
        activeIri: iri,
        foreignIri: iri,
        matchType: 'exact-iri',
        similarity: 1.0,
        activeLabel: activeLabels.get(iri) || labelFromIRI(iri),
        foreignLabel: foreignLabels.get(iri) || labelFromIRI(iri),
      });
      matchedForeign.add(iri);
      matchedActive.add(iri);
    }
  }

  // Pass 2: label similarity for unmatched entities
  const unmatchedActive = [...activeEntities].filter(e => !matchedActive.has(e));
  const unmatchedForeign = [...foreignEntities].filter(e => !matchedForeign.has(e));

  if (unmatchedActive.length > 0 && unmatchedForeign.length > 0) {
    // Cap to prevent excessive embedding computation
    const cappedActive = unmatchedActive.slice(0, MAX_EMBED_ENTITIES);
    const cappedForeign = unmatchedForeign.slice(0, MAX_EMBED_ENTITIES);

    try {
      const { embedMany, cosine } = await import('$lib/embed');
      const activeTexts = cappedActive.map(e => activeLabels.get(e) || labelFromIRI(e));
      const foreignTexts = cappedForeign.map(e => foreignLabels.get(e) || labelFromIRI(e));

      const [activeVecs, foreignVecs] = await Promise.all([
        embedMany(activeTexts),
        embedMany(foreignTexts),
      ]);

      // Find best match for each foreign entity
      for (let fi = 0; fi < cappedForeign.length; fi++) {
        let bestIdx = -1;
        let bestSim = 0;
        for (let ai = 0; ai < cappedActive.length; ai++) {
          const sim = cosine(foreignVecs[fi], activeVecs[ai]);
          if (sim > bestSim && sim >= threshold) {
            bestSim = sim;
            bestIdx = ai;
          }
        }
        if (bestIdx >= 0) {
          aligned.push({
            activeIri: cappedActive[bestIdx],
            foreignIri: cappedForeign[fi],
            matchType: 'label-similarity',
            similarity: bestSim,
            activeLabel: activeLabels.get(cappedActive[bestIdx]) || labelFromIRI(cappedActive[bestIdx]),
            foreignLabel: foreignLabels.get(cappedForeign[fi]) || labelFromIRI(cappedForeign[fi]),
          });
        }
      }
    } catch (e) {
      console.warn('[cross-kb-align] Embedding failed, using exact IRI matches only:', e);
    }
  }

  return aligned.sort((a, b) => b.similarity - a.similarity);
}

// ── Alignment computation ───────────────────────────────────────────────────

/** Remap foreign statement IRIs to active KB IRIs using entity alignment. */
function remapStatement(st: Statement, iriMap: Map<string, string>): Statement {
  const newS = st.s.kind === 'iri' && iriMap.has(st.s.value)
    ? { ...st.s, value: iriMap.get(st.s.value)! }
    : st.s;
  const newO = st.o.kind === 'iri' && iriMap.has(st.o.value)
    ? { ...st.o, value: iriMap.get(st.o.value)! }
    : st.o;
  return { ...st, s: newS, o: newO };
}

function diffKindToAlignKind(diffKind: DiffEntry['kind']): AlignmentSuggestion['kind'] {
  switch (diffKind) {
    case 'new': return 'add';
    case 'near-duplicate': return 'add';
    case 'conflicts': return 'conflict';
    case 'antonym-conflicts': return 'conflict';
    case 'reinforces': return 'reinforce';
    case 'synonym-reinforces': return 'reinforce';
    case 'refines': return 'refine';
    case 'duplicate': return 'reinforce';
    default: return 'add';
  }
}

export async function computeAlignment(
  activeKbId: string,
  activeStatements: Statement[],
  foreignKbId: string,
  foreignKbName: string,
  foreignStatements: Statement[],
  activeKbName: string,
): Promise<AlignmentResult> {
  // Match entities across KBs
  const alignedEntities = await matchEntities(activeStatements, foreignStatements);

  // Build IRI remapping (foreign → active)
  const iriMap = new Map<string, string>();
  for (const ae of alignedEntities) {
    if (ae.foreignIri !== ae.activeIri) {
      iriMap.set(ae.foreignIri, ae.activeIri);
    }
  }

  // Remap foreign statements and diff against active
  const remapped = foreignStatements.map(st => remapStatement(st, iriMap));
  const diff = computeDiff(remapped, activeStatements);

  // Convert to alignment suggestions
  const suggestions: AlignmentSuggestion[] = [];
  const summary = { additions: 0, conflicts: 0, reinforcements: 0, refinements: 0 };

  // Track seen triple keys to deduplicate
  const seen = new Set<string>();

  for (const entry of diff.entries) {
    // Skip duplicates — they're already in both KBs
    if (entry.kind === 'duplicate') continue;

    const tripleStr = `${termKey(entry.incoming.s)}|${termKey(entry.incoming.p)}|${termKey(entry.incoming.o)}`;
    if (seen.has(tripleStr)) continue;
    seen.add(tripleStr);

    const kind = diffKindToAlignKind(entry.kind);

    // Find entity match context for this statement
    const entityMatch = alignedEntities.find(
      ae => ae.foreignIri === entry.incoming.s.value ||
            ae.foreignIri === entry.incoming.o.value ||
            ae.activeIri === entry.incoming.s.value ||
            ae.activeIri === entry.incoming.o.value
    );

    suggestions.push({
      id: uuid(),
      kind,
      diffEntry: entry,
      sourceKbId: foreignKbId,
      sourceKbName: foreignKbName,
      targetKbId: activeKbId,
      targetKbName: activeKbName,
      statement: entry.incoming,
      entityMatch: entityMatch?.matchType === 'label-similarity' ? entityMatch : undefined,
      decision: 'pending',
    });

    switch (kind) {
      case 'add': summary.additions++; break;
      case 'conflict': summary.conflicts++; break;
      case 'reinforce': summary.reinforcements++; break;
      case 'refine': summary.refinements++; break;
    }
  }

  return { suggestions, alignedEntities, summary };
}

// ── Apply suggestions ───────────────────────────────────────────────────────

export async function applyAlignmentToActiveKb(
  suggestion: AlignmentSuggestion,
  addStatements: (sts: Statement[], sourceId: string) => Promise<void>,
  addSource: (src: any) => Promise<void>,
): Promise<void> {
  const now = Date.now();
  const sourceId = `align-${suggestion.sourceKbId}-${now}`;

  await addSource({
    id: sourceId,
    title: `Aligned from ${suggestion.sourceKbName}`,
    uri: `urn:align:${suggestion.sourceKbId}`,
    kind: 'analysis' as const,
    trustLevel: 'review' as const,
    ingestedAt: now,
  });

  const st: Statement = {
    ...suggestion.statement,
    id: uuid(),
    sourceId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  await addStatements([st], sourceId);
}
