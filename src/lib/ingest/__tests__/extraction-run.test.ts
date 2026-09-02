import { describe, expect, it } from 'vitest';
import {
  cancelExtractionRun,
  completeExtractionRun,
  createExtractionRun,
  extractionLocalityForBackend,
  failExtractionRun,
  finishExtractionAttempt,
  finishExtractionStage,
  recordExtractionOutput,
  startExtractionAttempt,
  startExtractionFallbackAttempt,
  startExtractionStage,
} from '../extraction-run';

describe('ExtractionRun lifecycle (F136.1)', () => {
  it('records a local route and its successful attempt without retaining source bytes', () => {
    let run = createExtractionRun({
      id: 'run-1', sourceId: 'source-1', sourceHash: 'hash-only', backend: 'ollama',
      model: 'qwen3:8b', locality: extractionLocalityForBackend('ollama'),
      reason: 'configured ingest backend', startedAt: 100,
    });
    run = startExtractionStage(run, 'route', 101);
    run = finishExtractionStage(run, 'route', 'succeeded', undefined, 102);
    run = startExtractionStage(run, 'extract', 103);
    run = startExtractionAttempt(run, 104);
    run = finishExtractionAttempt(run, 'succeeded', undefined, 105);
    run = finishExtractionStage(run, 'extract', 'succeeded', undefined, 106);
    run = recordExtractionOutput(run, ['statement-1'], { grounded: 1, ungrounded: 0 });
    run = completeExtractionRun(run, 107);

    expect(run.status).toBe('succeeded');
    expect(run.route.locality).toBe('local-network');
    expect(run.route.attempts).toEqual([expect.objectContaining({ status: 'succeeded', model: 'qwen3:8b' })]);
    expect(run).not.toHaveProperty('sourceText');
    expect(run.outputStatementIds).toEqual(['statement-1']);
  });

  it('keeps the failed primary attempt and terminal failure visible', () => {
    let run = createExtractionRun({
      id: 'run-2', sourceId: 'source-2', sourceHash: 'hash-only', backend: 'openai',
      model: 'gpt-4o-mini', locality: extractionLocalityForBackend('openai'),
      reason: 'configured ingest backend', startedAt: 200,
    });
    run = startExtractionStage(run, 'extract', 201);
    run = startExtractionAttempt(run, 202);
    run = finishExtractionAttempt(run, 'failed', 'network unavailable', 203);
    run = failExtractionRun(run, 'extract', new Error('network unavailable'), 204);

    expect(run.status).toBe('failed');
    expect(run.failure).toEqual({ stage: 'extract', message: 'network unavailable', at: 204 });
    expect(run.route.attempts[0]).toMatchObject({ status: 'failed', error: 'network unavailable' });
  });

  it('retains both sides of an existing fallback instead of relabelling it as primary success', () => {
    let run = createExtractionRun({
      id: 'run-2b', sourceId: 'source-2b', sourceHash: 'hash-only', backend: 'wasm',
      model: 'small-local-model', locality: extractionLocalityForBackend('wasm'),
      reason: 'configured ingest backend', startedAt: 250,
    });
    run = startExtractionAttempt(run, 251);
    run = finishExtractionAttempt(run, 'failed', 'ONNX unavailable', 252);
    run = startExtractionFallbackAttempt(run, {
      backend: 'mock', model: 'placeholder-extractor-v1', locality: 'browser',
    }, 253);
    run = finishExtractionAttempt(run, 'succeeded', undefined, 254);

    expect(run.route.attempts).toEqual([
      expect.objectContaining({ backend: 'wasm', status: 'failed' }),
      expect.objectContaining({ backend: 'mock', model: 'placeholder-extractor-v1', status: 'succeeded' }),
    ]);
  });

  it('records a user cancellation distinctly from provider failure', () => {
    const run = cancelExtractionRun(
      startExtractionStage(createExtractionRun({
        id: 'run-3', sourceId: 'source-3', sourceHash: 'hash-only', backend: 'manual', model: 'turtle-import',
        locality: 'manual', reason: 'direct Turtle import', startedAt: 300,
      }), 'archive', 301),
      'archive', 'user declined archive restore', 302,
    );

    expect(run.status).toBe('cancelled');
    expect(run.failure).toBeUndefined();
    expect(run.stages.find((stage) => stage.name === 'archive')).toMatchObject({ status: 'skipped' });
  });
});
