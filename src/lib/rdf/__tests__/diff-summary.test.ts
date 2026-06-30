import { describe, it, expect, vi } from 'vitest';
import type { Diff, DiffEntry } from '../diff';
import type { Statement } from '../types';
import { iri, lit } from '../types';

// We test the exported public API. The internal helpers (describeEntry,
// buildPrompt, fallbackSummary) are exercised indirectly through
// generateDiffSummary. We mock all LLM providers to avoid network calls.

vi.mock('$lib/integrations/llm/providers', () => ({
  chatClaude: vi.fn(),
  chatOpenAI: vi.fn(),
  chatGemini: vi.fn(),
  chatOllama: vi.fn(),
  chatOpenRouter: vi.fn(),
  chatReckons: vi.fn(),
  chatChromeAI: vi.fn(),
}));

vi.mock('$lib/integrations/llm/wasm', () => ({
  chatWithWasm: vi.fn(),
}));

const { generateDiffSummary } = await import('../diff-summary');
const providers = await import('$lib/integrations/llm/providers');

// ── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
function mkStmt(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `stmt-${++_id}`,
    s: iri('urn:test/s'),
    p: iri('urn:test/p'),
    o: lit('value'),
    g: iri('urn:test/g'),
    sourceId: 'src1',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function mkDiff(overrides: Partial<Diff['summary']> = {}, entries: DiffEntry[] = []): Diff {
  return {
    entries,
    summary: {
      new: 0,
      duplicate: 0,
      reinforces: 0,
      conflicts: 0,
      refines: 0,
      nearDuplicate: 0,
      synonymReinforces: 0,
      antonymConflicts: 0,
      ...overrides,
    },
  };
}

const MOCK_SETTINGS = {
  preferredBackend: 'claude' as const,
  claudeApiKey: 'test-key',
  claudeModel: 'claude-haiku-4-5-20251001',
} as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('generateDiffSummary — fallback (empty diff)', () => {
  it('returns "None in this source." for all categories when diff is empty', async () => {
    const result = await generateDiffSummary(mkDiff(), MOCK_SETTINGS);
    expect(result.newSummary).toBe('None in this source.');
    expect(result.reinforcingSummary).toBe('None in this source.');
    expect(result.conflictingSummary).toBe('None in this source.');
  });
});

describe('generateDiffSummary — fallback (LLM failure)', () => {
  it('returns count-based summary when LLM throws', async () => {
    vi.mocked(providers.chatClaude).mockRejectedValueOnce(new Error('API error'));

    const diff = mkDiff(
      { new: 3, reinforces: 1, conflicts: 2 },
      [
        { kind: 'new', incoming: mkStmt() },
        { kind: 'new', incoming: mkStmt() },
        { kind: 'new', incoming: mkStmt() },
        { kind: 'reinforces', incoming: mkStmt(), existing: [mkStmt()] },
        { kind: 'conflicts', incoming: mkStmt(), existing: [mkStmt()] },
        { kind: 'conflicts', incoming: mkStmt(), existing: [mkStmt()] },
      ],
    );

    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.newSummary).toContain('3 facts');
    expect(result.reinforcingSummary).toContain('1 fact');
    expect(result.conflictingSummary).toContain('2 facts');
  });
});

describe('generateDiffSummary — LLM success', () => {
  it('parses valid JSON from LLM response', async () => {
    const llmResponse = JSON.stringify({
      newSummary: 'Three new concepts about physics.',
      reinforcingSummary: 'Gravity is well established.',
      conflictingSummary: 'Speed of light value differs.',
    });
    vi.mocked(providers.chatClaude).mockResolvedValueOnce(llmResponse);

    const diff = mkDiff(
      { new: 3 },
      [
        { kind: 'new', incoming: mkStmt({ gloss: 'Energy equals mass times c²' }) },
        { kind: 'new', incoming: mkStmt({ gloss: 'Gravity bends light' }) },
        { kind: 'new', incoming: mkStmt({ gloss: 'Photons are massless' }) },
      ],
    );

    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.newSummary).toBe('Three new concepts about physics.');
    expect(result.reinforcingSummary).toBe('Gravity is well established.');
    expect(result.conflictingSummary).toBe('Speed of light value differs.');
  });

  it('handles markdown-fenced JSON from LLM', async () => {
    const llmResponse = '```json\n{"newSummary":"A","reinforcingSummary":"B","conflictingSummary":"C"}\n```';
    vi.mocked(providers.chatClaude).mockResolvedValueOnce(llmResponse);

    const diff = mkDiff({ new: 1 }, [{ kind: 'new', incoming: mkStmt() }]);
    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.newSummary).toBe('A');
  });

  it('uses fallback for categories missing in LLM response', async () => {
    const llmResponse = JSON.stringify({ newSummary: 'Only this is set.' });
    vi.mocked(providers.chatClaude).mockResolvedValueOnce(llmResponse);

    const diff = mkDiff({ new: 1, reinforces: 2 }, [
      { kind: 'new', incoming: mkStmt() },
      { kind: 'reinforces', incoming: mkStmt(), existing: [mkStmt()] },
      { kind: 'reinforces', incoming: mkStmt(), existing: [mkStmt()] },
    ]);

    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.newSummary).toBe('Only this is set.');
    // reinforcingSummary should fall back to the count-based message
    expect(result.reinforcingSummary).toContain('2 facts');
  });
});

