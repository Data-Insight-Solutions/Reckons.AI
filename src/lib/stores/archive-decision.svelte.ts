/**
 * Explicit consent gate for F97.3 restore-on-reference.
 *
 * Ingest can begin from the form, source refresh, Shelly, the extension bridge, or a vault batch.
 * They all use one FIFO decision queue so concurrent requests cannot overwrite a resolver and hang
 * forever. The dialog registers its lifetime explicitly: if no UI is mounted, a matching ingest
 * fails closed instead of silently keeping a duplicate or waiting on a promise nobody can settle.
 */

import type { ArchivedReference } from '$lib/rdf/archive';

export type ArchiveReferenceDecision = 'restore' | 'keep-new' | 'cancel';

export interface ArchiveReferenceDecisionRequest {
  sourceTitle: string;
  references: ArchivedReference[];
}

interface PendingArchiveDecision extends ArchiveReferenceDecisionRequest {
  resolve: (decision: ArchiveReferenceDecision) => void;
}

export class ArchiveDecisionUnavailableError extends Error {}

let _queue = $state<PendingArchiveDecision[]>([]);
let _mountCount = 0;

export function pendingArchiveDecision(): PendingArchiveDecision | null {
  return _queue[0] ?? null;
}

export function requestArchiveDecision(
  request: ArchiveReferenceDecisionRequest,
): Promise<ArchiveReferenceDecision> {
  if (_mountCount <= 0) {
    throw new ArchiveDecisionUnavailableError(
      'Archived entities were found, but the restore decision dialog is unavailable. Ingest was not saved.',
    );
  }
  return new Promise((resolve) => {
    _queue = [..._queue, { ...request, resolve }];
  });
}

export function resolveArchiveDecision(decision: ArchiveReferenceDecision): void {
  const current = _queue[0];
  if (!current) return;
  _queue = _queue.slice(1);
  current.resolve(decision);
}

/**
 * Register the global dialog and return its teardown.
 *
 * If the last dialog unmounts, every queued request resolves as cancel. A route transition or
 * component failure therefore cannot strand an ingest promise.
 */
export function mountArchiveDecisionDialog(): () => void {
  _mountCount += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    _mountCount = Math.max(0, _mountCount - 1);
    if (_mountCount > 0) return;

    const abandoned = _queue;
    _queue = [];
    for (const request of abandoned) request.resolve('cancel');
  };
}
