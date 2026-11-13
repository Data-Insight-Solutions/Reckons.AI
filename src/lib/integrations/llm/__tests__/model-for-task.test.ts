import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ollamaModelFor, resolveInstalledModel, pickDefaultOllamaModel, setOllamaSubstitutionListener,
  NO_OLLAMA_MODEL_MESSAGE, type OllamaTask,
} from '../model-for-task';
import { chatOllama, resolveOllamaModelOrThrow } from '../providers';

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

  it('names no model when nothing is set and the installed list is unknown', () => {
    expect(ollamaModelFor('analyze', {})).toBeUndefined();
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

  it('returns undefined for an empty list — no invented name', () => {
    expect(pickDefaultOllamaModel([])).toBeUndefined();
  });

  it('returns undefined when only embedding models are installed', () => {
    expect(pickDefaultOllamaModel(['nomic-embed-text:latest', 'bge-embed:small'])).toBeUndefined();
  });

  it('picks per role: code leans on the code model, extraction and chat do not', () => {
    expect(pickDefaultOllamaModel(THIS_MACHINE, 'code')).toBe('qwen3-coder:latest');
    expect(pickDefaultOllamaModel(THIS_MACHINE, 'extraction')).toBe('mistral-small3.2:24b');
    expect(pickDefaultOllamaModel(['qwen3-coder:latest', 'gemma3:4b'], 'extraction')).toBe('gemma3:4b');
    expect(pickDefaultOllamaModel(['qwen3-coder:latest', 'gemma3:4b'], 'code')).toBe('qwen3-coder:latest');
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
    expect(ollamaModelFor('analyze', {}, null)).toBeUndefined();
    expect(ollamaModelFor('analyze', { ollamaModel: 'llama3.2' })).toBe('llama3.2');
  });
});

describe('F279.1: no default model name', () => {
  const TASKS: OllamaTask[] = ['ingest', 'analyze', 'chat', 'diffSummary', 'mergeAnalysis'];
  afterEach(() => { setOllamaSubstitutionListener(null); vi.unstubAllGlobals(); });

  it('nothing chosen → an installed model for every role', () => {
    for (const t of TASKS) {
      const m = ollamaModelFor(t, {}, THIS_MACHINE);
      expect(THIS_MACHINE).toContain(m);
    }
  });

  it('nothing chosen and only a small model installed → that model, never a name that is not there', () => {
    expect(ollamaModelFor('chat', {}, ['gemma3:4b'])).toBe('gemma3:4b');
  });

  it('nothing chosen, nothing installed → undefined', () => {
    expect(ollamaModelFor('ingest', {}, [])).toBeUndefined();
  });

  it('a chosen installed model is never replaced and raises no notice', () => {
    const seen: unknown[] = [];
    setOllamaSubstitutionListener((s) => seen.push(s));
    expect(ollamaModelFor('ingest', { ollamaModel: 'phi4:14b' }, THIS_MACHINE)).toBe('phi4:14b');
    expect(seen).toEqual([]);
  });

  it('a chosen model that is missing is substituted and announced', () => {
    const seen: unknown[] = [];
    setOllamaSubstitutionListener((s) => seen.push(s));
    expect(ollamaModelFor('ingest', { ollamaModel: 'qwen3:32b' }, THIS_MACHINE)).toBe('mistral-small3.2:24b');
    expect(seen).toEqual([{ task: 'ingest', chosen: 'qwen3:32b', used: 'mistral-small3.2:24b' }]);
  });

  it('the caller with no model and no installed list asks the server, and says to pull when empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })));
    await expect(resolveOllamaModelOrThrow(undefined, 'http://x')).rejects.toThrow(NO_OLLAMA_MODEL_MESSAGE);
    await expect(chatOllama([{ role: 'user', content: 'hi' }], 's')).rejects.toThrow(/ollama pull/);
  });

  it('the caller picks the best installed model when the server has some', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma3:4b' }] }) })));
    await expect(resolveOllamaModelOrThrow(undefined, 'http://x')).resolves.toBe('gemma3:4b');
    await expect(resolveOllamaModelOrThrow('mine:1', 'http://x')).resolves.toBe('mine:1');
  });

  it('a server that is down is reported as unreachable, not as "pull a model"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(resolveOllamaModelOrThrow(undefined, 'http://x')).rejects.toThrow(/not reachable at http:\/\/x/);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    await expect(resolveOllamaModelOrThrow(undefined, 'http://x')).rejects.not.toThrow(/ollama pull/);
  });
});
