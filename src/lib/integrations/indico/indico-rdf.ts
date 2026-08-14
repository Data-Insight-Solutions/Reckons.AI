/**
 * Convert Indico events to RDF statements for the KB.
 *
 * Each event becomes a SINGLE node with literal-only properties.
 * The Indico server calendar itself is a hub node that all events link to.
 * Title/description text is matched against existing KB entities to create connections.
 */

import type { Statement } from '$lib/rdf/types';
import type { IndicoEvent, IndicoDateTime } from './types';
import { v4 as uuid } from 'uuid';
import { findRelatedEntities } from '$lib/rdf/event-linker';
import { detectRecurrenceFromInstances } from '$lib/rdf/recurrence';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const P = 'urn:kbase:predicate/';  // graph connections (rendered as edges)
const M = 'urn:kbase:meta/';       // node metadata (shown in detail panel, not as edges)

function iri(value: string) {
  return { kind: 'iri' as const, value };
}
function lit(value: string) {
  return {
    kind: 'literal' as const,
    value,
    datatype: 'http://www.w3.org/2001/XMLSchema#string' as string | null,
    lang: null as string | null
  };
}

/**
 * Offset, in minutes, of `tz` at a given instant. Positive means ahead of UTC.
 * Derived from Intl rather than a timezone library — the data is already in the platform, and
 * the alternative is shipping a tzdata copy that goes stale.
 */
function zoneOffsetMinutes(instant: Date, tz: string): number | null {
  try {
    // 'en-CA' yields YYYY-MM-DD, so the parts reassemble into a parseable string.
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(instant).replace(', ', 'T').replace(/T24:/, 'T00:');
    return (Date.parse(`${s}Z`) - instant.getTime()) / 60_000;
  } catch {
    return null; // unknown zone id — caller falls back to a naive local reading
  }
}

/**
 * Indico reports a wall-clock date/time PLUS the zone it was rendered in, and that zone is the
 * CATEGORY's, not the event's — an event created in America/Los_Angeles comes back rendered in
 * the root category's US/Central unless `tz=` is passed. This used to return `${date}T${time}`,
 * throwing the zone away, so a 23:00 PDT deadline entered the graph as a bare "01:00" and every
 * imported event was silently off by the zone difference with nothing recording which zone it
 * had meant. (Measured 2026-07-31 against a live server: two hours.)
 *
 * Returning a UTC instant makes the value unambiguous, which is what a graph needs — two sources
 * describing one meeting must compare equal regardless of who exported them.
 */
function indicoDateTimeToISO(dt: IndicoDateTime): string {
  const naive = `${dt.date}T${dt.time}`;
  if (!dt.tz) return naive;

  // Read the wall clock as if UTC, then correct by the zone's offset at that instant. The second
  // pass matters only near a DST boundary, where the first guess can land on the wrong side.
  const guess = new Date(`${naive}Z`);
  if (Number.isNaN(guess.getTime())) return naive;

  let offset = zoneOffsetMinutes(guess, dt.tz);
  if (offset === null) return naive;
  const corrected = new Date(guess.getTime() - offset * 60_000);
  const settled = zoneOffsetMinutes(corrected, dt.tz);
  if (settled !== null && settled !== offset) offset = settled;

  return new Date(guess.getTime() - offset * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert Indico events into pending RDF statements.
 * Creates a hub node for the calendar and single nodes per event.
 */
export function indicoEventsToStatements(
  events: IndicoEvent[],
  sourceId: string,
  serverUrl: string,
  existingStatements?: Statement[]
): Statement[] {
  const now = Date.now();
  const stmts: Statement[] = [];
  const g = iri(`urn:kbase:source/${sourceId}`);

  // Calendar hub node
  const calendarIri = `urn:kbase:calendar/indico-${encodeURIComponent(serverUrl)}`;
  stmts.push({
    id: uuid(),
    s: iri(calendarIri) as any,
    p: iri(RDFS_LABEL) as any,
    o: lit(`Indico: ${serverUrl}`) as any,
    g: g as any,
    sourceId,
    confidence: 1.0,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  });
  stmts.push({
    id: uuid(),
    s: iri(calendarIri) as any,
    p: iri(`${M}type`) as any,
    o: lit('Calendar') as any,
    g: g as any,
    sourceId,
    confidence: 1.0,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  });

  for (const ev of events) {
    const subject = iri(`urn:kbase:indico-event/${ev.id}`);

    function add(predicate: string, object: ReturnType<typeof iri> | ReturnType<typeof lit>) {
      stmts.push({
        id: uuid(),
        s: subject as any,
        p: iri(predicate) as any,
        o: object as any,
        g: g as any,
        sourceId,
        confidence: 1.0,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
    }

    // Core identity
    add(RDFS_LABEL, lit(ev.title));
    add(`${M}type`, lit('CalendarEvent'));
    add(`${M}event-source`, lit('Indico'));
    add(`${M}indico-event-id`, lit(ev.id));

    // Link to calendar hub (graph connection — renders as edge)
    add(`${P}from-calendar`, iri(calendarIri));

    // Metadata (shown in detail panel, not as graph edges)
    if (ev.startDate) add(`${M}scheduled-at`, lit(indicoDateTimeToISO(ev.startDate)));
    if (ev.endDate) add(`${M}ends-at`, lit(indicoDateTimeToISO(ev.endDate)));
    if (ev.description?.trim()) add(`${M}description`, lit(ev.description.trim()));
    if (ev.location?.trim()) add(`${M}location`, lit(ev.location.trim()));
    if (ev.category) add(`${M}category`, lit(ev.category));
    if (ev.type) add(`${M}event-type`, lit(ev.type));
    if (ev.url) add(`${M}url`, lit(ev.url));

    // Organizers/speakers as metadata
    const contacts = [...(ev.organizers ?? []), ...(ev.speakers ?? [])];
    if (contacts.length > 0) {
      add(`${M}organizers`, lit(contacts.map(c => c.name).join(', ')));
    }

    // Find connections to existing KB entities from title/description (graph edges)
    if (existingStatements) {
      const text = [ev.title, ev.description ?? ''].join(' ');
      const related = findRelatedEntities(text, existingStatements);
      for (const entityIri of related) {
        add(`${P}related-to`, iri(entityIri));
      }
    }
  }

  // Detect recurrence patterns from event groups with similar titles
  if (events.length >= 3) {
    const detected = detectRecurrenceFromInstances(
      events
        .filter(e => e.startDate)
        .map(e => ({
          summary: e.title,
          start: new Date(indicoDateTimeToISO(e.startDate))
        }))
    );
    for (const ev of events) {
      const key = ev.title.trim().toLowerCase();
      const rec = detected.get(key);
      if (rec) {
        const subject = iri(`urn:kbase:indico-event/${ev.id}`);

        function addRec(predicate: string, object: ReturnType<typeof iri> | ReturnType<typeof lit>) {
          stmts.push({
            id: uuid(),
            s: subject as any,
            p: iri(predicate) as any,
            o: object as any,
            g: g as any,
            sourceId,
            confidence: 0.8,
            status: 'pending',
            createdAt: now,
            updatedAt: now
          });
        }

        addRec(`${M}recurrence-frequency`, lit(rec.frequency));
        addRec(`${M}recurrence-pattern`, lit(rec.description));
        addRec(`${M}recurrence-detected`, lit('true'));
      }
    }
  }

  return stmts;
}
