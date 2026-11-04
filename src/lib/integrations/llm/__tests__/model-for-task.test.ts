import { describe, it, expect } from 'vitest';
import { ollamaModelFor, resolveInstalledModel, pickDefaultOllamaModel, FALLBACK_OLLAMA_MODEL } from '../model-for-task';

/** The 11 models actually installed on this machine (2026-11-03). */
const THIS_MACHINE = [
  'command-r:35b',
  'devstral-small-2:latest',
  'gemma3:27b',
  'gpt-oss:120b',
  'llama3.2:3b',
  'mistral-small3.2:24b',
  'nomic-embed-text:latest',
  'phi4:14b',
  'qwen2.5vl:7b',
  'qwen3-coder:latest',
  'qwen3.8:latest',
];

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

describe('resolveInstalledModel', () => {
  it('resolves a bare family name to the tag the server actually has', () => {
    expect(resolveInstalledModel('llama3.2', ['llama3.2:3b', 'mistral-small3.2:24b']))
      .toBe('llama3.2:3b');
  });

  it('an exact match wins — a name the user chose is never rewritten', () => {
    expect(resolveInstalledModel('qwen3-coder:latest', ['qwen3-coder', 'qwen3-coder:latest']))
      .toBe('qwen3-coder:latest');
    expect(resolveInstalledModel('qwen3-coder', ['qwen3-coder', 'qwen3-coder:latest']))
      .toBe('qwen3-coder');
  });

  it('prefers name:latest before another tag of the family', () => {
    expect(resolveInstalledModel('llama3.2', ['llama3.2:3b', 'llama3.2:latest']))
      .toBe('llama3.2:latest');
  });

  it('returns undefined for a family the server does not have — never invents a tag', () => {
    expect(resolveInstalledModel('qwen3', ['llama3.2:3b', 'qwen2.5vl:7b'])).toBeUndefined();
  });
});

describe('pickDefaultOllamaModel', () => {
  it('picks the best benched model installed on THIS machine', () => {
    // qwen3:32b is not in this list (not installed here), so the choice is mistral-small3.2:24b.
    expect(pickDefaultOllamaModel(THIS_MACHINE)).toBe('mistral-small3.2:24b');
  });

  it('picks a preferred model present only as a bare-name+tag', () => {
    expect(pickDefaultOllamaModel(['llama3.2:3b', 'nomic-embed-text:latest']))
      .toBe('llama3.2:3b');
  });

  it('picks the first non-embedding model when nothing preferred is installed', () => {
    expect(pickDefaultOllamaModel(['nomic-embed-text:latest', 'my-custom:1']))
      .toBe('my-custom:1');
    // ...and skips the embed model even when it is first overall
    expect(pickDefaultOllamaModel(['nomic-embed-text:latest', 'custom-a:1', 'custom-b:2']))
      .toBe('custom-a:1');
  });

  it('returns the fallback for an empty list', () => {
    expect(pickDefaultOllamaModel([])).toBe(FALLBACK_OLLAMA_MODEL);
  });

  it('returns the fallback when only embedding models are installed', () => {
    expect(pickDefaultOllamaModel(['nomic-embed-text:latest', 'bge-embed:small']))
      .toBe(FALLBACK_OLLAMA_MODEL);
  });
});

describe('ollamaModelFor with an installed-model list', () => {
  it('resolves a bare family name to the installed tag', () => {
    expect(ollamaModelFor('analyze', { ollamaModel: 'llama3.2' }, THIS_MACHINE))
      .toBe('llama3.2:3b');
  });

  it('a model the user chose AND that is installed is never overridden', () => {
    expect(ollamaModelFor('chat', { ollamaModel: 'command-r:35b' }, THIS_MACHINE))
      .toBe('command-r:35b');
  });

  it('a chosen name that is NOT installed falls through to the best installed model', () => {
    expect(ollamaModelFor('ingest', { ollamaModel: 'qwen3:32b' }, THIS_MACHINE))
      .toBe('mistral-small3.2:24b');
  });

  it('nothing configured → the best installed model, not the bare fallback', () => {
    expect(ollamaModelFor('analyze', {}, THIS_MACHINE)).toBe('mistral-small3.2:24b');
  });

  it('null or undefined list keeps the previous resolution exactly', () => {
    expect(ollamaModelFor('analyze', { ollamaModel: 'llama3.2' }, null)).toBe('llama3.2');
    expect(ollamaModelFor('analyze', {}, null)).toBe(FALLBACK_OLLAMA_MODEL);
    expect(ollamaModelFor('analyze', { ollamaModel: 'llama3.2' })).toBe('llama3.2');
  });
});
