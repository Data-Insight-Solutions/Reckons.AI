import { describe, expect, it } from 'vitest';
import { summarizeRequests } from '../watch.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const req = (min: number, path: string, seconds: number) => ({ at: ago(min), status: 200, seconds, method: 'POST', path });

describe('summarizeRequests', () => {
  it('null stays null — unknown, not empty', () => {
    expect(summarizeRequests(null, NOW)).toBeNull();
  });

  it('counts the day, the last hour, and the paths most-first', () => {
    const s = summarizeRequests([req(5, '/api/chat', 2), req(30, '/api/chat', 1), req(120, '/v1/messages', 3)], NOW)!;
    expect(s.today).toBe(3);
    expect(s.lastHour).toBe(2);
    expect(s.busySeconds).toBe(6);
    expect(s.byPath).toEqual([['/api/chat', 2], ['/v1/messages', 1]]);
  });

  it('idle after 30 minutes, active before', () => {
    expect(summarizeRequests([req(31, '/api/chat', 1)], NOW)!.idle).toBe(true);
    expect(summarizeRequests([req(29, '/api/chat', 1)], NOW)!.idle).toBe(false);
  });
});
