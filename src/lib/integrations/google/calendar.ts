/**
 * Google Calendar API v3 helpers.
 * All write operations default to the dedicated "Reckons.AI KB" calendar
 * so user's personal calendars are never modified.
 */

import { getToken } from './auth';

const CAL = 'https://www.googleapis.com/calendar/v3';

export const KB_CALENDAR_NAME = 'Reckons.AI KB';

export type CalendarListEntry = {
  id: string;
  summary: string;
  description?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
};

export type EventDateTime = {
  dateTime?: string; // RFC 3339 with timezone offset
  date?: string;     // All-day: YYYY-MM-DD
  timeZone?: string;
};

export type CalendarEvent = {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: EventDateTime;
  end: EventDateTime;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  htmlLink?: string;
  recurrence?: string[];       // RRULE/RDATE/EXDATE strings on master events
  recurringEventId?: string;   // ID of the recurring master (on expanded instances)
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
};

export type CalendarEventInput = {
  summary: string;
  description?: string;
  location?: string;
  start: EventDateTime;
  end: EventDateTime;
  attendees?: { email: string }[];
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
};

async function calFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${CAL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      ...init.headers
    }
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Calendar API ${res.status}: ${body}`);
  }
  return res.json();
}

/** List all calendars the user has access to. */
export async function listCalendars(): Promise<CalendarListEntry[]> {
  const data = await calFetch('/users/me/calendarList');
  return data.items ?? [];
}

/**
 * Find the Reckons.AI KB calendar or create it if missing.
 * Returns the calendar ID. Safe to call repeatedly — only creates once.
 */
export async function findOrCreateKBCalendar(): Promise<string> {
  const cals = await listCalendars();
  const existing = cals.find(c => c.summary === KB_CALENDAR_NAME);
  if (existing) return existing.id;

  const created = await calFetch('/calendars', {
    method: 'POST',
    body: JSON.stringify({
      summary: KB_CALENDAR_NAME,
      description: 'Managed by Reckons.AI — scheduled knowledge base items and reminders.',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  });
  return created.id as string;
}

/** Fetch events from a calendar within a time range. */
export async function listEvents(
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '500'
  });
  const data = await calFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  );
  return (data.items ?? []).filter((e: CalendarEvent) => e.status !== 'cancelled');
}

/**
 * Fetch recurring event masters from a calendar within a time range.
 * Unlike listEvents, this returns the recurring master with its RRULE
 * instead of expanded individual instances.
 */
export async function listRecurringMasters(
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'false',
    maxResults: '500'
  });
  const data = await calFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  );
  return (data.items ?? []).filter(
    (e: CalendarEvent) => e.status !== 'cancelled' && e.recurrence && e.recurrence.length > 0
  );
}

export async function createEvent(
  calendarId: string,
  event: CalendarEventInput
): Promise<CalendarEvent> {
  return calFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(event)
  });
}

export async function updateEvent(
  calendarId: string,
  eventId: string,
  patch: Partial<CalendarEventInput>
): Promise<CalendarEvent> {
  return calFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  await calFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'DELETE'
  });
}
