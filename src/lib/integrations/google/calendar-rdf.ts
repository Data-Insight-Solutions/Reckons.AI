/**
 * Bidirectional conversion between Google Calendar events and RDF statements.
 *
 * Events → Statements (import):
 *   Each event becomes a SINGLE node with literal-only properties.
 *   The calendar itself is a hub node that all its events link to.
 *   Title/description text is matched against existing KB entities to create connections.
 *
 * Statements → Events (export):
 *   Any KB subject with a scheduled-at or due-at predicate can be pushed
 *   to Google Calendar as an event in the Reckons.AI KB calendar.
 */

import type { Statement } from '$lib/rdf/types';
import type { CalendarEvent, CalendarEventInput } from './calendar';
import { v4 as uuid } from 'uuid';
import { findRelatedEntities } from '$lib/rdf/event-linker';
import { parseRRule, extractRRuleFromRecurrence, detectRecurrenceFromInstances } from '$lib/rdf/recurrence';

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
    datatype: 'http://www.w3.org/2001/XMLSchema#string' as string | undefined,
    lang: undefined as string | undefined
  };
}

/**
 * Convert an array of Google Calendar events into pending RDF statements.
 * Creates a hub node for the calendar and single nodes per event.
 */
export function eventsToStatements(
  events: CalendarEvent[],
  sourceId: string,
  calendarId: string,
  existingStatements?: Statement[]
): Statement[] {
  const now = Date.now();
  const stmts: Statement[] = [];
  const g = iri(`urn:kbase:source/${sourceId}`);

  // Calendar hub node
  const calendarIri = `urn:kbase:calendar/${encodeURIComponent(calendarId)}`;
  stmts.push({
    id: uuid(),
    s: iri(calendarIri),
    p: iri(RDFS_LABEL),
    o: lit(calendarId),
    g,
    sourceId,
    confidence: 1.0,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  });
  stmts.push({
    id: uuid(),
    s: iri(calendarIri),
    p: iri(`${M}type`),
    o: lit('Calendar'),
    g,
    sourceId,
    confidence: 1.0,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  });

  for (const ev of events) {
    const subject = iri(`urn:kbase:event/${ev.id}`);

    function add(predicate: string, object: ReturnType<typeof iri> | ReturnType<typeof lit>) {
      stmts.push({
        id: uuid(),
        s: subject,
        p: iri(predicate),
        o: object,
        g,
        sourceId,
        confidence: 1.0,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
    }

    // Core identity
    add(RDFS_LABEL, lit(ev.summary));
    add(`${M}type`, lit('CalendarEvent'));

    // Link to calendar hub (graph connection — renders as edge)
    add(`${P}from-calendar`, iri(calendarIri));

    // Metadata (shown in detail panel, not as graph edges)
    const start = ev.start.dateTime ?? ev.start.date;
    const end = ev.end.dateTime ?? ev.end.date;
    if (start) add(`${M}scheduled-at`, lit(start));
    if (end) add(`${M}ends-at`, lit(end));
    const desc = ev.description?.trim();
    if (desc) add(`${M}description`, lit(desc));
    const loc = ev.location?.trim();
    if (loc) add(`${M}location`, lit(loc));

    // Attendees as metadata
    const attendees = ev.attendees ?? [];
    if (attendees.length > 0) {
      add(`${M}attendees`, lit(attendees.map(a => a.displayName || a.email).join(', ')));
    }

    // Recurrence from master event RRULE
    if (ev.recurrence?.length) {
      const rruleStr = extractRRuleFromRecurrence(ev.recurrence);
      if (rruleStr) {
        const rec = parseRRule(rruleStr);
        add(`${M}recurrence-rule`, lit(rruleStr));
        add(`${M}recurrence-frequency`, lit(rec.frequency));
        add(`${M}recurrence-pattern`, lit(rec.description));
        if (rec.interval > 1) add(`${M}recurrence-interval`, lit(String(rec.interval)));
        if (rec.byDay?.length) add(`${M}recurrence-days`, lit(rec.byDay.join(',')));
        if (rec.until) add(`${M}recurrence-until`, lit(rec.until));
        if (rec.count) add(`${M}recurrence-count`, lit(String(rec.count)));
      }
    }

    // Link to recurring master if this is an expanded instance
    if (ev.recurringEventId) {
      add(`${P}recurring-master`, iri(`urn:kbase:event/${ev.recurringEventId}`));
      add(`${M}is-recurring-instance`, lit('true'));
    }

    // Find connections to existing KB entities from title/description (graph edges)
    if (existingStatements) {
      const text = [ev.summary, desc ?? ''].join(' ');
      const related = findRelatedEntities(text, existingStatements);
      for (const entityIri of related) {
        add(`${P}related-to`, iri(entityIri));
      }
    }
  }

  // Detect recurrence patterns from expanded instances (when no RRULE available)
  const needsDetection = events.filter(e => !e.recurrence?.length);
  if (needsDetection.length >= 3) {
    const detected = detectRecurrenceFromInstances(
      needsDetection.map(e => ({
        summary: e.summary,
        start: new Date(e.start.dateTime ?? e.start.date ?? '')
      }))
    );
    // Apply detected patterns to events that lack explicit recurrence
    for (const ev of needsDetection) {
      const key = ev.summary.trim().toLowerCase();
      const rec = detected.get(key);
      if (rec) {
        const subject = iri(`urn:kbase:event/${ev.id}`);
        stmts.push({
          id: uuid(),
          s: subject,
          p: iri(`${M}recurrence-frequency`),
          o: lit(rec.frequency),
          g,
          sourceId,
          confidence: 0.8, // lower confidence for inferred patterns
          status: 'pending',
          createdAt: now,
          updatedAt: now
        });
        stmts.push({
          id: uuid(),
          s: subject,
          p: iri(`${M}recurrence-pattern`),
          o: lit(rec.description),
          g,
          sourceId,
          confidence: 0.8,
          status: 'pending',
          createdAt: now,
          updatedAt: now
        });
        stmts.push({
          id: uuid(),
          s: subject,
          p: iri(`${M}recurrence-detected`),
          o: lit('true'),
          g,
          sourceId,
          confidence: 0.8,
          status: 'pending',
          createdAt: now,
          updatedAt: now
        });
      }
    }
  }

  return stmts;
}

/**
 * Convert a subject's statement cluster into a Google Calendar event input.
 * Returns null if the subject has no temporal anchor (scheduled-at / due-at).
 * Writes a `reckonsSubject` extended property so we can round-trip back.
 */
export function statementsToEvent(
  subjectKey: string,
  stmts: Statement[]
): CalendarEventInput | null {
  const get = (pred: string): string | null => {
    const s = stmts.find(s => s.p.value === pred);
    return s ? s.o.value : null;
  };

  const scheduledAt = get(`${M}scheduled-at`) ?? get(`${P}scheduled-at`) ?? get(`${M}due-at`) ?? get(`${P}due-at`);
  if (!scheduledAt) return null;

  const label =
    get(RDFS_LABEL) ??
    subjectKey.split('/').pop() ??
    subjectKey;

  const endsAt = get(`${M}ends-at`) ?? get(`${P}ends-at`);
  const description = get(`${M}description`) ?? get(`${P}description`) ?? get(`${P}body`) ?? undefined;
  const location = get(`${M}location`) ?? get(`${P}location`) ?? undefined;

  const start = new Date(scheduledAt);
  const end = endsAt
    ? new Date(endsAt)
    : new Date(start.getTime() + 60 * 60 * 1000); // default 1 h

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    summary: label,
    description,
    location,
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    extendedProperties: {
      private: { reckonsSubject: subjectKey }
    }
  };
}
