/**
 * THE ROW CONTRACT (F89.4.1) — what every row written to the review queue must say.
 *
 * A machine row names the SPACE it is for (`kb`), the RUN that made it (`run`, the id of the JobRun
 * job-watch mints and hands the job as RECKONS_RUN_ID), its `agent`, its `model` when it used one,
 * its LANE (claim, question or finding: F89.4.3) and when it was added (`addedAt`). Without a run,
 * "group the queue by producer run" is a guess from a name and a UTC day, and 474 of 1,934 rows on
 * 2026-11-10 could not even be guessed. A person's own note (a chat, the app, a phone shortcut)
 * needs only its space.
 *
 * One function, `stampRow`, fills what can be known and refuses what cannot, naming the field.
 * It is pure (no filesystem, no clock unless passed) so scripts/offline/pending-queue.ts, the MCP
 * server and queue-integrity all apply ONE rule. It is deliberately dependency-free: the MCP
 * package is distributed without the application source.
 *
 * It NEVER guesses `kb` or `run`. A guessed space is the failure it exists to stop (the 2026-11-10
 * scan rows that named no space), and a guessed run would be a made-up provenance claim.
 */
import { isLane, laneOf, type Lane } from './review-lane.js';

/** Rows dated at or after this instant must satisfy the contract; earlier ones are LEGACY (report only). */
export const CONTRACT_STARTS = '2026-11-11T00:00:00.000Z';

export type RowOrigin = 'job' | 'note';

export class RowContractError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'RowContractError';
  }
}

export interface StampContext {
  /** 'job' = a machine row (default); 'note' = a person's own note, which needs only its space. */
  origin?: RowOrigin;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  /** Declared lane per job name (static/reckons-jobs.ttl kpred:emits); see review-lane.ts. */
  jobLanes?: ReadonlyMap<string, Lane>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The field a row is missing under the contract for `origin`, or undefined when it conforms. */
export function missingField(row: Record<string, unknown>, origin: RowOrigin): string | undefined {
  if (!text(row.kb)) return 'kb';
  if (origin === 'note') return undefined;
  if (!text(row.run) && !text(row.runId)) return 'run';
  if (!isLane(row.lane)) return 'lane';
  return undefined;
}

/**
 * Return `row` with the contract's fields stamped, or throw a RowContractError naming the field.
 * Stamps: addedAt (now), agent and model (from RECKONS_JOB_NAME / RECKONS_JOB_MODEL when the row
 * leaves them out), run (from RECKONS_RUN_ID), lane (the router's answer), origin.
 */
export function stampRow<T extends Record<string, unknown>>(row: T, ctx: StampContext = {}): T & Record<string, unknown> {
  const origin = ctx.origin ?? 'job';
  const env = ctx.env ?? (typeof process !== 'undefined' ? process.env : {});
  const out: Record<string, unknown> = { ...row };
  if (!text(out.addedAt)) out.addedAt = (ctx.now ?? new Date()).toISOString();
  out.origin = origin;

  if (origin === 'job') {
    if (!text(out.run) && !text(out.runId) && text(env.RECKONS_RUN_ID)) out.run = text(env.RECKONS_RUN_ID);
    if (!text(out.agent) && text(env.RECKONS_JOB_NAME)) out.agent = text(env.RECKONS_JOB_NAME);
    if (!text(out.model) && text(env.RECKONS_JOB_MODEL)) out.model = text(env.RECKONS_JOB_MODEL);
    if (out.lane !== undefined && !isLane(out.lane)) {
      throw new RowContractError('lane', `row refused: lane "${String(out.lane)}" is not claim, question or finding`);
    }
    if (out.lane === undefined) out.lane = laneOf(out as never, ctx.jobLanes);
  }

  const missing = missingField(out, origin);
  if (missing) {
    const hint = missing === 'run'
      ? ' (run the job through the queue worker so job-watch sets RECKONS_RUN_ID, or set it for a hand run)'
      : missing === 'kb' ? ' (a row must name the space it is for; it is never guessed)' : '';
    throw new RowContractError(missing, `row refused: missing ${missing} on ${origin === 'job' ? 'a machine row' : 'a note'} about "${text(out.subject) || '?'}"${hint}`);
  }
  return out as T & Record<string, unknown>;
}

export interface ContractReport {
  rows: number;
  /** Rows dated before CONTRACT_STARTS (or undated): reported per missing field, never failed. */
  legacy: number;
  legacyMissing: Record<string, number>;
  /** Rows dated at or after CONTRACT_STARTS that break the contract. */
  violations: { index: number; field: string }[];
}

const FIELDS = ['kb', 'run', 'agent', 'model', 'lane', 'addedAt'] as const;

/**
 * Audit parsed rows. A legacy row's missing fields are COUNTED per field (a note needs only kb, so
 * for rows that do not say they are notes this is every field a machine row would owe). A row after
 * the contract must carry `origin` (proof it passed through stampRow) and satisfy missingField.
 */
export function auditRows(rows: { index: number; row: Record<string, unknown> }[]): ContractReport {
  const report: ContractReport = { rows: rows.length, legacy: 0, legacyMissing: Object.fromEntries(FIELDS.map((f) => [f, 0])), violations: [] };
  for (const { index, row } of rows) {
    const at = Date.parse(text(row.addedAt));
    if (!Number.isFinite(at) || at < Date.parse(CONTRACT_STARTS)) {
      report.legacy++;
      for (const f of FIELDS) {
        const present = f === 'run' ? text(row.run) || text(row.runId) : text(row[f]);
        if (!present) report.legacyMissing[f]++;
      }
      continue;
    }
    if (row.origin !== 'job' && row.origin !== 'note') { report.violations.push({ index, field: 'origin' }); continue; }
    const m = missingField(row, row.origin);
    if (m) report.violations.push({ index, field: m });
  }
  return report;
}
