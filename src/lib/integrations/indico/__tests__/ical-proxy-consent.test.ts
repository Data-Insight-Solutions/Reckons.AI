/**
 * The calendar CORS-proxy fallback must never fire without permission.
 *
 * A private iCal address (Google's "secret address", Outlook's published link) is bearer
 * authentication carried in a URL. Relaying one through corsproxy.io hands an unaffiliated third
 * party both the key to that calendar and its contents. Until 2026-09-18 the fallback ran silently
 * inside a catch block, so the failure mode was invisible: the feature worked, and the leak was
 * the reason it worked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchICalEvents } from '../ical-parse';

const ICS = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Standup\r\nDTSTART:20260918T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
const SECRET = 'https://calendar.google.com/calendar/ical/private-abc123/basic.ics';

afterEach(() => vi.unstubAllGlobals());

describe('fetchICalEvents CORS fallback', () => {
  it('refuses to relay through a third party by default', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('CORS'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchICalEvents(SECRET)).rejects.toThrow(/corsproxy\.io|third party/i);
    // The direct attempt is fine; the SECOND call — to the proxy — must never happen.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('corsproxy'))).toBe(true);
  });

  it('names the cost in the error, so a user can make the choice knowingly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS')));
    await expect(fetchICalEvents(SECRET)).rejects.toThrow(/password to that calendar/i);
  });

  it('relays only when explicitly permitted', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('CORS'))
      .mockResolvedValueOnce({ ok: true, text: async () => ICS } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchICalEvents(SECRET, { allowCorsProxy: true });
    expect(events).toHaveLength(1);
    expect(String(fetchMock.mock.calls[1][0])).toContain('corsproxy.io');
  });

  it('never reaches the proxy at all when the direct fetch succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => ICS } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchICalEvents(SECRET, { allowCorsProxy: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('corsproxy');
  });
});
