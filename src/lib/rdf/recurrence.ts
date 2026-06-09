/**
 * RRULE parser and recurrence pattern detection.
 *
 * Handles two cases:
 * 1. Explicit RRULE strings from iCal/Google Calendar recurring masters
 * 2. Pattern detection from groups of expanded event instances
 */

export type RecurrenceInfo = {
  /** Original RRULE string (if available) */
  rrule?: string;
  /** DAILY, WEEKLY, MONTHLY, YEARLY */
  frequency: string;
  /** Every N intervals (e.g. 2 = every other week) */
  interval: number;
  /** Days of week for WEEKLY: MO, TU, WE, TH, FR, SA, SU */
  byDay?: string[];
  /** Day of month for MONTHLY (e.g. 15) */
  byMonthDay?: number[];
  /** Human-readable description */
  description: string;
  /** End date or count, if bounded */
  until?: string;
  count?: number;
};

const DAY_NAMES: Record<string, string> = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
  FR: 'Friday', SA: 'Saturday', SU: 'Sunday'
};

/**
 * Parse an RRULE string into structured RecurrenceInfo.
 * Example: "FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1"
 */
export function parseRRule(rrule: string): RecurrenceInfo {
  const clean = rrule.replace(/^RRULE:/i, '');
  const parts = new Map<string, string>();
  for (const part of clean.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) parts.set(k.toUpperCase(), v);
  }

  const frequency = parts.get('FREQ') ?? 'UNKNOWN';
  const interval = parseInt(parts.get('INTERVAL') ?? '1', 10);
  const byDay = parts.get('BYDAY')?.split(',');
  const byMonthDay = parts.get('BYMONTHDAY')?.split(',').map(Number);
  const until = parts.get('UNTIL');
  const count = parts.get('COUNT') ? parseInt(parts.get('COUNT')!, 10) : undefined;

  const description = buildDescription(frequency, interval, byDay, byMonthDay, until, count);

  return { rrule: clean, frequency, interval, byDay, byMonthDay, description, until, count };
}

function buildDescription(
  frequency: string,
  interval: number,
  byDay?: string[],
  byMonthDay?: number[],
  until?: string,
  count?: number
): string {
  const parts: string[] = [];

  switch (frequency) {
    case 'DAILY':
      parts.push(interval === 1 ? 'Daily' : `Every ${interval} days`);
      break;
    case 'WEEKLY':
      if (interval === 1) {
        parts.push('Weekly');
      } else if (interval === 2) {
        parts.push('Every other week');
      } else {
        parts.push(`Every ${interval} weeks`);
      }
      if (byDay?.length) {
        const dayNames = byDay.map(d => DAY_NAMES[d.replace(/[^A-Z]/g, '')] ?? d);
        parts.push(`on ${dayNames.join(', ')}`);
      }
      break;
    case 'MONTHLY':
      parts.push(interval === 1 ? 'Monthly' : `Every ${interval} months`);
      if (byMonthDay?.length) {
        parts.push(`on day ${byMonthDay.join(', ')}`);
      }
      if (byDay?.length) {
        // e.g. "2TU" = second Tuesday
        const dayDescs = byDay.map(d => {
          const match = d.match(/^(-?\d+)?([A-Z]{2})$/);
          if (!match) return d;
          const [, nth, day] = match;
          const dayName = DAY_NAMES[day] ?? day;
          if (!nth) return dayName;
          const n = parseInt(nth, 10);
          const ordinal = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n === -1 ? 'last' : `${n}th`;
          return `${ordinal} ${dayName}`;
        });
        parts.push(`on the ${dayDescs.join(', ')}`);
      }
      break;
    case 'YEARLY':
      parts.push(interval === 1 ? 'Yearly' : `Every ${interval} years`);
      break;
    default:
      parts.push(`Repeats (${frequency})`);
  }

  if (until) {
    const d = parseRRuleDate(until);
    if (d) parts.push(`until ${d.toLocaleDateString()}`);
  }
  if (count) {
    parts.push(`(${count} occurrences)`);
  }

  return parts.join(' ');
}

