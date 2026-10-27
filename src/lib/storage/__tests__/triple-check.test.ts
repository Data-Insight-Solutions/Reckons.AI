import { describe, it, expect, vi } from 'vitest';
import type { KBaseDB, SettingsRecord } from '../db';
import type { TripleCheckReport } from '$lib/rdf/triple-check';
import { runTripleCheck, type CheckDependencies } from '../triple-check';
import { selectNextClaim } from '$lib/rdf/triple-check';
import { researchFixture } from '../../../../scripts/starter/research-fixture';
const claim = researchFixture()[0].claims[0], config = { tripleCheckEnabled: true, tavilyApiKey: 'synthetic', preferredBackend: 'ollama', tripleCheckDailyLimit: 1 } as SettingsRecord;
function setup() {
  const rows: TripleCheckReport[] = [];
  const db = { statements: { toArray: async () => [claim] }, sources: { get: async () => ({ uri: 'https://original.test/' }) }, tripleChecks: {
    toArray: async () => rows, add: async (r: TripleCheckReport) => { rows.push(structuredClone(r)); }, update: async (id: string, patch: object) => { Object.assign(rows.find(r => r.id === id)!, patch); }, put: async (r: TripleCheckReport) => { rows[rows.findIndex(x => x.id === r.id)] = structuredClone(r); },
    bulkDelete: async (ids: string[]) => { for (const id of ids) rows.splice(rows.findIndex(r => r.id === id), 1); },
  } } as unknown as KBaseDB;
  const deps: CheckDependencies = { providerError: null, loadSpaces: vi.fn(async () => ({ graphs: [], unavailable: [], capped: false })), search: vi.fn(async () => [{ url: 'https://evidence.test/', title: 'Evidence', content: 'Actual source passage' }]), judge: vi.fn(async (_fact: unknown, sources: { url: string; title: string; content: string }[]) => sources.map(s => ({ url: s.url, title: s.title, snippet: s.content, stance: 'contradicts' as const, confidence: 0.9 }))) };
  return { db, deps, rows };
}
describe('durable Triple Check worker', () => {
  it('requires opt-in and keeps local-only claims off search and web model services', async () => {
    const { db, deps, rows } = setup(); const signal = new AbortController().signal;
    expect(await runTripleCheck(db, 'current', { ...config, tripleCheckEnabled: false }, deps, signal)).toBeNull(); expect(rows).toHaveLength(0);
    await runTripleCheck(db, 'current', { ...config, tripleCheckWebEnabled: false }, deps, signal);
    expect(deps.loadSpaces).toHaveBeenCalled(); expect(deps.search).not.toHaveBeenCalled(); expect(deps.judge).not.toHaveBeenCalled();
  });
  it('reserves metered attempts durably before search and enforces budget across configuration changes', async () => {
    const { db, deps, rows } = setup(); const search = deps.search;
    deps.search = vi.fn(async (query, signal) => { expect(rows[0].webAttempted).toBe(true); return search(query, signal); });
    const result = await runTripleCheck(db, 'current', config, deps, new AbortController().signal);
    expect(result?.web[0].stance).toBe('contradicts'); expect(claim.status).toBe('confirmed');
    const next = await runTripleCheck(db, 'current', { ...config, tripleCheckModel: 'changed' }, deps, new AbortController().signal);
    expect(next?.warnings.some(w => w.includes('limit'))).toBe(true); expect(deps.search).toHaveBeenCalledTimes(1);
  });
  it('records partial failures without echoed prompts or credentials, and aborts before network I/O', async () => {
    const { db, deps, rows } = setup(); deps.search = vi.fn(async () => { throw new Error('secret echoed provider body'); });
    const result = await runTripleCheck(db, 'current', config, deps, new AbortController().signal);
    expect(result?.web).toEqual([]); expect(JSON.stringify(result)).not.toContain('secret'); expect(result?.warnings.join(' ')).toContain('failed');
    const controller = new AbortController(); deps.loadSpaces = vi.fn(async () => { controller.abort(); return { graphs: [], unavailable: [], capped: false }; });
    await expect(runTripleCheck(db, 'current', { ...config, tripleCheckModel: 'changed' }, deps, controller.signal)).rejects.toThrow();
    expect(rows.at(-1)?.warnings.join(' ')).toContain('interrupted'); expect(deps.search).toHaveBeenCalledTimes(1);
  });
  it('excludes unsafe URLs, duplicate results and original-source self-citations', async () => {
    const { db, deps } = setup(); deps.search = vi.fn(async () => ['javascript:alert(1)', 'https://original.test/', 'https://evidence.test/', 'https://evidence.test/#same'].map(url => ({ url, title: 'Source', content: 'Passage' })));
    deps.scrape = vi.fn(async source => source); await runTripleCheck(db, 'current', config, deps, new AbortController().signal);
    expect(deps.scrape).toHaveBeenCalledTimes(1); expect(deps.judge).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ url: 'https://evidence.test/' })], expect.anything());
  });
  it('a deliberate configuration warning is complete, not retried hourly', async () => {
    const { db, deps, rows } = setup(); const off = { ...config, tripleCheckWebEnabled: false };
    const report = await runTripleCheck(db, 'current', off, deps, new AbortController().signal);
    expect(report?.warnings.some(w => w.startsWith('Web not checked:'))).toBe(true); expect(report?.incomplete).toBe(false);
    expect(selectNextClaim([claim], rows, report!.checkedAt + 2 * 3600000, report!.configuration)).toBeUndefined();
  });
  it('a failed search is incomplete and retried after an hour', async () => {
    const { db, deps, rows } = setup(); deps.search = vi.fn(async () => { throw new Error('down'); });
    const report = await runTripleCheck(db, 'current', config, deps, new AbortController().signal);
    expect(report?.incomplete).toBe(true);
    expect(selectNextClaim([claim], rows, report!.checkedAt + 2 * 3600000, report!.configuration)).toBeDefined();
  });
  it('keeps one report per claim when it is checked again', async () => {
    const { db, deps, rows } = setup(); const off = { ...config, tripleCheckWebEnabled: false };
    await runTripleCheck(db, 'current', off, deps, new AbortController().signal);
    await runTripleCheck(db, 'current', { ...off, tripleCheckModel: 'changed' }, deps, new AbortController().signal);
    expect(rows).toHaveLength(1); expect(rows[0].configuration).toContain('changed');
  });
});
