import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Source } from '../../rdf/types';

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockSources: Source[] = [];
let mockSettings: Record<string, any> = {};

vi.mock('../kb.svelte', () => ({
  sources: () => mockSources,
  statementsForSource: vi.fn(() => []),
}));

vi.mock('../settings.svelte', () => ({
  settings: () => mockSettings,
}));

vi.mock('../ingest.svelte', () => ({
  ingest: vi.fn(),
}));

const { isRefreshable, refreshableSources, refreshSource } = await import('../source-refresh');
const { ingest } = await import('../ingest.svelte');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkSource(overrides: Partial<Source> = {}): Source {
  return {
    id: `src-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test Source',
    uri: 'https://example.com',
    ingestedAt: Date.now(),
    kind: 'url',
    ...overrides,
  };
}

beforeEach(() => {
  mockSources = [];
  mockSettings = {};
  vi.clearAllMocks();
});

// ── isRefreshable ────────────────────────────────────────────────────────────

describe('isRefreshable', () => {
  it('returns true for url sources', () => {
    expect(isRefreshable(mkSource({ kind: 'url' }))).toBe(true);
  });

  it('returns true for repository sources', () => {
    expect(isRefreshable(mkSource({ kind: 'repository' }))).toBe(true);
  });

  it('returns true for calendar sources', () => {
    expect(isRefreshable(mkSource({ kind: 'calendar' }))).toBe(true);
  });

  it('returns false for document sources', () => {
    expect(isRefreshable(mkSource({ kind: 'document' }))).toBe(false);
  });

  it('returns false for note sources', () => {
    expect(isRefreshable(mkSource({ kind: 'note' }))).toBe(false);
  });

  it('returns false for reminder sources', () => {
    expect(isRefreshable(mkSource({ kind: 'reminder' }))).toBe(false);
  });

  it('returns false for semfile sources', () => {
    expect(isRefreshable(mkSource({ kind: 'semfile' }))).toBe(false);
  });

  it('returns false for analysis sources', () => {
    expect(isRefreshable(mkSource({ kind: 'analysis' }))).toBe(false);
  });

  it('returns false for turtle sources', () => {
    expect(isRefreshable(mkSource({ kind: 'turtle' }))).toBe(false);
  });
});

// ── refreshableSources ───────────────────────────────────────────────────────

describe('refreshableSources', () => {
  it('returns empty array when no sources exist', () => {
    mockSources = [];
    expect(refreshableSources()).toHaveLength(0);
  });

  it('filters to only refreshable sources', () => {
    mockSources = [
      mkSource({ kind: 'url', title: 'Web Page' }),
      mkSource({ kind: 'document', title: 'PDF' }),
      mkSource({ kind: 'repository', title: 'Repo' }),
      mkSource({ kind: 'note', title: 'My Note' }),
      mkSource({ kind: 'calendar', title: 'Calendar' }),
    ];
    const result = refreshableSources();
    expect(result).toHaveLength(3);
    expect(result.map(s => s.title)).toEqual(
      expect.arrayContaining(['Web Page', 'Repo', 'Calendar'])
    );
  });

  it('returns all sources when all are refreshable', () => {
    mockSources = [
      mkSource({ kind: 'url' }),
      mkSource({ kind: 'repository' }),
    ];
    expect(refreshableSources()).toHaveLength(2);
  });
});

// ── refreshSource ────────────────────────────────────────────────────────────

describe('refreshSource', () => {
  it('returns skipped for non-refreshable kinds', async () => {
    const src = mkSource({ kind: 'document' });
    const result = await refreshSource(src);
    expect(result.status).toBe('skipped');
    expect(result.sourceId).toBe(src.id);
  });

  it('returns skipped for calendar (not yet automated)', async () => {
    const src = mkSource({ kind: 'calendar' });
    const result = await refreshSource(src);
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('Calendar');
  });

  it('returns error when repository is missing metadata', async () => {
    const src = mkSource({ kind: 'repository' });
    // No repoOwner or repoName
    const result = await refreshSource(src);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Missing repo metadata');
  });

  it('returns unchanged when hashes match', async () => {
    const src = mkSource({ kind: 'url', hash: 'abc123' });
    vi.mocked(ingest).mockResolvedValueOnce({
      source: { ...src, id: 'new-src', hash: 'abc123' },
      statements: [],
    } as any);

    const result = await refreshSource(src);
    expect(result.status).toBe('unchanged');
  });

  it('returns refreshed when hashes differ', async () => {
    const src = mkSource({ kind: 'url', hash: 'old-hash' });
    vi.mocked(ingest).mockResolvedValueOnce({
      source: { ...src, id: 'new-src', hash: 'new-hash' },
      statements: [{ id: 's1' }, { id: 's2' }],
    } as any);

    const result = await refreshSource(src);
    expect(result.status).toBe('refreshed');
    expect(result.newSourceId).toBe('new-src');
    expect(result.statementCount).toBe(2);
  });

  it('returns error when ingest throws', async () => {
    const src = mkSource({ kind: 'url' });
    vi.mocked(ingest).mockRejectedValueOnce(new Error('Network failure'));

    const result = await refreshSource(src);
    expect(result.status).toBe('error');
    expect(result.error).toBe('Network failure');
  });

  it('passes correct input for url sources', async () => {
    const src = mkSource({ kind: 'url', uri: 'https://example.com/page' });
    vi.mocked(ingest).mockResolvedValueOnce({
      source: { ...src, hash: 'different' },
      statements: [],
    } as any);

    await refreshSource(src);
    expect(ingest).toHaveBeenCalledWith(
      { kind: 'url', url: 'https://example.com/page' },
      undefined,
    );
  });

  it('passes correct input for repository sources', async () => {
    const src = mkSource({
      kind: 'repository',
      repoOwner: 'octocat',
      repoName: 'hello-world',
    });
    vi.mocked(ingest).mockResolvedValueOnce({
      source: { ...src, hash: 'different' },
      statements: [],
    } as any);

    await refreshSource(src);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'repository',
        repoUrl: 'octocat/hello-world',
      }),
      undefined,
    );
  });
});
