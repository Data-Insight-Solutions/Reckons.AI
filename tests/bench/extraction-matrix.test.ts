import { describe, it, expect } from 'vitest';
import { ETHICS_PREAMBLE } from '../../src/lib/safety/content-policy';
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT_FEWSHOT } from '../../src/lib/integrations/llm/extractor';
import {
  PROMPT_VARIANTS,
  PROMPT_VARIANT_IDS,
  getPromptVariant,
  type PromptVariantId
} from './extraction-prompts';
import {
  buildColumns,
  columnKey,
  findCell,
  fmtF1,
  bestCellForModel,
  renderConsoleTable,
  renderMarkdownTable,
  type CellResult
} from './matrix-table';

// ── Prompt variant registry ──────────────────────────────────────────────────

describe('extraction prompt registry', () => {
  it('every variant starts with the ethics preamble', () => {
    for (const id of PROMPT_VARIANT_IDS) {
      const v = getPromptVariant(id);
      expect(v.systemPrompt.startsWith(ETHICS_PREAMBLE), `variant '${id}' must start with ETHICS_PREAMBLE`).toBe(true);
    }
  });

  it('variant ids are unique and match registry keys', () => {
    const ids = PROMPT_VARIANT_IDS;
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(PROMPT_VARIANTS).sort());
    for (const id of ids) {
      expect(PROMPT_VARIANTS[id].id).toBe(id);
    }
  });

  it("'full' and 'compact' are the production prompts, not copies", () => {
    expect(getPromptVariant('full').systemPrompt).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(getPromptVariant('compact').systemPrompt).toBe(EXTRACTION_SYSTEM_PROMPT_FEWSHOT);
  });

  it('every variant demands JSON-array-only output (same contract as production)', () => {
    for (const id of PROMPT_VARIANT_IDS) {
      const prompt = getPromptVariant(id).systemPrompt.toLowerCase();
      expect(prompt, `variant '${id}' must mention a JSON array`).toContain('json array');
    }
  });

  it('every variant mentions the excerpt field verbatim requirement', () => {
    for (const id of PROMPT_VARIANT_IDS) {
      const prompt = getPromptVariant(id).systemPrompt.toLowerCase();
      expect(prompt, `variant '${id}' must mention excerpt`).toContain('excerpt');
      expect(prompt, `variant '${id}' must require verbatim excerpts`).toContain('verbatim');
    }
  });

  it('every variant has a non-empty label and hypothesis', () => {
    for (const id of PROMPT_VARIANT_IDS) {
      const v = getPromptVariant(id);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.hypothesis.length).toBeGreaterThan(0);
    }
  });

  it('getPromptVariant throws on unknown ids', () => {
    expect(() => getPromptVariant('nonsense' as PromptVariantId)).toThrow(/Unknown prompt variant/);
  });
});

// ── Cell fixtures (mocked results — no model calls) ─────────────────────────