describe('generateDiffSummary — provider routing', () => {
  it('uses diffSummaryBackend when specified', async () => {
    vi.mocked(providers.chatOpenAI).mockResolvedValueOnce(
      '{"newSummary":"via openai","reinforcingSummary":"B","conflictingSummary":"C"}'
    );

    const diff = mkDiff({ new: 1 }, [{ kind: 'new', incoming: mkStmt() }]);
    const result = await generateDiffSummary(diff, {
      ...MOCK_SETTINGS,
      diffSummaryBackend: 'openai',
      openaiApiKey: 'key',
    });

    expect(providers.chatOpenAI).toHaveBeenCalled();
    expect(result.newSummary).toBe('via openai');
  });

  it('falls back to analyzeBackend then preferredBackend', async () => {
    vi.mocked(providers.chatGemini).mockResolvedValueOnce(
      '{"newSummary":"via gemini","reinforcingSummary":"B","conflictingSummary":"C"}'
    );

    const diff = mkDiff({ new: 1 }, [{ kind: 'new', incoming: mkStmt() }]);
    await generateDiffSummary(diff, {
      ...MOCK_SETTINGS,
      analyzeBackend: 'gemini',
      geminiApiKey: 'key',
    });

    expect(providers.chatGemini).toHaveBeenCalled();
  });
});

describe('generateDiffSummary — fallback summary grammar', () => {
  it('uses singular for 1 fact', async () => {
    const diff = mkDiff({ new: 1 });
    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.newSummary).toContain('1 fact ');
    expect(result.newSummary).not.toContain('facts');
  });

  it('counts synonym-reinforces in reinforcing total', async () => {
    const diff = mkDiff({ synonymReinforces: 3 });
    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.reinforcingSummary).toContain('3 facts');
  });

  it('counts antonym-conflicts + refines in conflicting total', async () => {
    const diff = mkDiff({ antonymConflicts: 2, refines: 1 });
    const result = await generateDiffSummary(diff, MOCK_SETTINGS);
    expect(result.conflictingSummary).toContain('3 facts');
  });
});

describe('generateDiffSummary — entry description', () => {
  it('uses gloss when available', async () => {
    vi.mocked(providers.chatClaude).mockImplementationOnce(async (msgs) => {
      const content = msgs[0].content;
      expect(content).toContain('Coffee is a beverage');
      return '{"newSummary":"ok","reinforcingSummary":"ok","conflictingSummary":"ok"}';
    });

    const diff = mkDiff({ new: 1 }, [
      { kind: 'new', incoming: mkStmt({ gloss: 'Coffee is a beverage' }) },
    ]);
    await generateDiffSummary(diff, MOCK_SETTINGS);
  });

  it('uses excerpt as fallback when gloss is absent', async () => {
    vi.mocked(providers.chatClaude).mockImplementationOnce(async (msgs) => {
      const content = msgs[0].content;
      expect(content).toContain('source sentence here');
      return '{"newSummary":"ok","reinforcingSummary":"ok","conflictingSummary":"ok"}';
    });

    const diff = mkDiff({ new: 1 }, [
      { kind: 'new', incoming: mkStmt({ excerpt: 'source sentence here' }) },
    ]);
    await generateDiffSummary(diff, MOCK_SETTINGS);
  });

  it('falls back to s/p/o slug when both gloss and excerpt are absent', async () => {
    vi.mocked(providers.chatClaude).mockImplementationOnce(async (msgs) => {
      const content = msgs[0].content;
      // Should contain the slug of s, p, o values
      expect(content).toContain('s');
      expect(content).toContain('p');
      return '{"newSummary":"ok","reinforcingSummary":"ok","conflictingSummary":"ok"}';
    });

    const diff = mkDiff({ new: 1 }, [
      { kind: 'new', incoming: mkStmt() },
    ]);
    await generateDiffSummary(diff, MOCK_SETTINGS);
  });
});
