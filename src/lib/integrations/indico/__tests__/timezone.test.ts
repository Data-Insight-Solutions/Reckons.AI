/**
 * Indico reports a wall clock plus the zone it was RENDERED in — which is the category's zone,
 * not the event's. The mapper used to drop that zone, so an event created at 23:00 America/
 * Los_Angeles came back rendered as 01:00 US/Central and entered the graph as a bare "01:00":
 * two hours wrong, with nothing recording which zone had been meant.
 *
 * Measured against the live server on 2026-07-31 with real events, which is where these fixtures
 * come from. A graph whose times are silently shifted is worse than one with no times: it looks
 * authoritative and compares equal to nothing.
 */
import { describe, it, expect } from 'vitest';
import { indicoEventsToStatements } from '../indico-rdf';
import type { IndicoEvent } from '../types';

const M = 'urn:kbase:meta/';

function scheduledAt(ev: Partial<IndicoEvent>): string | undefined {
  const stmts = indicoEventsToStatements(
    [{ id: '1', title: 'T', type: 'Event', hasAnyProtection: false, ...ev } as IndicoEvent],
    'src', 'https://indico.example.com'
  );
  return stmts.find((st) => (st.p as { value: string }).value === `${M}scheduled-at`)
    ?.o.value as string | undefined;
}

describe('Indico timezone handling', () => {
  it('resolves a US/Central wall clock to the correct UTC instant', () => {
    // Real export shape: created 11:00 America/Los_Angeles, rendered by Indico as 13:00 US/Central.
    // CDT is UTC-5, so the true instant is 18:00Z — and 18:00Z IS 11:00 PDT. Same moment.
    expect(scheduledAt({ startDate: { date: '2026-08-07', time: '13:00:00', tz: 'US/Central' } }))
      .toBe('2026-08-07T18:00:00Z');
  });

  it('agrees across zones for one instant — the property a graph actually needs', () => {
    const central = scheduledAt({ startDate: { date: '2026-08-07', time: '13:00:00', tz: 'US/Central' } });
    const pacific = scheduledAt({ startDate: { date: '2026-08-07', time: '11:00:00', tz: 'America/Los_Angeles' } });
    // Two sources describing one meeting must compare EQUAL regardless of who exported them.
    expect(central).toBe(pacific);
  });

  it('handles a date rollover rather than dropping the day', () => {
    // 23:00 PDT on the 5th is 06:00Z on the 6th — the deadline event that exposed this.
    expect(scheduledAt({ startDate: { date: '2026-08-05', time: '23:00:00', tz: 'America/Los_Angeles' } }))
      .toBe('2026-08-06T06:00:00Z');
  });

  it('applies the offset in force on the date, not today\'s offset', () => {
    // January: Los Angeles is PST (UTC-8), not PDT (UTC-7). A fixed offset would be an hour out.
    expect(scheduledAt({ startDate: { date: '2026-01-15', time: '09:00:00', tz: 'America/Los_Angeles' } }))
      .toBe('2026-01-15T17:00:00Z');
  });

  it('falls back to the naive wall clock when the zone is missing or unknown', () => {
    // Better a value without a zone than a confidently wrong instant.
    expect(scheduledAt({ startDate: { date: '2026-08-07', time: '13:00:00' } as never }))
      .toBe('2026-08-07T13:00:00');
    expect(scheduledAt({ startDate: { date: '2026-08-07', time: '13:00:00', tz: 'Mars/Olympus' } }))
      .toBe('2026-08-07T13:00:00');
  });
});
