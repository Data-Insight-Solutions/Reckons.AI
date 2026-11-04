import type { CurrentDef } from '../../rdf/currents';
import { fetchCurrentItems, processArrivals, registerCurrent } from './currents-sync';

export type CurrentsConnection = {
  enabled: boolean;
  baseUrl?: string;
  graphStableId?: string;
  currents: CurrentDef[];
};

type PollDependencies = {
  register: typeof registerCurrent;
  fetch: typeof fetchCurrentItems;
  process: typeof processArrivals;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  report: (error: unknown) => void;
};

// Five minutes, not one: the person's n8n monitor only collects every ~30 minutes, so a faster
// poll finds nothing new and costs them one request per minute per open tab. Consecutive
// failures back off exponentially (cap 30 min) so a down server is not hammered.
const INTERVAL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

function validDefinition(value: unknown): value is CurrentDef {
  if (!value || typeof value !== 'object') return false;
  const row = value as CurrentDef;
  return typeof row.slug === 'string' && !!row.slug && typeof row.sourceUrl === 'string' &&
    typeof row.label === 'string' && typeof row.enabled === 'boolean' &&
    Number.isFinite(row.cadenceMinutes) && ['rss', 'url', 'topic', 'tasks'].includes(row.kind);
}

/**
 * One browser connection to the optional n8n monitor. The app owns its lifetime and passes a
 * fixed snapshot, so an endpoint edit cannot send the second half of a sweep to another server.
 * No direct-feed fallback: enabling n8n does not authorize requests to other destinations.
 */
export function startCurrentsPolling(
  connection: CurrentsConnection,
  overrides: Partial<PollDependencies> = {},
): () => void {
  const baseUrl = connection.baseUrl?.trim().replace(/\/+$/, '');
  const graphStableId = connection.graphStableId;
  if (!connection.enabled || !baseUrl || !graphStableId) return () => {};

  const deps: PollDependencies = {
    register: registerCurrent,
    fetch: fetchCurrentItems,
    process: processArrivals,
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    },
    report: (error) => console.warn('[currents] delivery failed:', error),
    ...overrides,
  };
  const definitions = connection.currents.map((def) => ({ ...def }));
  const key = `reckons-currents-registrations:${JSON.stringify([baseUrl, graphStableId])}`;
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Successful registrations are cached only for this mounted connection. On reopening the app
  // we reconcile again, including definitions removed while it was disconnected.
  const registered = new Map<string, string>();

  async function sweep() {
    lifetime.signal.throwIfAborted();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const options = { baseUrl, signal };
    const raw: unknown = JSON.parse(deps.storage.getItem(key) ?? '[]');
    if (!Array.isArray(raw) || !raw.every(validDefinition)) {
      throw new Error('Currents registration history is unreadable; reconnect after repairing local storage.');
    }
    const known = new Map<string, CurrentDef>(raw.map((def) => [def.slug, def]));
    const desired = new Map(definitions.map((def) => [def.slug, def]));
    const save = () => deps.storage.setItem(key, JSON.stringify([...known.values()]));

    // Removing or renaming a current must stop its old remote schedule. Remember attempts before
    // posting: a server may commit a registration even if the browser loses the response.
    for (const old of known.values()) {
      if (desired.has(old.slug)) continue;
      await deps.register({ ...old, enabled: false }, graphStableId!, options);
      signal.throwIfAborted();
      known.delete(old.slug);
      registered.delete(old.slug);
      save();
    }
    for (const def of definitions) {
      const signature = JSON.stringify(def);
      if (registered.get(def.slug) === signature) continue;
      known.set(def.slug, def);
      save();
      await deps.register(def, graphStableId!, options);
      signal.throwIfAborted();
      registered.set(def.slug, signature);
      if (!def.enabled) { known.delete(def.slug); save(); }
    }

    const enabled = definitions.filter((def) => def.enabled);
    if (enabled.length === 0) return;
    // Do not advance a client-clock watermark: this endpoint has no completeness/page contract,
    // and late rows would disappear. Durable fact dedupe makes replay safe across reloads.
    const items = await deps.fetch(graphStableId!, undefined, options);
    signal.throwIfAborted();
    for (const def of enabled) {
      const arrivals = items.filter((item) => item.graphStableId === graphStableId && item.currentSlug === def.slug);
      if (arrivals.length) await deps.process(arrivals, def, graphStableId!, signal);
      signal.throwIfAborted();
    }
  }

  let failures = 0;
  async function tick() {
    try {
      // Two tabs share the ledger. Serializing the sweep prevents a stale read from losing a
      // pending removal; statement persistence also independently protects reviewed facts.
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(key, { signal: lifetime.signal }, sweep);
      } else {
        await sweep();
      }
      failures = 0;
    } catch (error) {
      failures++;
      if (!lifetime.signal.aborted) deps.report(error);
    } finally {
      // Schedule after completion, so a slow server never creates overlapping polls.
      if (!lifetime.signal.aborted) timer = setTimeout(() => void tick(), Math.min(INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS));
    }
  }
  void tick();
  return () => {
    lifetime.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
