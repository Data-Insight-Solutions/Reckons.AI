/**
 * fetchCurrentDirect must REFUSE a tasks current rather than fail obscurely.
 *
 * The browser fallback parses RSS/Atom XML. Pointing it at Google Tasks fails twice over — no
 * OAuth credential, and nothing resembling a feed — and the generic path reports "could not
 * parse as RSS/Atom", which names the symptom and buries the cause. A user reading that would
 * go looking for a broken feed URL that was never a feed.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchCurrentDirect } from '../currents-sync';
import type { CurrentDef } from '../../../rdf/currents';

const def: CurrentDef = {
  slug: 'google-tasks',
  sourceUrl: 'https://tasks.google.com/',
  kind: 'tasks',
  label: 'Google Tasks capture',
  cadenceMinutes: 5,
  enabled: true,
};

describe('fetchCurrentDirect with a tasks current', () => {
  it('refuses, and says why, without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchCurrentDirect(def, 'graph-1')).rejects.toThrow(/tasks current/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('points at the fix rather than just reporting the failure', async () => {
    // An error that does not name the workflow leaves the user guessing at a setup step they
    // have no way to discover.
    await expect(fetchCurrentDirect(def, 'graph-1')).rejects.toThrow(
      /google-tasks-current\.workflow\.json/,
    );
  });

  it('explains the constraint — no push channel — not just the symptom', async () => {
    await expect(fetchCurrentDirect(def, 'graph-1')).rejects.toThrow(/no push channel/i);
  });
});
