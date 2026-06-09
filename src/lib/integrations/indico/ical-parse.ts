/**
 * Minimal iCal (.ics) parser — extracts VEVENT blocks into CalEvent objects.
 * Supports external iCal URLs (Google Calendar public links, Indico export, etc.)
 */

export interface ICalEvent {
  uid: string;
  summary: string;
  start: Date;
  end?: Date;
  description?: string;
  location?: string;
  url?: string;
  rrule?: string;
  exdates?: Date[];
}

/**
 * Fetch and parse an iCal URL. Works with any public .ics feed.
 * Tries direct fetch first; if CORS blocks it, falls back to a proxy.
 */
export async function fetchICalEvents(icalUrl: string): Promise<ICalEvent[]> {
  let text: string;
  try {
    const res = await fetch(icalUrl);
    if (!res.ok) throw new Error(`${res.status}`);
    text = await res.text();
  } catch {
    // CORS blocked — use corsproxy.io as fallback
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(icalUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`iCal fetch failed (via proxy): ${res.status}`);
    text = await res.text();
  }
  return parseICal(text);
}

/**
 * Parse iCal text content into events.
 */
export function parseICal(text: string): ICalEvent[] {
  const events: ICalEvent[] = [];
  // Unfold lines (RFC 5545: lines starting with space/tab are continuations)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  let inEvent = false;
  let current: Partial<ICalEvent> = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (current.summary && current.start) {
        events.push({
          uid: current.uid ?? `${Date.now()}-${events.length}`,
          summary: current.summary,
          start: current.start,
          end: current.end,
          description: current.description,
          location: current.location,
          url: current.url,
          rrule: current.rrule,
          exdates: current.exdates
        });
      }
      continue;
    }
    if (!inEvent) continue;

    const [key, ...rest] = line.split(':');
    const value = rest.join(':');
    const baseKey = key.split(';')[0];

    switch (baseKey) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.summary = unescapeIcal(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcal(value);
        break;
      case 'LOCATION':
        current.location = unescapeIcal(value);
        break;
      case 'URL':
        current.url = value;
        break;
      case 'DTSTART':
        current.start = parseICalDate(value, key);
        break;
      case 'DTEND':
        current.end = parseICalDate(value, key);
        break;
      case 'RRULE':
        current.rrule = value;
        break;
      case 'EXDATE':
        if (!current.exdates) current.exdates = [];
        current.exdates.push(parseICalDate(value, key));
        break;
    }
  }

  return events;
}

function parseICalDate(value: string, fullKey: string): Date {
  // Extract TZID if present
  const tzMatch = fullKey.match(/TZID=([^;:]+)/);

  // Format: 20250315T140000Z (UTC) or 20250315T140000 (local) or 20250315 (all-day)
  const clean = value.replace(/[^0-9T]/g, '');

  if (clean.length === 8) {
    // All-day: YYYYMMDD
    return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`);
  }

  const y = clean.slice(0, 4);
  const mo = clean.slice(4, 6);
  const d = clean.slice(6, 8);
  const h = clean.slice(9, 11) || '00';
  const mi = clean.slice(11, 13) || '00';
  const s = clean.slice(13, 15) || '00';

  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;

  if (value.endsWith('Z')) {
    return new Date(iso + 'Z');
  }

  // Without Z, treat as local time
  return new Date(iso);
}

function unescapeIcal(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
