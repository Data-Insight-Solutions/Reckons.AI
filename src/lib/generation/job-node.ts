import type { Source, Statement } from '$lib/rdf/types';
import { generationEntity, STAGE_LABELS, type GenerationJob, type GenerationRequest } from './protocol';

/**
 * F166.1.2: every local job is a Job node in the space that asked for it (Matt, 2026-10-23: "each
 * job should be a entity type node on the graph").
 *
 * A Job node is a RECORD of a request a person approved and of what the runner reported, never an
 * executable task. It carries no command and is not an AgentTask, so scripts/agent/runner.ts (which
 * refuses tasks read from the app) has nothing to pick up, and a graph shared with someone else
 * cannot make their machine run anything.
 *
 * Rows are written confirmed: the person approved this request, and its state comes from a receipt
 * the browser verified. What the job PRODUCED is a different matter; generated assets stay pending
 * (attach.ts).
 */
export const JOB_TYPE = 'urn:kbase:type/Job';
export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobOrigin = 'story' | 'shelly';

const P = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
export const JOB_PREDICATES = {
  stage: `${P}job-stage`,
  state: `${P}job-state`,
  error: `${P}job-error`,
  waitsFor: `${P}waits-for`,
  produced: `${P}produced`,
  requestedBy: `${P}requested-by`,
  queuedAt: `${P}queued-at`,
  seed: `${P}generated-seed`,
} as const;

export const jobEntity = (id: string) => `urn:kbase:concept/job-${id}`;
export const jobSourceId = (id: string) => `job-${id}`;
/** The one row that changes as the job moves; every other row is written once. */
export const jobStateRowId = (id: string) => `${jobSourceId(id)}-state`;

export function jobSource(request: GenerationRequest, queuedAt: number): Source {
  return {
    id: jobSourceId(request.id), title: `${STAGE_LABELS[request.stage]} job: ${request.prompt.slice(0, 80)}`,
    uri: `note://generation/job/${request.id}`, kind: 'note', ingestedAt: queuedAt,
  };
}

/**
 * The rows for one job at its current state. Ids are stable, so persisting this again after a state
 * change adds only the rows that are new (an error, the produced edge) and never duplicates one.
 */
export function jobStatements(request: GenerationRequest, origin: JobOrigin, queuedAt: number, job?: GenerationJob): Statement[] {
  const entity = jobEntity(request.id);
  const sourceId = jobSourceId(request.id);
  const rows: Statement[] = [];
  const add = (key: string, predicate: string, value: string, iri = false) => {
    rows.push({
      id: `${sourceId}-${key}`, s: { kind: 'iri', value: entity }, p: { kind: 'iri', value: predicate },
      o: { kind: iri ? 'iri' : 'literal', value }, g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
      sourceId, status: 'confirmed', confidence: 1, createdAt: queuedAt, updatedAt: queuedAt,
    });
  };
  add('type', RDF_TYPE, JOB_TYPE, true);
  add('label', LABEL, `${STAGE_LABELS[request.stage]} job: ${request.prompt.slice(0, 60)}`);
  add('prompt', COMMENT, request.prompt);
  add('stage', JOB_PREDICATES.stage, request.stage);
  add('seed', JOB_PREDICATES.seed, String(request.seed));
  add('requested-by', JOB_PREDICATES.requestedBy, origin === 'shelly' ? 'Shelly, approved by you' : 'Generated assets story');
  add('queued-at', JOB_PREDICATES.queuedAt, new Date(queuedAt).toISOString());
  if (request.parentId) add('waits-for', JOB_PREDICATES.waitsFor, jobEntity(request.parentId), true);
  add('state', JOB_PREDICATES.state, job?.state ?? 'queued');
  if (job?.state === 'failed') add('error', JOB_PREDICATES.error, (job.error || 'The runner did not produce a checked result.').slice(0, 500));
  return rows;
}

/** The edge from a job to the asset it made, written only after the asset is attached. */
export function producedStatement(request: GenerationRequest, attachedAt: number): Statement {
  const sourceId = jobSourceId(request.id);
  return {
    id: `${sourceId}-produced`, s: { kind: 'iri', value: jobEntity(request.id) },
    p: { kind: 'iri', value: JOB_PREDICATES.produced }, o: { kind: 'iri', value: generationEntity(request.id) },
    g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
    sourceId, status: 'confirmed', confidence: 1, createdAt: attachedAt, updatedAt: attachedAt,
  };
}
