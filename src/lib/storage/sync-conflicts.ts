/**
 * Sync-service conflict copies (F56.2) — two files that claim to be the same space.
 *
 * Matt, 2026-09-30: do not rebuild file sync; let an existing service (OneDrive, iCloud Drive,
 * Dropbox, Google Drive for desktop, Syncthing) sync the workspace folder. When two devices edit the
 * same space before the service catches up, the service keeps BOTH versions under a new name —
 * OneDrive appends the machine name, Dropbox writes "(… conflicted copy …)", iCloud " 2", Google
 * Drive " (1)", Syncthing ".sync-conflict-…". Workspace discovery reads every .ttl, and the copy
 * carries the SAME kbStableId as the original, so until 2026-09-30 it was imported over the real
 * space or listed as a second one, silently.
 *
 * The space id is the reliable signal, not the filename: two files with one stable id are a
 * conflict, whatever the service called the copy. One is kept — the conventional
 * kbs/<name>/<name>.ttl, else a name without conflict markers, else the shortest path — and the
 * others are reported, never imported and never deleted. Which edits to keep is the person's call.
 */

export type DiscoveredSpace = { folderName: string; path: string[]; meta: { name: string; stableId?: string } };

export type SyncConflict = { stableId: string; kept: string; copies: string[] };

/** Filename fragments sync services add to a conflict copy. Used only to choose which file to keep. */
const CONFLICT_MARKERS = /(conflicted copy|\.sync-conflict-|-[A-Z0-9-]{4,}\.ttl$| \(\d+\)\.ttl$| \d+\.ttl$)/i;

function isConventional(s: DiscoveredSpace): boolean {
  const [top] = s.path;
  const file = s.path.at(-1) ?? '';
  const dir = s.path.at(-2) ?? '';
  return top === 'kbs' && (file === `${dir}.ttl` || file === 'kb.ttl');
}

function rank(s: DiscoveredSpace): [number, number, number, string] {
  const joined = s.path.join('/');
  return [isConventional(s) ? 0 : 1, CONFLICT_MARKERS.test(s.path.at(-1) ?? '') ? 1 : 0, joined.length, joined];
}

function compare(a: DiscoveredSpace, b: DiscoveredSpace): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
}

/** Keep one file per stable id; report the rest. Files without a stable id are never grouped. */
export function separateConflictCopies(found: DiscoveredSpace[]): { kept: DiscoveredSpace[]; conflicts: SyncConflict[] } {
  const byId = new Map<string, DiscoveredSpace[]>();
  const kept: DiscoveredSpace[] = [];
  for (const s of found) {
    const id = s.meta.stableId;
    if (!id) kept.push(s);
    else byId.set(id, [...(byId.get(id) ?? []), s]);
  }
  const conflicts: SyncConflict[] = [];
  for (const [stableId, group] of byId) {
    const sorted = [...group].sort(compare);
    kept.push(sorted[0]);
    if (sorted.length > 1) conflicts.push({ stableId, kept: sorted[0].path.join('/'), copies: sorted.slice(1).map((s) => s.path.join('/')) });
  }
  // Discovery order, so callers see the same order as before for everything that was not a conflict.
  const order = new Map(found.map((s, i) => [s, i]));
  kept.sort((a, b) => order.get(a)! - order.get(b)!);
  return { kept, conflicts };
}

export function conflictNotice(c: SyncConflict): string {
  return `${c.copies.length + 1} files claim to be the same space — usually a sync service keeping both sides of an edit made on two devices. Using ${c.kept}; not imported: ${c.copies.join(', ')}. Open them and keep the edits you want; nothing was deleted.`;
}
