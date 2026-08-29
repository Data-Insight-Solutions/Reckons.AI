/**
 * App-level storage: the state that belongs to this BROWSER PROFILE rather than to any one graph.
 *
 * WHY THIS DATABASE EXISTS. Every other table in this project lives in the per-graph database
 * named by `resolveDbName()` (`?kb=` -> sessionStorage -> localStorage -> 'kbase'), which is
 * correct for statements, sources and settings: they ARE the graph. The workspace directory
 * handle is not. ONE folder holds ALL the graphs — `reckons-workspace/kbs/<graph>/` — so the
 * handle describes where this browser keeps its graphs, not what any graph contains.
 *
 * Storing it per-graph meant each graph carried a private copy, and a newly created graph carried
 * none: `loadWorkspace()` found no row, reported state 'none', and the user picked the same folder
 * again. Reported as "I'm constantly needing to reset reckons-workspace/ as sync directory"
 * (Matt, 2026-08-27) — and the more graphs you have, the more often it bites.
 *
 * A DIRECTORY HANDLE CANNOT COME FROM CONFIGURATION. Worth stating because the obvious fix is to
 * put the path in .env: the File System Access API only ever mints a FileSystemDirectoryHandle
 * from a user gesture, and there is no constructor that takes a path string. If there were, any
 * page could read any file on the disk. So the handle must be picked once and PERSISTED — which
 * makes where it is persisted the whole ballgame.
 */

import Dexie, { type Table } from 'dexie';
import type { WorkspaceRow } from './db';

/** Fixed, deliberately not derived from the active graph. That derivation was the bug. */
const APP_DB_NAME = 'kbase-app';

/** The single row id — one workspace per browser profile. */
const WORKSPACE_KEY = 'main';

export class AppDB extends Dexie {
  workspace!: Table<WorkspaceRow, string>;

  constructor(name = APP_DB_NAME) {
    super(name);
    this.version(1).stores({ workspace: 'id' });
  }
}

export const appDb = new AppDB();

/**
 * The stored workspace handle, adopting a per-graph one left by an older version.
 *
 * MIGRATION IS A READ, NOT A SWEEP. The old handle can only be reached through whichever
 * per-graph database happens to be open right now, so there is no way to enumerate and drain
 * every graph's copy — and no need to. The first graph that finds a legacy handle promotes it to
 * app level, and every graph afterwards reads it from there. Stale per-graph copies are simply
 * never consulted again; they are harmless, and deleting them would need the same enumeration
 * that is not available.
 */
/**
 * The minimum of a Dexie table this module needs. Declared so the migration can be tested with
 * plain in-memory fakes: a promotion that silently failed would reintroduce the very bug this
 * module exists to fix, and IndexedDB is not available in the unit-test environment.
 */
