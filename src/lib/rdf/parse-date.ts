/**
 * Date parsing for TIMELINE PLACEMENT — one shared, tested rule.
 *
 * Placing a node "by its specific date" only works if every date is interpreted the same way.
 * `new Date(...)` does not do that:
 *
 *   new Date('2026-07-15')        → UTC midnight   (ES spec: date-only forms are UTC)
 *   new Date('2026-07-15T10:00')  → LOCAL 10:00    (date-TIME forms without a zone are local)
 *
 * So a date-only fact and a same-day datetime fact land hours apart, and anywhere west of
 * Greenwich a fact dated "2026-07-15" renders on the 14th. On a timeline that reads as the
 * node being on the wrong day — the graph quietly lying about when something happened.
 *
 * The rule here: a value with NO time-of-day is a CALENDAR date, anchored to LOCAL midnight,
 * so it lands on the day it names. A value that carries a time is an INSTANT and is honoured
 * as written (respecting an explicit UTC/offset when present). Anything unparseable returns
 * undefined so the caller can place it in an "undated" lane rather than invent a position.
 */

/** Milliseconds for a calendar date at local midnight. */
function localDate(y: number, monthIndex: number, day: number): number {
  return new Date(y, monthIndex, day).getTime();
}

/**
 * Parse a graph literal into a timestamp for timeline placement.
 * Returns undefined when the value carries no usable date — never a guess.
 */
export function parseGraphDate(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return normalizeEpoch(raw);
  if (typeof raw !== 'string') return undefined;

  const value = raw.trim();
  if (!value) return undefined;

  // Calendar forms with no time-of-day → LOCAL midnight, so they land on the named day.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) {
    const [, y, m, d] = ymd;
    const month = Number(m), day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return localDate(Number(y), month - 1, day);
  }

  const ym = /^(\d{4})-(\d{2})$/.exec(value);
  if (ym) {
    const month = Number(ym[2]);
    if (month < 1 || month > 12) return undefined;
    return localDate(Number(ym[1]), month - 1, 1);
  }

  const yearOnly = /^(\d{4})$/.exec(value);
  if (yearOnly) return localDate(Number(yearOnly[1]), 0, 1);

  // Bare number → epoch seconds or milliseconds.
  if (/^\d+$/.test(value)) return normalizeEpoch(Number(value));

  // Anything with a time component: let the platform apply its rules (an explicit Z or ±HH:MM
  // is absolute; a bare local datetime stays local — both are what the author wrote).
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Treat small integers as epoch SECONDS, large ones as MILLISECONDS. */
function normalizeEpoch(n: number): number | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // 1e11 ms ≈ 1973; anything below that as ms would be the early 1970s, so it is seconds.
  return n < 1e11 ? n * 1000 : n;
}
