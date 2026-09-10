import { describe, it, expect } from 'vitest';
import { ollamaModelFor, FALLBACK_OLLAMA_MODEL } from '../model-for-task';

describe('ollamaModelFor', () => {
  it('uses a task override when one is set', () => {
    expect(ollamaModelFor('ingest', { ollamaModel: 'qwen3-coder', ollamaIngestModel: 'qwen3.6' }))
      .toBe('qwen3.6');
  });

  it('falls back to the general model — an existing install keeps behaving the same', () => {
    expect(ollamaModelFor('ingest', { ollamaModel: 'qwen3-coder' })).toBe('qwen3-coder');
    expect(ollamaModelFor('chat', { ollamaModel: 'qwen3-coder' })).toBe('qwen3-coder');
  });

  it('falls back to one documented default when nothing is set', () => {
    expect(ollamaModelFor('analyze', {})).toBe(FALLBACK_OLLAMA_MODEL);
  });

  it('sub-tasks inherit from analyze, matching how their BACKEND already falls back', () => {
    const s = { ollamaModel: 'general', ollamaAnalyzeModel: 'reasoner' };
    expect(ollamaModelFor('diffSummary', s)).toBe('reasoner');
    expect(ollamaModelFor('mergeAnalysis', s)).toBe('reasoner');
  });

  it('a sub-task override still beats analyze', () => {
    const s = { ollamaAnalyzeModel: 'reasoner', ollamaDiffSummaryModel: 'fast-small' };
    expect(ollamaModelFor('diffSummary', s)).toBe('fast-small');
  });

  it('ingest and chat do NOT inherit from analyze', () => {
    const s = { ollamaModel: 'general', ollamaAnalyzeModel: 'reasoner' };
    expect(ollamaModelFor('ingest', s)).toBe('general');
    expect(ollamaModelFor('chat', s)).toBe('general');
  });

  it('treats blank and whitespace-only overrides as unset, and trims', () => {
    expect(ollamaModelFor('ingest', { ollamaModel: 'general', ollamaIngestModel: '   ' }))
      .toBe('general');
    expect(ollamaModelFor('ingest', { ollamaIngestModel: '  qwen3.6  ' })).toBe('qwen3.6');
  });
});