function parseRRuleDate(value: string): Date | null {
  const clean = value.replace(/[^0-9]/g, '');
  if (clean.length < 8) return null;
  return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`);
}

/**
 * Detect recurrence patterns from a group of expanded event instances.
 * Useful when we only have singleEvents=true (expanded) without the RRULE.
 *
 * Groups events by title, then analyzes date gaps to infer frequency.
 * Requires at least 3 instances to detect a pattern.
 */
export function detectRecurrenceFromInstances(
  events: { summary: string; start: Date }[]
): Map<string, RecurrenceInfo> {
  const result = new Map<string, RecurrenceInfo>();

  // Group by normalized title
  const groups = new Map<string, Date[]>();
  for (const ev of events) {
    const key = ev.summary.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev.start);
  }

  for (const [title, dates] of groups) {
    if (dates.length < 3) continue;

    // Sort chronologically
    dates.sort((a, b) => a.getTime() - b.getTime());

    // Calculate gaps in days
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 60 * 60 * 24)));
    }

    const info = inferFrequency(gaps, dates);
    if (info) result.set(title, info);
  }

  return result;
}

function inferFrequency(gaps: number[], dates: Date[]): RecurrenceInfo | null {
  if (gaps.length === 0) return null;

  const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  // Allow 20% variance for "consistent" gaps
  const consistent = gaps.every(g => Math.abs(g - median) <= Math.max(median * 0.2, 1));

  if (!consistent) return null;

  if (median === 1) {
    return { frequency: 'DAILY', interval: 1, description: 'Daily' };
  }
  if (median >= 6 && median <= 8) {
    // Check if same day of week
    const days = new Set(dates.map(d => d.getDay()));
    if (days.size === 1) {
      const dayCode = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][dates[0].getDay()];
      return {
        frequency: 'WEEKLY',
        interval: 1,
        byDay: [dayCode],
        description: `Weekly on ${DAY_NAMES[dayCode]}`
      };
    }
    return { frequency: 'WEEKLY', interval: 1, description: 'Weekly' };
  }
  if (median >= 13 && median <= 15) {
    return { frequency: 'WEEKLY', interval: 2, description: 'Every other week' };
  }
  if (median >= 28 && median <= 31) {
    // Check if same day of month
    const monthDays = new Set(dates.map(d => d.getDate()));
    if (monthDays.size === 1) {
      const day = dates[0].getDate();
      return {
        frequency: 'MONTHLY',
        interval: 1,
        byMonthDay: [day],
        description: `Monthly on day ${day}`
      };
    }
    return { frequency: 'MONTHLY', interval: 1, description: 'Monthly' };
  }
  if (median >= 360 && median <= 370) {
    return { frequency: 'YEARLY', interval: 1, description: 'Yearly' };
  }

  // Non-standard interval in days
  if (median > 1 && median < 7) {
    return {
      frequency: 'DAILY',
      interval: median,
      description: `Every ${median} days`
    };
  }

  return null;
}

/**
 * Extract RRULE strings from a Google Calendar recurrence array.
 * The array may contain RRULE, RDATE, and EXDATE entries.
 */
export function extractRRuleFromRecurrence(recurrence: string[]): string | null {
  for (const entry of recurrence) {
    if (entry.startsWith('RRULE:')) {
      return entry.slice(6);
    }
  }
  return null;
}

const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6
};

/**
 * Expand an RRULE into individual occurrence dates within [windowStart, windowEnd].
 * The `dtstart` is the original event start time; occurrences preserve the same
 * hour/minute but shift the date according to the rule.
 *
 * Returns at most `maxOccurrences` dates (default 200) to prevent runaway expansion.
 */
export function expandRRule(
  rrule: string,
  dtstart: Date,
  windowStart: Date,
  windowEnd: Date,
  exdates?: Date[],
  maxOccurrences = 200
): Date[] {
  const info = parseRRule(rrule);
  const results: Date[] = [];
  const exSet = new Set(exdates?.map(d => d.toDateString()) ?? []);
  const limitByCount = info.count ?? Infinity;
  const untilDate = info.until ? parseRRuleDate(info.until) : null;
  const effectiveEnd = untilDate && untilDate < windowEnd ? untilDate : windowEnd;

  let totalEmitted = 0;

  if (info.frequency === 'WEEKLY' && info.byDay?.length) {
    // WEEKLY with BYDAY — iterate week by week, emit matching days
    const targetDays = info.byDay.map(d => DAY_CODE_TO_JS[d.replace(/[^A-Z]/g, '')] ?? -1).filter(d => d >= 0);
    // Start from the week of dtstart
    const cursor = new Date(dtstart);
    // Rewind to Sunday of that week
    cursor.setDate(cursor.getDate() - cursor.getDay());
    cursor.setHours(dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds(), 0);

    while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
      for (const dow of targetDays) {
        const occurrence = new Date(cursor);
        occurrence.setDate(cursor.getDate() + dow);
        if (occurrence < dtstart) continue;
        if (occurrence > effectiveEnd) break;
        if (totalEmitted >= limitByCount) break;
        totalEmitted++;
        if (occurrence >= windowStart && !exSet.has(occurrence.toDateString())) {
          results.push(occurrence);
        }
      }
      // Advance by interval weeks
      cursor.setDate(cursor.getDate() + 7 * info.interval);
    }
  } else if (info.frequency === 'DAILY') {
    const cursor = new Date(dtstart);
    while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
      if (cursor >= windowStart && !exSet.has(cursor.toDateString())) {
        results.push(new Date(cursor));
      }
      totalEmitted++;
      cursor.setDate(cursor.getDate() + info.interval);
    }
  } else if (info.frequency === 'WEEKLY' && !info.byDay?.length) {
    // Simple weekly — same day of week as dtstart
    const cursor = new Date(dtstart);
    while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
      if (cursor >= windowStart && !exSet.has(cursor.toDateString())) {
        results.push(new Date(cursor));
      }
      totalEmitted++;
      cursor.setDate(cursor.getDate() + 7 * info.interval);
    }
  } else if (info.frequency === 'MONTHLY') {
    const cursor = new Date(dtstart);
    if (info.byMonthDay?.length) {
      // Specific day(s) of month
      while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
        for (const day of info.byMonthDay) {
          const occ = new Date(cursor.getFullYear(), cursor.getMonth(), day,
            dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
          if (occ < dtstart) continue;
          if (occ > effectiveEnd) break;
          if (totalEmitted >= limitByCount) break;
          totalEmitted++;
          if (occ >= windowStart && !exSet.has(occ.toDateString())) {
            results.push(occ);
          }
        }
        cursor.setMonth(cursor.getMonth() + info.interval);
      }
    } else if (info.byDay?.length) {
      // Nth weekday of month (e.g. "2TU" = second Tuesday)
      while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
        for (const daySpec of info.byDay) {
          const occ = nthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), daySpec, dtstart);
          if (!occ || occ < dtstart || occ > effectiveEnd) continue;
          if (totalEmitted >= limitByCount) break;
          totalEmitted++;
          if (occ >= windowStart && !exSet.has(occ.toDateString())) {
            results.push(occ);
          }
        }
        cursor.setMonth(cursor.getMonth() + info.interval);
      }
    } else {
      // Same day of month as dtstart
      while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
        if (cursor >= windowStart && !exSet.has(cursor.toDateString())) {
          results.push(new Date(cursor));
        }
        totalEmitted++;
        cursor.setMonth(cursor.getMonth() + info.interval);
      }
    }
  } else if (info.frequency === 'YEARLY') {
    const cursor = new Date(dtstart);
    while (cursor <= effectiveEnd && totalEmitted < limitByCount && results.length < maxOccurrences) {
      if (cursor >= windowStart && !exSet.has(cursor.toDateString())) {
        results.push(new Date(cursor));
      }
      totalEmitted++;
      cursor.setFullYear(cursor.getFullYear() + info.interval);
    }
  }

  return results;
}

function nthWeekdayOfMonth(
  year: number, month: number, daySpec: string, dtstart: Date
): Date | null {
  const match = daySpec.match(/^(-?\d+)?([A-Z]{2})$/);
  if (!match) return null;
  const [, nthStr, dayCode] = match;
  const targetDow = DAY_CODE_TO_JS[dayCode];
  if (targetDow === undefined) return null;
  const nth = nthStr ? parseInt(nthStr, 10) : 1;

  if (nth > 0) {
    // Forward: 1st, 2nd, 3rd... weekday
    const first = new Date(year, month, 1);
    let dayOfMonth = 1 + ((targetDow - first.getDay() + 7) % 7);
    dayOfMonth += (nth - 1) * 7;
    const result = new Date(year, month, dayOfMonth,
      dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
    if (result.getMonth() !== month) return null; // overflowed
    return result;
  } else {
    // Negative: last, second-to-last...
    const lastDay = new Date(year, month + 1, 0).getDate();
    const last = new Date(year, month, lastDay);
    let dayOfMonth = lastDay - ((last.getDay() - targetDow + 7) % 7);
    dayOfMonth += (nth + 1) * 7; // nth is negative, so this subtracts
    const result = new Date(year, month, dayOfMonth,
      dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
    if (result.getMonth() !== month) return null;
    return result;
  }
}
