import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentDef } from '../../../rdf/currents';
import type { CurrentItem } from '../../../rdf/current-ranking';
import type { registerCurrent, fetchCurrentItems, processArrivals } from '../currents-sync';

vi.mock('../currents-sync', () => ({
  registerCurrent: vi.fn(), fetchCurrentItems: vi.fn(), processArrivals: vi.fn(),
}));
const { startCurrentsPolling } = await import('../currents-poll');

const def: CurrentDef = { slug: 'news', label: 'News', kind: 'rss', sourceUrl: 'https://example.com/feed', cadenceMinutes: 60, enabled: true };
const config = { enabled: true, baseUrl: 'https://automation.example', graphStableId: 'space-a', currents: [def] };
const item: CurrentItem = { title: 'Article', url: 'https://example.com/article', currentSlug: 'news', graphStableId: 'space-a', fetchedAt: '2026-10-12T00:00:00Z' };
let stops: Array<() => void>;
let journal: Map<string, string>;
let register = vi.fn<typeof registerCurrent>();
let fetchItems = vi.fn<typeof fetchCurrentItems>();
let process = vi.fn<typeof processArrivals>();
let report = vi.fn<(error: unknown) => void>();

function start(patch: Partial<typeof config> = {}) {
  const stop = startCurrentsPolling({ ...config, ...patch }, {
    register, fetch: fetchItems, process, report,
    storage: { getItem: (key) => journal.get(key) ?? null, setItem: (key, value) => { journal.set(key, value); } },
  });
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
  journal = new Map();
  register = vi.fn(async () => {});
  fetchItems = vi.fn(async () => [item]);
  process = vi.fn(async () => ({ processed: 1, skipped: 0, statementCount: 3 }));
  report = vi.fn();
});
afterEach(() => { stops.forEach((stop) => stop()); vi.useRealTimers(); });

describe('Currents connection lifecycle', () => {
  it('does nothing until the user enables a configured connection', async () => {
    start({ enabled: false });
    start({ baseUrl: '' });
    start({ graphStableId: '' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(register).not.toHaveBeenCalled();
    expect(fetchItems).not.toHaveBeenCalled();
  });

  it('registers saved definitions and delivers only rows for enabled currents in this space', async () => {
    const off = { ...def, slug: 'disabled', enabled: false };
    fetchItems.mockResolvedValue([item, { ...item, graphStableId: 'space-b' }, { ...item, currentSlug: 'unknown' }, { ...item, currentSlug: 'disabled' }]);
    start({ currents: [def, off] });
    await vi.advanceTimersByTimeAsync(0);
    expect(register).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenCalledWith([item], def, 'space-a', expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(register).toHaveBeenCalledTimes(2);
    expect(fetchItems).toHaveBeenCalledTimes(2);
  });

  it('disables a removed remote definition after restarting, without fetching disabled streams', async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    register.mockClear();
    fetchItems.mockClear();
    start({ currents: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(register).toHaveBeenCalledWith({ ...def, enabled: false }, 'space-a', expect.objectContaining({ baseUrl: config.baseUrl }));
    expect(fetchItems).not.toHaveBeenCalled();
    expect(JSON.parse([...journal.values()][0])).toEqual([]);
  });

  it('retains ambiguous registrations and retries their removal after a failed response', async () => {
    register.mockRejectedValueOnce(new Error('connection lost'));
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(fetchItems).not.toHaveBeenCalled();
    stop();
    start({ currents: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(register).toHaveBeenLastCalledWith({ ...def, enabled: false }, 'space-a', expect.anything());
  });

  it('contains remote failures and retries on the next interval', async () => {
    fetchItems.mockRejectedValueOnce(new Error('offline'));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000); // backed off: one failure doubles the wait
    expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('never overlaps polls, aborts in flight and discards responses arriving after teardown', async () => {
    let resolve!: (items: CurrentItem[]) => void;
    fetchItems.mockImplementation(() => new Promise<CurrentItem[]>((r) => { resolve = r; }));
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchItems).toHaveBeenCalledTimes(1);
    const signal = fetchItems.mock.calls[0][2]!.signal as AbortSignal;
    stop();
    expect(signal.aborted).toBe(true);
    resolve([item]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(process).not.toHaveBeenCalled();
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('keeps registration history scoped to its endpoint and space', async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    register.mockClear();
    start({ baseUrl: 'https://different.example', currents: [] });
    start({ graphStableId: 'space-b', currents: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(register).not.toHaveBeenCalled();
  });
});
