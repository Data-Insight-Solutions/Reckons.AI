/**
 * Changelog, merge decisions, and trust event types for traceable knowledge base.
 * These types are used in Dexie v2 to record all mutations and user actions.
 */

export interface ChangeLogEntry {
  /** Auto-incrementing primary key */
  id?: number;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Type of action */
  action:
    | 'add'           // New statement added
    | 'confirm'       // Statement status changed to 'confirmed'
    | 'reject'        // Statement status changed to 'rejected'
    | 'supersede'     // Statement superseded by another
    | 'delete'        // Statement deleted
    | 'merge'         // Entities merged
    | 'trust_update'  // Source trust level changed
    | 'ingest';       // Bulk ingest from source
  /** Reference to affected statement (if applicable) */
  statementId?: string;
  /** Reference to affected source */
  sourceId?: string;
  /** Entity key affected (for merges, trust updates) */
  entityKey?: string;
  /** JSON snapshot of state before change */
  before?: string;
  /** JSON snapshot of state after change */
  after?: string;
  /** Human-readable note for the action */
  note?: string;
}

export interface MergeDecision {
  /** Auto-incrementing primary key */
  id?: number;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** First entity being considered for merge */
  entityKeyA: string;
  /** Second entity being considered for merge */
  entityKeyB: string;
  /** User's decision */
  decision: 'keep_a' | 'keep_b' | 'cancelled';
  /** AI recommendation text (from Claude) */
  aiRecommendation?: string;
  /** Whether user accepted the AI recommendation */
  acceptedAI: boolean;
  /** Statement count before merge */
  statementCountA: number;
  statementCountB: number;
  /** Count of statements from trusted sources */
  trustedCountA: number;
  trustedCountB: number;
}

export interface TrustEvent {
  /** Auto-incrementing primary key */
  id?: number;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Source that trust was updated for */
  sourceId: string;
  /** Change in trust score (typically ±0.05 to ±0.1) */
  delta: number;
  /** Reason for the change */
  reason:
    | 'confirm'        // User confirmed a statement from this source
    | 'reject'         // User rejected a statement from this source
    | 'corroboration'  // Statement corroborated by another source
    | 'time_decay';    // Periodic trust decay (not updated recently)
  /** Optional reference to the statement that triggered this event */
  statementId?: string;
}
