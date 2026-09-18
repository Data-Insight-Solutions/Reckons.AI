/**
 * The 'tasks' current kind — capture rather than publication.
 *
 * An rss or url current watches something the world published. A tasks current watches
 * something YOU said: dictated into a phone or a note-taking ring, landing in Google Tasks.
 * It needs its own kind because it cannot be fetched the way the others are — the Google Tasks
 * API has no `watch` method and no push channel, so it is polled server-side by n8n with an
 * OAuth credential the browser does not hold.
 */
import { describe, it, expect } from 'vitest';
import {
  currentsSettingsToStatements,
  readCurrentsSettings,
  type CurrentsSettings,
} from '../currents';

const TASKS: CurrentsSettings = {
  allowedTypes: [],
  currents: [
    {
      slug: 'google-tasks',
      sourceUrl: 'https://tasks.google.com/',
      kind: 'tasks',
      label: 'Google Tasks capture',
      cadenceMinutes: 5,
      enabled: true,
    },
  ],
};

describe("currents 'tasks' kind", () => {
  it('round-trips through statements without being coerced to rss', () => {
    // KINDS gates what survives a read-back: a kind missing from that set silently becomes
    // the 'rss' default, which would send the poller to parse a task list as a feed.
    const back = readCurrentsSettings(
      currentsSettingsToStatements(TASKS).map((s) => ({ ...s, status: 'confirmed' as const })),
    );
    expect(back.currents[0].kind).toBe('tasks');
  });

  it('keeps its cadence, which is the only thing bounding capture freshness', () => {
    const back = readCurrentsSettings(
      currentsSettingsToStatements(TASKS).map((s) => ({ ...s, status: 'confirmed' as const })),
    );
    // With no push channel available, how stale a dictated note can be IS the cadence.
    expect(back.currents[0].cadenceMinutes).toBe(5);
  });

  it('still defaults an unknown kind to rss rather than accepting nonsense', () => {
    const statements = currentsSettingsToStatements(TASKS).map((s) =>
      s.p.value.endsWith('kind')
        ? { ...s, o: { kind: 'literal' as const, value: 'telepathy' }, status: 'confirmed' as const }
        : { ...s, status: 'confirmed' as const },
    );
    expect(readCurrentsSettings(statements).currents[0].kind).toBe('rss');
  });
});
