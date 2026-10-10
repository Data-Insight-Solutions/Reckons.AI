import { describe, expect, it } from 'vitest';
import { DEFAULT_NUM_BATCH, OllamaHttpError, deviceNumBatch, isTransient, localOptions, retryTransient } from '../local-model';

const noWait = { waitMs: 0, sleep: async () => {}, onRetry: () => {} };

describe('device batch size', () => {
  it('reads the threshold, falls back to the default, and 0 sends none', () => {
    expect(deviceNumBatch(() => ({ thresholds: { ollamaNumBatch: { limit: 128 } } }))).toBe(128);
    expect(deviceNumBatch(() => ({ thresholds: {} }))).toBe(DEFAULT_NUM_BATCH);
    expect(deviceNumBatch(() => { throw new Error('unreadable'); })).toBe(DEFAULT_NUM_BATCH);
    expect(deviceNumBatch(() => ({ thresholds: { ollamaNumBatch: { limit: 0 } } }))).toBeUndefined();
  });
  it('adds num_batch to options, and the caller wins', () => {
    expect(localOptions({ num_ctx: 8192 }, () => 256)).toEqual({ num_batch: 256, num_ctx: 8192 });
    expect(localOptions({ num_batch: 64 }, () => 256)).toEqual({ num_batch: 64 });
    expect(localOptions({ temperature: 0 }, () => undefined)).toEqual({ temperature: 0 });
  });
});

describe('transient failures', () => {
  it('retries what a restarted server explains', () => {
    // the 2026-10-09 body, verbatim in shape
    expect(isTransient(new OllamaHttpError(500, '{"error":"an error was encountered while running the model: CUDA error: an illegal memory access was encountered"}'))).toBe(true);
    expect(isTransient(new OllamaHttpError(503, ''))).toBe(true);
    expect(isTransient(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
    expect(isTransient(new Error('fetch failed (ECONNRESET)'))).toBe(true);
    expect(isTransient(new Error('Ollama 500 Internal Server Error: boom'))).toBe(true); // ollama-stream's message
    expect(isTransient(new Error('Ollama: an error was encountered while running the model'))).toBe(true); // a mid-stream error line
  });
  it('does not retry what waiting cannot change', () => {
    expect(isTransient(new OllamaHttpError(404, 'model "nope" not found'))).toBe(false);
    expect(isTransient(new OllamaHttpError(400, 'invalid format'))).toBe(false);
    expect(isTransient(new Error('fetch failed (UND_ERR_HEADERS_TIMEOUT) — Ollama did not start answering within 20 min'))).toBe(false);
    expect(isTransient(new SyntaxError('Unexpected token } in JSON'))).toBe(false);
  });
});

describe('retryTransient', () => {
  it('recovers after a crash, within the attempt budget', async () => {
    let calls = 0;
    const r = await retryTransient(async () => { if (++calls < 3) throw new OllamaHttpError(500, 'llama-server terminated'); return 'ok'; }, noWait);
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });
  it('gives up after the budget and rethrows the last error', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls++; throw new OllamaHttpError(500, 'still down'); }, noWait)).rejects.toThrow('still down');
    expect(calls).toBe(3); // the first call plus two retries
  });
  it('fails at once on a permanent error', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls++; throw new OllamaHttpError(404, 'not found'); }, noWait)).rejects.toThrow('404');
    expect(calls).toBe(1);
  });
});