function cell(overrides: Partial<CellResult>): CellResult {
  return {
    model: 'llama3.2:3b',
    modelKind: 'ollama',
    promptId: 'full',
    promptLabel: 'full (production)',
    mode: 'plain',
    status: 'ok',
    latencyMs: 1234,
    outputTripleCount: 12,
    precision: 0.5,
    recall: 0.5,
    f1: 0.5,
    matchedCount: 9,
    goldenCount: 18,
    ...overrides
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

describe('cell-result aggregation', () => {
  const results: CellResult[] = [
    cell({ promptId: 'full', mode: 'plain', f1: 0.4 }),
    cell({ promptId: 'full', mode: 'structured', f1: 0.62 }),
    cell({ promptId: 'compact', mode: 'plain', f1: 0.55 }),
    cell({ promptId: 'compact', mode: 'structured', status: 'parse-failure', f1: 0 }),
    cell({ model: 'qwen3:4b', promptId: 'checklist', mode: 'plain', f1: 0.7 }),
    cell({ model: 'claude-haiku-4-5-20251001', modelKind: 'claude', status: 'skipped', f1: 0 })
  ];

  it('findCell locates the exact model × prompt × mode cell', () => {
    const found = findCell(results, 'llama3.2:3b', 'full', 'structured');
    expect(found?.f1).toBe(0.62);
    expect(findCell(results, 'llama3.2:3b', 'checklist', 'plain')).toBeUndefined();
  });

  it('bestCellForModel picks the highest-F1 successful cell', () => {
    const best = bestCellForModel(results, 'llama3.2:3b');
    expect(best?.promptId).toBe('full');
    expect(best?.mode).toBe('structured');
    expect(best?.f1).toBe(0.62);
  });

  it('bestCellForModel ignores failed/skipped cells', () => {
    const best = bestCellForModel(results, 'claude-haiku-4-5-20251001');
    expect(best).toBeUndefined();
  });

  it('buildColumns produces promptId/mode pairs in order', () => {
    const cols = buildColumns(['full', 'compact']);
    expect(cols).toEqual(['full/structured', 'full/plain', 'compact/structured', 'compact/plain']);
    expect(columnKey('checklist', 'plain')).toBe('checklist/plain');
  });
});

// ── Cell formatting ──────────────────────────────────────────────────────────

describe('fmtF1', () => {
  it('renders percentages for ok cells', () => {
    expect(fmtF1(cell({ f1: 0.625 }))).toBe('63%');
    expect(fmtF1(cell({ f1: 0 }))).toBe('0%');
  });

  it('renders status markers for non-ok cells', () => {
    expect(fmtF1(undefined)).toBe('—');
    expect(fmtF1(cell({ status: 'skipped' }))).toBe('skip');
    expect(fmtF1(cell({ status: 'error' }))).toBe('ERR');
    expect(fmtF1(cell({ status: 'parse-failure' }))).toBe('parse✗');
  });
});

// ── Table renderers ──────────────────────────────────────────────────────────

describe('matrix table renderers', () => {
  const results: CellResult[] = [
    cell({ model: 'llama3.2:3b', promptId: 'full', mode: 'plain', f1: 0.41 }),
    cell({ model: 'llama3.2:3b', promptId: 'full', mode: 'structured', f1: 0.63 }),
    cell({ model: 'qwen3:4b', promptId: 'full', mode: 'plain', status: 'parse-failure', f1: 0, note: 'No JSON array found' }),
    cell({ model: 'qwen3:4b', promptId: 'full', mode: 'structured', f1: 0.58 }),
    cell({ model: 'claude-haiku-4-5-20251001', modelKind: 'claude', promptId: 'full', mode: 'plain', f1: 0.8 }),
    cell({ model: 'claude-haiku-4-5-20251001', modelKind: 'claude', promptId: 'full', mode: 'structured', status: 'skipped', f1: 0, note: 'no structured mode' })
  ];
  const rowModels = ['llama3.2:3b', 'qwen3:4b', 'claude-haiku-4-5-20251001'];
  const columns = buildColumns(['full']);

  it('console table has one row per model and every cell rendered', () => {
    const table = renderConsoleTable(results, rowModels, columns);
    expect(table).toContain('llama3.2:3b');
    expect(table).toContain('qwen3:4b');
    expect(table).toContain('claude-haiku-4-5-2025'); // may be truncated to fit column width
    expect(table).toContain('63%');
    expect(table).toContain('parse✗');
    expect(table).toContain('skip');
    expect(table).toContain('full/structured');
    expect(table).toContain('full/plain');
  });

  it('markdown table is valid pipe-table with best-prompt and failure sections', () => {
    const md = renderMarkdownTable(results, rowModels, columns);
    expect(md).toContain('| Model | full/structured | full/plain |');
    expect(md).toContain('| --- | --- | --- |');
    expect(md).toContain('| llama3.2:3b | 63% | 41% |');
    expect(md).toContain('| qwen3:4b | 58% | parse✗ |');
    expect(md).toContain('| claude-haiku-4-5-20251001 | skip | 80% |');
    expect(md).toContain('## Best prompt per model');
    expect(md).toContain('- **llama3.2:3b**: `full` / structured — F1 63.0%');
    expect(md).toContain('- **claude-haiku-4-5-20251001**: `full` / plain — F1 80.0%');
    expect(md).toContain('## Parse failures / errors');
    expect(md).toContain('qwen3:4b / full / plain — parse-failure: No JSON array found');
  });

  it('markdown reports models with no successful cells honestly', () => {
    const onlyFailures: CellResult[] = [
      cell({ model: 'broken-model', status: 'error', note: 'connection refused' })
    ];
    const md = renderMarkdownTable(onlyFailures, ['broken-model'], buildColumns(['full']));
    expect(md).toContain('- **broken-model**: no successful cells');
  });
});
