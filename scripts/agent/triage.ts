/**
 * Triage classifier — re-exported from the app layer.
 *
 * The classifier is shared DOMAIN logic (the pending queue is graph data), so it lives in
 * src/lib/rdf/triage.ts where both the app (review-mode prune, etc.) and this tooling can reach
 * it without src/ ever depending on scripts/. This shim keeps the agent scripts' import paths
 * (`./triage.js`) stable. See src/lib/rdf/triage.ts for the implementation and rationale.
 */
export * from '../../src/lib/rdf/triage.js';
export type { PendingItem, TriageKind, Remedy } from '../../src/lib/rdf/triage.js';
