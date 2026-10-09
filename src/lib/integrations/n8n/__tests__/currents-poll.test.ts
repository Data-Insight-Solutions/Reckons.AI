import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Source, Statement } from '../../../rdf/types';
import { currentsSettingsToStatements, type CurrentDef } from '../../../rdf/currents';

let mockSources: Source[] = [];
let mockStatements: Statement[] = [];
let mockSettings: Record<string, unknown> = {};
const addStatementsMock = vi.fn(async (_s: Statement[], _id?: string, _o?: unknown) => {});
const pushMock = vi.fn();
const dismissMock = vi.fn();

vi.mock('../../../stores/kb.svelte', () => ({
  addSource: async (s: Source) => { mockSources = [s, ...mockSources]; },
  addStatements: (s: Statement[], id?: string, o?: unknown) => addStatementsMock(s, id, o),
  sources: () => mockSources,
  statements: () => mockStatements
}));
vi.mock('../../../stores/settings.svelte', () => ({
  settings: () => mockSettings,
  updateSettings: async (p: Record<string, unknown>) => { mockSettings = { ...mockSettings, ...p }; }
}));
vi.mock('../../../stores/notifications.svelte', () => ({
  pushNotification: (n: unknown) => pushMock(n),
  dismissNotification: (id: string) => dismissMock(id)
}));
vi.mock('../../../storage/kb-registry', () => ({ getCurrentKbId: () => 'kb-test' }));

const poll = await import('../currents-poll');

const def: CurrentDef = { slug: 'hn', sourceUrl: 'https://hnrss.org/frontpage', kind: 'rss', label: 'HN', cadenceMinutes: 60, enabled: true };
const item = (over: Record<string, unknown> = {}) => ({
  title: 'A story', url: 'https://example.com/a', currentSlug: 'hn', graphStableId: 'g1',
  sourceLabel: 'HN', fetchedAt: '2026-10-08T10:00:00Z', ...over
});

function defineCurrents(defs: CurrentDef[]) {
  mockStatements = currentsSettingsToStatements({ allowedTypes: [], currents: defs });
}
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', f);
  return f;
}
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

beforeEach(() => {
  poll.__resetCurrentsPollForTest();
  mockSources = []; mockStatements = [];
  mockSettings = { n8nBaseUrl: 'https://n8n.test.example', kbStableId: 'g1' };
  addStatementsMock.mockClear(); pushMock.mockClear(); dismissMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('runCurrentsSweep', () => {
  it('makes no request when n8n is not configured', async () => {
    mockSettings = {}; defineCurrents([def]);
    const f = fakeFetch(() => json([]));
    expect(await poll.runCurrentsSweep()).toEqual({ status: 'skipped', reason: 'no-n8n' });
    expect(f).not.toHaveBeenCalled();
  });

  it('makes no request when no enabled current exists', async () => {
    defineCurrents([{ ...def, enabled: false }]);
    const f = fakeFetch(() => json([]));
    expect(await poll.runCurrentsSweep()).toEqual({ status: 'skipped', reason: 'no-currents' });
    expect(f).not.toHaveBeenCalled();
  });

  it('registers once, fetches once per tick, and lands arrivals as origin "current"', async () => {
    defineCurrents([def]);
    const f = fakeFetch((url) => (url.includes('register') ? json({}) : json([item(), item({ title: 'B', url: 'https://example.com/b' })])));
    const r = await poll.runCurrentsSweep();
    expect(r).toMatchObject({ status: 'ok', fetched: 2, processed: 2 });
    expect(addStatementsMock).toHaveBeenCalledTimes(2);
    expect(addStatementsMock.mock.calls[0][2]).toEqual({ origin: 'current' });
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('register'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('reckons-currents-items'))).toHaveLength(1);

    await poll.runCurrentsSweep(); // second tick: no re-register, and the `since` cursor is sent
    const urls2 = f.mock.calls.map((c) => String(c[0]));
    expect(urls2.filter((u) => u.includes('register'))).toHaveLength(1);
    expect(urls2.at(-1)).toContain('since=2026-10-08T10%3A00%3A00Z');
  });

  it('drops items for undefined or disabled currents', async () => {
    defineCurrents([def, { ...def, slug: 'off', enabled: false }]);
    fakeFetch((url) => (url.includes('register') ? json({}) : json([item({ currentSlug: 'off' }), item({ currentSlug: 'gone' })])));
    const r = await poll.runCurrentsSweep();
    expect(r).toMatchObject({ status: 'ok', processed: 0, unknownSlug: 2 });
    expect(addStatementsMock).not.toHaveBeenCalled();
  });

  it('contains a failing n8n: no throw, one notification per outage, cursor not advanced', async () => {
    defineCurrents([def]);
    fakeFetch(() => new Response('nope', { status: 502 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r1 = await poll.runCurrentsSweep();
    const r2 = await poll.runCurrentsSweep();
    expect(r1.status).toBe('error');
    expect(r2.status).toBe('error');
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('reckons:currents-since:kb-test')).toBeNull();
    warn.mockRestore();
  });

  it('reports again after recovery and a second outage', async () => {
    defineCurrents([def]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let down = true;
    fakeFetch((url) => (down ? new Response('x', { status: 500 }) : url.includes('register') ? json({}) : json([])));
    await poll.runCurrentsSweep();
    down = false;
    expect((await poll.runCurrentsSweep()).status).toBe('ok');
    expect(dismissMock).toHaveBeenCalledWith('currents-n8n-unreachable');
    down = true;
    await poll.runCurrentsSweep();
    expect(pushMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('startCurrentsPolling', () => {
  it('runs a timer that makes no network call while unconfigured, and stops', async () => {
    vi.useFakeTimers();
    mockSettings = {};
    const f = fakeFetch(() => json([]));
    poll.startCurrentsPolling(50);
    poll.startCurrentsPolling(50); // idempotent
    await vi.advanceTimersByTimeAsync(200);
    poll.stopCurrentsPolling();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