export type WorkspaceStore = {
  get(key: string): Promise<WorkspaceRow | undefined>;
  put(row: WorkspaceRow): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

/**
 * The app-level database can be unavailable — storage blocked, a private window, a browser that
 * refuses the second connection. That must DEGRADE to the old per-graph behaviour rather than
 * break the workspace outright: re-picking a folder on every graph is an annoyance, while failing
 * to connect at all loses the user their data path. Failures are logged, never swallowed silently.
 */
async function trySharedThenLegacy<T>(
  what: string,
  shared: () => Promise<T>,
  legacy: () => Promise<T>,
): Promise<T> {
  try {
    return await shared();
  } catch (err) {
    console.warn(`[app-db] ${what} fell back to per-graph storage:`, err);
    return await legacy();
  }
}

/**
 * A read-through view of the DEFAULT graph's workspace table, opened only when consulted.
 *
 * This is where a long-standing setup's handle actually lives, so it is the candidate that saves
 * the user a re-pick the first time they open a graph they just created. The connection is opened
 * and closed per call rather than held: this is consulted once at startup and never again in the
 * common case, and a permanently open second Dexie connection to another graph is a liability
 * (version upgrades on that database would block).
 */
export function defaultGraphWorkspaceStore(dbName = 'kbase'): WorkspaceStore {
  // NO SCHEMA IS DECLARED. `new Dexie(name).open()` adopts whatever version and stores the
  // database already has. Declaring `version(1).stores(...)` here would ask to open a graph that
  // is at version 8 as version 1 — a downgrade Dexie refuses, and the wrong thing to attempt on
  // the user's main graph when all this wants is to read one row and leave.
  const withDb = async <T>(fn: (store: WorkspaceStore) => Promise<T>): Promise<T> => {
    const other = new Dexie(dbName);
    try {
      await other.open();
      return await fn(other.table('workspace') as unknown as WorkspaceStore);
    } finally {
      other.close();
    }
  };
  return {
    get: (key) => withDb((s) => s.get(key)),
    put: (row) => withDb((s) => s.put(row)),
    delete: (key) => withDb((s) => s.delete(key)),
  };
}

/** The first candidate store holding a handle. A store that throws is skipped, not fatal. */
async function firstRow(stores: readonly WorkspaceStore[]): Promise<WorkspaceRow | undefined> {
  for (const store of stores) {
    try {
      const row = await store.get(WORKSPACE_KEY);
      if (row) return row;
    } catch {
      // An unopenable graph database is not a reason to abandon the search.
    }
  }
  return undefined;
}

export async function getWorkspaceRow(
  legacy?: WorkspaceStore | readonly WorkspaceStore[],
  shared: WorkspaceStore = appDb.workspace,
): Promise<WorkspaceRow | undefined> {
  // A NEWLY CREATED graph has no legacy handle of its own to promote, so adopting only from the
  // graph you happen to be looking at still made the user pick the folder again the first time
  // they opened a new graph. Callers therefore pass several candidates — this graph, then the
  // default graph where a long-standing setup usually lives.
  const candidates = legacy ? (Array.isArray(legacy) ? legacy : [legacy as WorkspaceStore]) : [];

  const current = await trySharedThenLegacy(
    'read',
    () => shared.get(WORKSPACE_KEY),
    async () => firstRow(candidates),
  );
  if (current) return current;

  const inherited = await firstRow(candidates);
  if (!inherited) return undefined;
  // Promote so the next graph — and the next new graph — finds it without a second pick.
  await trySharedThenLegacy(
    'promote',
    () => shared.put({ ...inherited, id: WORKSPACE_KEY }),
    async () => undefined,
  );
  return inherited;
}

export async function putWorkspaceRow(
  handle: FileSystemDirectoryHandle,
  name: string,
  legacy?: WorkspaceStore,
  shared: WorkspaceStore = appDb.workspace,
): Promise<void> {
  const row: WorkspaceRow = { id: WORKSPACE_KEY, handle, name };
  await trySharedThenLegacy(
    'write',
    () => shared.put(row),
    async () => (legacy ? legacy.put(row) : undefined),
  );
}

/**
 * Forget the workspace. Clears the app-level row AND the legacy per-graph row when one is passed:
 * a disconnect that left a legacy copy behind would silently reconnect on the next load, which
 * reads as the app ignoring the user.
 */
export async function clearWorkspaceRow(
  legacy?: WorkspaceStore | readonly WorkspaceStore[],
  shared: WorkspaceStore = appDb.workspace,
): Promise<void> {
  // Every copy, independently: a disconnect that left ANY of them behind would silently
  // reconnect on the next load, which reads as the app ignoring the user.
  await trySharedThenLegacy('clear', () => shared.delete(WORKSPACE_KEY), async () => undefined);
  const candidates = legacy ? (Array.isArray(legacy) ? legacy : [legacy as WorkspaceStore]) : [];
  for (const store of candidates) {
    try {
      await store.delete(WORKSPACE_KEY);
    } catch {
      // Already gone, or that graph's database will not open. Neither blocks the disconnect.
    }
  }
}
