/**
 * "A cut is never silent": when an import or export has to set facts aside, tell the person,
 * not just the console. Lives beside the rdf code so EVERY caller of importTurtleFull and of the
 * serializers is covered without each remembering to check a result field.
 *
 * The notifications store is imported lazily so pure rdf code (and SSR/node tests) never pull a
 * rune store in unless something was actually cut. Failure to notify never breaks the import
 * or export itself — the console line is the fallback, not the first resort.
 */
export async function notifyDataCut(n: { id: string; title: string; body: string }): Promise<void> {
  try {
    const { pushNotification } = await import('../stores/notifications.svelte');
    pushNotification({ id: n.id, type: 'warn', title: n.title, body: n.body, important: true });
  } catch (e) {
    console.error('[cut-notice] could not show notification:', e);
  }
}

export function notifyImportQuarantine(name: string | undefined, count: number): Promise<void> {
  const file = name ? `"${name}"` : 'This file';
  return notifyDataCut({
    id: `quarantine:${name ?? 'file'}:${count}`,
    title: `${count} damaged fact${count === 1 ? '' : 's'} set aside`,
    body: `${file} was written by an older build that saved a plain value as if it were an entity, which other tools cannot read. ${count} fact${count === 1 ? ' was' : 's were'} set aside; everything else imported. The file itself was not changed.`,
  });
}

/** Autosave and sync serialize the same graph over and over; a fact that cannot be written would
 *  otherwise raise a fresh "important" notice on every save. Say it once per count per session. */
const announcedExportSkips = new Set<number>();

/** Tests only: a fresh "session". */
export function resetExportSkipNotices(): void {
  announcedExportSkips.clear();
}

export function notifyExportSkipped(count: number): Promise<void> {
  if (announcedExportSkips.has(count)) return Promise.resolve();
  announcedExportSkips.add(count);
  return notifyDataCut({
    id: `export-skipped:${count}`,
    title: `${count} fact${count === 1 ? '' : 's'} left out of this save`,
    body: `${count} fact${count === 1 ? ' has' : 's have'} an invalid subject (a value used as if it were an entity) and could not be written without making the whole file unreadable, so ${count === 1 ? 'it was' : 'they were'} left out of this export. They are still in your graph here.`,
  });
}
