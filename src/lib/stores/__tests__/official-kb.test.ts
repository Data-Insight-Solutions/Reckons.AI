import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Statement } from '../../rdf/types';

// A minimal valid statement for the "loaded with content" path.
function mkStatement(): Statement {
  return {
    id: 's1',
    s: { kind: 'iri', value: 'urn:x:a' },
    p: { kind: 'iri', value: 'urn:x:p' },
    o: { kind: 'literal', value: 'v' },
    g: { kind: 'iri', value: 'urn:x:g' },
    sourceId: 'x', confidence: 1, status: 'confirmed',
    createdAt: 1, updatedAt: 1
  };
}

let mockImportResult: { statements: Statement[] };

/** Re-import the store fresh each test so module-level $state (_loaded etc.) is reset. */
async function freshStore() {
  vi.resetModules();
  vi.doMock('../../rdf/import-ttl', () => ({
    importTurtleFull: vi.fn(async () => mockImportResult),
  }));
  return await import('../official-kb.svelte');
}

describe('activateOfficialKb', () => {
  beforeEach(() => {
    mockImportResult = { statements: [mkStatement()] };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('activates when the KB loads with content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<ttl/>', { status: 200 })));
    const kb = await freshStore();
    const ok = await kb.activateOfficialKb();
    expect(ok).toBe(true);
    expect(kb.officialKbActive()).toBe(true);
    expect(kb.officialKbStatements()).toHaveLength(1);
    expect(kb.officialKbError()).toBeNull();
  });

  it('does NOT activate when the fetch fails (the Open-button bug)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const kb = await freshStore();
    const ok = await kb.activateOfficialKb();
    expect(ok).toBe(false);
    expect(kb.officialKbActive()).toBe(false);      // was true unconditionally before the fix
    expect(kb.officialKbError()).toBeTruthy();
  });

  it('does NOT activate when the KB parses to zero statements', async () => {
    mockImportResult = { statements: [] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<empty/>', { status: 200 })));
    const kb = await freshStore();
    const ok = await kb.activateOfficialKb();
    expect(ok).toBe(false);
    expect(kb.officialKbActive()).toBe(false);
    expect(kb.officialKbError()).toMatch(/0 statements/);
  });

  it('recovers on a later successful load after an initial failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response('<ttl/>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const kb = await freshStore();
    expect(await kb.activateOfficialKb()).toBe(false); // first attempt fails, not cached as loaded
    expect(await kb.activateOfficialKb()).toBe(true);  // retry succeeds
    expect(kb.officialKbError()).toBeNull();
  });
});
