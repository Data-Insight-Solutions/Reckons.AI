/**
 * Shared F97.3 boundary for ingest modes that already have RDF statements.
 *
 * These callers skip the extraction pipeline, but they must not skip entity normalisation,
 * archived-reference consent, or the no-write cancellation guarantee.
 */

import { normalizeEntities } from '$lib/rdf/normalize-entities';
import type { Source, Statement } from '$lib/rdf/types';
import { addSource, addStatements, statements as allStatements } from '$lib/stores/kb.svelte';
import {
  resolveArchiveReferencesForIngest,
  type ArchiveReferenceResolution,
} from './archive-reference';

export type PrecomputedIngestResult =
  | {
      phase: 'done';
      decision: Exclude<ArchiveReferenceResolution['decision'], 'cancel'>;
      statements: Statement[];
    }
  | {
      phase: 'cancelled';
      reason: 'archive-reference';
    };

export interface PrecomputedIngestDependencies {
  currentStatements: () => Statement[];
  normalize: typeof normalizeEntities;
  resolveArchiveReferences: typeof resolveArchiveReferencesForIngest;
  persistSource: typeof addSource;
  persistStatements: typeof addStatements;
}

const defaultDependencies: PrecomputedIngestDependencies = {
  currentStatements: allStatements,
  normalize: normalizeEntities,
  resolveArchiveReferences: resolveArchiveReferencesForIngest,
  persistSource: addSource,
  persistStatements: addStatements,
};

let precomputedIngestTail: Promise<void> = Promise.resolve();

/**
 * Normalise, resolve archived identities, and persist one precomputed ingest batch.
 *
 * The whole command is serialised through the final statement write. A second precomputed batch
 * therefore normalises against the first batch's committed reactive state instead of a stale
 * snapshot. A source is optional because Google Calendar statements already refer to previously
 * registered calendar sources.
 */
export function commitPrecomputedIngest(
  input: {
    sourceTitle: string;
    statements: Statement[];
    source?: Source;
  },
  dependencies: PrecomputedIngestDependencies = defaultDependencies,
): Promise<PrecomputedIngestResult> {
  const commit = precomputedIngestTail.then(
    () => commitPrecomputedIngestSerial(input, dependencies),
  );
  precomputedIngestTail = commit.then(
    () => undefined,
    () => undefined,
  );
  return commit;
}

async function commitPrecomputedIngestSerial(
  input: {
    sourceTitle: string;
    statements: Statement[];
    source?: Source;
  },
  dependencies: PrecomputedIngestDependencies,
): Promise<PrecomputedIngestResult> {
  const normalized = await dependencies.normalize(
    input.statements,
    dependencies.currentStatements(),
  );
  const archiveResolution = await dependencies.resolveArchiveReferences({
    sourceTitle: input.sourceTitle,
    statements: normalized.statements,
  });

  if (archiveResolution.decision === 'cancel') {
    return {
      phase: 'cancelled',
      reason: 'archive-reference',
    };
  }

  if (input.source) await dependencies.persistSource(input.source);
  await dependencies.persistStatements(
    archiveResolution.statements,
    input.source?.id,
  );

  return {
    phase: 'done',
    decision: archiveResolution.decision,
    statements: archiveResolution.statements,
  };
}
