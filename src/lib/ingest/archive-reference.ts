/**
 * F97.3 ingest boundary: detect archived identities after normalization and before persistence.
 *
 * The pure matcher and crash-safe restore primitive live elsewhere. This module owns only the
 * orchestration contract: ask the globally mounted consent UI, fail closed when it is unavailable,
 * restore every selected entity, refresh the reactive store, and return the incoming batch with
 * exact label-collision IRIs remapped to the restored identities.
 */

import {
  findArchivedReferencesForParent,
  restoreArchivedEntityForParent,
} from '$lib/storage/archive-store';
import { getCurrentKbId, getRegistry } from '$lib/storage/kb-registry';
import { loadAll } from '$lib/stores/kb.svelte';
import {
  requestArchiveDecision,
  type ArchiveReferenceDecision,
  type ArchiveReferenceDecisionRequest,
} from '$lib/stores/archive-decision.svelte';
import {
  remapIncomingForArchivedRestores,
  type ArchivedReference,
} from '$lib/rdf/archive';
import type { Statement } from '$lib/rdf/types';

export type ArchiveReferencePhase = 'checking' | 'awaiting-decision' | 'restoring';

export interface ArchiveReferenceResolution {
  decision: ArchiveReferenceDecision | 'none';
  statements: Statement[];
  references: ArchivedReference[];
  restoredEntities: string[];
}

interface ArchiveContext {
  workingKbId: string;
  parentStableId: string;
}

/** Dependency seam for deterministic orchestration tests. Production callers use the defaults. */
export interface ArchiveReferenceDependencies {
  currentContext: () => ArchiveContext | null;
  findReferences: typeof findArchivedReferencesForParent;
  decide: (request: ArchiveReferenceDecisionRequest) => Promise<ArchiveReferenceDecision>;
  restore: typeof restoreArchivedEntityForParent;
  reloadWorkingStore: () => Promise<void>;
}

const defaultDependencies: ArchiveReferenceDependencies = {
  currentContext: () => {
    const workingKbId = getCurrentKbId();
    const entry = getRegistry().find((candidate) => candidate.id === workingKbId);
    return entry?.stableId
      ? { workingKbId, parentStableId: entry.stableId }
      : null;
  },
  findReferences: findArchivedReferencesForParent,
  decide: requestArchiveDecision,
  restore: restoreArchivedEntityForParent,
  reloadWorkingStore: loadAll,
};

// Serialise the WHOLE archive decision boundary, not only the visible dialogs. Advancing the FIFO
// prompt as soon as a user clicks "restore" would otherwise let a second ingest read archive state
// while the first is still between its prepared journal row, working copy, and final commit.
let archiveResolutionTail: Promise<void> = Promise.resolve();

export function resolveArchiveReferencesForIngest(
  input: {
    sourceTitle: string;
    statements: Statement[];
    onPhase?: (phase: ArchiveReferencePhase) => void;
  },
  dependencies: ArchiveReferenceDependencies = defaultDependencies,
): Promise<ArchiveReferenceResolution> {
  const resolution = archiveResolutionTail.then(
    () => resolveArchiveReferencesForIngestSerial(input, dependencies),
  );
  archiveResolutionTail = resolution.then(
    () => undefined,
    () => undefined,
  );
  return resolution;
}

async function resolveArchiveReferencesForIngestSerial(
  input: {
    sourceTitle: string;
    statements: Statement[];
    onPhase?: (phase: ArchiveReferencePhase) => void;
  },
  dependencies: ArchiveReferenceDependencies,
): Promise<ArchiveReferenceResolution> {
  input.onPhase?.('checking');
  const context = dependencies.currentContext();
  if (!context) {
    return {
      decision: 'none',
      statements: input.statements,
      references: [],
      restoredEntities: [],
    };
  }

  const references = await dependencies.findReferences(
    context.parentStableId,
    input.statements,
  );
  if (references.length === 0) {
    return {
      decision: 'none',
      statements: input.statements,
      references,
      restoredEntities: [],
    };
  }

  input.onPhase?.('awaiting-decision');
  const decision = await dependencies.decide({
    sourceTitle: input.sourceTitle,
    references,
  });
  if (decision !== 'restore') {
    return {
      decision,
      statements: input.statements,
      references,
      restoredEntities: [],
    };
  }

  // Validate and compute every identity rewrite BEFORE the first restore mutates either database.
  const remapped = remapIncomingForArchivedRestores(input.statements, references);
  const entities = [...new Set(references.map((reference) => reference.entity))].sort();
  input.onPhase?.('restoring');

  let attemptedRestore = false;
  try {
    for (const entity of entities) {
      attemptedRestore = true;
      await dependencies.restore({
        workingKbId: context.workingKbId,
        parentStableId: context.parentStableId,
        entity,
        actor: 'human',
        note: `Restored because ingest "${input.sourceTitle}" referenced this archived entity`,
      });
    }
  } finally {
    // A restore can fail after its working-DB copy but before final journal commit. Reload after any
    // attempt, including a rejected promise, so reactive state never lies about persisted state.
    if (attemptedRestore) await dependencies.reloadWorkingStore();
  }

  return {
    decision,
    statements: remapped,
    references,
    restoredEntities: entities,
  };
}
