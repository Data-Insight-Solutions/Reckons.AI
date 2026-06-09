/**
 * Indico sync logic — handles fetching events, converting to RDF, and force-sync.
 * Also handles the ?indico=<url> query parameter for initial setup.
 */

import { createIndicoClient } from './client';
import { indicoEventsToStatements } from './indico-rdf';
import type { IndicoEvent } from './types';
import type { Statement } from '$lib/rdf/types';

export interface SyncResult {
  events: IndicoEvent[];
  statementsCount: number;
  sourceId: string;
}

/**
 * Parse ?indico=<url> from the current page URL.
 * Returns the server URL if present, null otherwise.
 */
export function parseIndicoQueryParam(url: URL): string | null {
  return url.searchParams.get('indico') || null;
}

/**
 * Fetch events from the configured Indico server and return RDF-ready statements.
 */
export async function syncIndicoEvents(
  serverUrl: string,
  apiToken?: string,
  categoryId?: string,
  existingStatements?: Statement[]
): Promise<SyncResult> {
  const client = createIndicoClient(serverUrl, apiToken);
  if (!client) throw new Error('Invalid Indico server URL');

  const events = await client.forceSync(categoryId);
  const sourceId = `indico-${Date.now()}`;
  const stmts = indicoEventsToStatements(events, sourceId, serverUrl, existingStatements);

  return {
    events,
    statementsCount: stmts.length,
    sourceId
  };
}

/**
 * Full sync: fetch events, create source, return statements ready for addStatements().
 */
export async function performIndicoSync(
  serverUrl: string,
  apiToken?: string,
  categoryId?: string,
  existingStatements?: Statement[]
) {
  const client = createIndicoClient(serverUrl, apiToken);
  if (!client) throw new Error('Invalid Indico server URL');

  const events = await client.forceSync(categoryId);
  const sourceId = `indico-sync-${Date.now()}`;

  const source = {
    id: sourceId,
    title: `Indico — ${events.length} event${events.length !== 1 ? 's' : ''}`,
    uri: serverUrl,
    kind: 'calendar' as const,
    trustLevel: 'review' as const,
    ingestedAt: Date.now()
  };

  const statements = indicoEventsToStatements(events, sourceId, serverUrl, existingStatements);

  return { source, statements, events };
}
