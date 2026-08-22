import { v4 as uuid } from 'uuid';
import type {
  ExtractionLocality,
  ExtractionRouteAttempt,
  ExtractionRun,
  ExtractionStageName,
  ExtractionStageStatus,
} from '../rdf/types';

export const EXTRACTION_RUN_STAGES: readonly ExtractionStageName[] = [
  'route', 'extract', 'validate', 'ground', 'normalize', 'archive', 'diff', 'persist',
];

export type CreateExtractionRunInput = {
  id?: string;
  sourceId: string;
  sourceHash: string;
  backend: string;
  model: string;
  locality: ExtractionLocality;
  reason: string;
  pipelineVersion?: string;
  promptId?: string;
  schemaId?: string;
  startedAt?: number;
};

const stages = () => EXTRACTION_RUN_STAGES.map((name) => ({ name, status: 'pending' as const }));

/** Create a metadata-only record. Source bytes, prompts, model responses and keys never enter it. */
export function createExtractionRun(input: CreateExtractionRunInput): ExtractionRun {
  const startedAt = input.startedAt ?? Date.now();
  const target = { backend: input.backend, model: input.model, locality: input.locality };
  return {
    id: input.id ?? uuid(),
    sourceId: input.sourceId,
    sourceHash: input.sourceHash,
    pipelineVersion: input.pipelineVersion ?? 'ingest-v1',
    promptId: input.promptId ?? 'triple-extraction-v1',
    ...(input.schemaId ? { schemaId: input.schemaId } : {}),
    startedAt,
    status: 'running',
    route: {
      policyVersion: 'configured-ingest-backend-v1',
      selectedBackend: input.backend,
      selectedModel: input.model,
      locality: input.locality,
      reason: input.reason,
      candidates: [target],
      attempts: [],
    },
    stages: stages(),
    outputStatementIds: [],
  };
}

function updateStage(
  run: ExtractionRun,
  name: ExtractionStageName,
  status: ExtractionStageStatus,
  now: number,
  detail?: string,
): ExtractionRun {
  return {
    ...run,
    stages: run.stages.map((stage) => stage.name !== name ? stage : {
      ...stage,
      status,
      ...(status === 'running' ? { startedAt: now } : { startedAt: stage.startedAt ?? now, endedAt: now }),
      ...(detail ? { detail } : {}),
    }),
  };
}

export function startExtractionStage(run: ExtractionRun, name: ExtractionStageName, now = Date.now()): ExtractionRun {
  return updateStage(run, name, 'running', now);
}

export function finishExtractionStage(
  run: ExtractionRun,
  name: ExtractionStageName,
  status: Extract<ExtractionStageStatus, 'succeeded' | 'skipped'> = 'succeeded',
  detail?: string,
  now = Date.now(),
): ExtractionRun {
  return updateStage(run, name, status, now, detail);
}

function appendExtractionAttempt(
  run: ExtractionRun,
  target: { backend: string; model: string; locality: ExtractionLocality },
  now: number,
): ExtractionRun {
  const attempt: ExtractionRouteAttempt = {
    id: `attempt-${run.route.attempts.length + 1}`,
    ...target,
    startedAt: now,
    status: 'running',
  };
  return { ...run, route: { ...run.route, attempts: [...run.route.attempts, attempt] } };
}

export function startExtractionAttempt(run: ExtractionRun, now = Date.now()): ExtractionRun {
  return appendExtractionAttempt(run, {
    backend: run.route.selectedBackend,
    model: run.route.selectedModel,
    locality: run.route.locality,
  }, now);
}

/** Record an existing fallback exactly as it happened; this does not select or enable a new one. */
export function startExtractionFallbackAttempt(
  run: ExtractionRun,
  target: { backend: string; model: string; locality: ExtractionLocality },
  now = Date.now(),
): ExtractionRun {
  return appendExtractionAttempt(run, target, now);
}

export function finishExtractionAttempt(
  run: ExtractionRun,
  status: Extract<ExtractionRouteAttempt['status'], 'succeeded' | 'failed' | 'skipped'>,
  error?: string,
  now = Date.now(),
): ExtractionRun {
  let found = false;
  const attempts = run.route.attempts.map((attempt) => {
    if (found || attempt.status !== 'running') return attempt;
    found = true;
    return { ...attempt, status, endedAt: now, ...(error ? { error } : {}) };
  });
  return { ...run, route: { ...run.route, attempts } };
}

export function recordExtractionOutput(
  run: ExtractionRun,
  statementIds: string[],
  validationCounts: ExtractionRun['validationCounts'],
): ExtractionRun {
  return { ...run, outputStatementIds: statementIds, validationCounts };
}

export function failExtractionRun(
  run: ExtractionRun,
  stage: ExtractionStageName,
  error: unknown,
  now = Date.now(),
): ExtractionRun {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...updateStage(run, stage, 'failed', now, message),
    status: 'failed',
    endedAt: now,
    failure: { stage, message, at: now },
  };
}

export function cancelExtractionRun(run: ExtractionRun, stage: ExtractionStageName, detail: string, now = Date.now()): ExtractionRun {
  return {
    ...finishExtractionStage(run, stage, 'skipped', detail, now),
    status: 'cancelled',
    endedAt: now,
  };
}

export function completeExtractionRun(run: ExtractionRun, now = Date.now()): ExtractionRun {
  return { ...run, status: 'succeeded', endedAt: now };
}

/** Map existing provider names to the data-locality boundary the user needs to see. */
export function extractionLocalityForBackend(backend: string): ExtractionLocality {
  if (backend === 'ollama') return 'local-network';
  if (backend === 'wasm' || backend === 'chrome-ai' || backend === 'mock') return 'browser';
  if (backend === 'manual') return 'manual';
  if (backend === 'claude' || backend === 'openai' || backend === 'gemini' || backend === 'openrouter' || backend === 'reckons') return 'third-party';
  return 'unknown';
}
