/** F303.3 claim rule over synthetic devices: the pure half. */
import { describe, expect, it } from 'vitest';
import { LEASE_MS, newClaim, parseClaim, renewClaim, resolveClaims, type Claim } from '../job-claims.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const T0 = new Date('2026-11-18T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const claim = (device: string, startMs: number, leaseMs = LEASE_MS, extra: Partial<Claim> = {}): Claim => ({ ...newClaim('r1', device, at(startMs), leaseMs), ...extra });

describe('resolveClaims', () => {
  it('the earliest valid claim wins and the others are told to back off', () => {
    const r = resolveClaims([claim(B, 2000), claim(A, 5000), claim(C, 1000)], at(6000));
    expect(r.winner?.device).toBe(C);
    expect(r.backOff.sort()).toEqual([A, B]);
  });
  it('a tie goes to the lowest device id, whatever the input order', () => {
    for (const list of [[claim(C, 0), claim(B, 0), claim(A, 0)], [claim(A, 0), claim(B, 0), claim(C, 0)]]) {
      expect(resolveClaims(list, at(1000)).winner?.device).toBe(A);
    }
  });
  it('an expired lease is free: the next earliest valid claim wins, and the expired holder is listed', () => {
    const r = resolveClaims([claim(A, 0, 60_000), claim(B, 30_000)], at(120_000));
    expect(r.winner?.device).toBe(B);
    expect(r.expired).toEqual([A]);
    expect(resolveClaims([claim(A, 0, 60_000)], at(120_000)).winner).toBeUndefined();
  });
  it('a finished claim never expires, so a finished request is not claimed again', () => {
    const r = resolveClaims([claim(A, 0, 60_000, { finished: true }), claim(B, 3_000_000)], at(3_100_000));
    expect(r.winner?.device).toBe(A);
    expect(r.backOff).toEqual([B]);
  });
  it('a forced double claim yields exactly one winner', () => {
    const r = resolveClaims([claim(A, 100), claim(B, 100)], at(200));
    expect(r.winner).toBeDefined();
    expect(r.backOff).toHaveLength(1);
  });
  it('ignores claims for other requests and keeps only a device\'s latest word', () => {
    const other: Claim = { ...claim(A, 0), requestId: 'r2' };
    expect(resolveClaims([other], at(1000), 'r1').winner).toBeUndefined();
    const r = resolveClaims([claim(A, 0), claim(A, 9000), claim(B, 5000)], at(10_000), 'r1');
    expect(r.winner?.device).toBe(B);
  });
});

describe('renewClaim', () => {
  it('only the holder may renew', () => {
    const r = renewClaim(claim(A, 0), B, at(1000));
    expect(r).toEqual({ ok: false, reason: 'only the device that holds a claim may renew it' });
  });
  it('a live renewal keeps its place in line and moves the lease', () => {
    const r = renewClaim(claim(A, 0, 60_000), A, at(50_000), 60_000);
    expect(r.ok && r.claim.claimedAt).toBe(at(0).toISOString());
    expect(r.ok && r.claim.leaseUntil).toBe(at(110_000).toISOString());
  });
  it('renewing after expiry is a new claim from now, losing its old place', () => {
    const r = renewClaim(claim(A, 0, 60_000), A, at(120_000), 60_000);
    expect(r.ok && r.claim.claimedAt).toBe(at(120_000).toISOString());
    const winner = resolveClaims([r.ok ? r.claim : claim(A, 0), claim(B, 90_000)], at(121_000)).winner;
    expect(winner?.device).toBe(B);
  });
});

describe('parseClaim (hostile files)', () => {
  const good = claim(A, 0);
  it('accepts a good claim', () => expect(parseClaim(good, at(1000)).ok).toBe(true));
  it('refuses wrong shapes', () => {
    const bad: unknown[] = [null, [], 'x', { ...good, device: 'my-laptop' }, { ...good, requestId: '../x' }, { ...good, claimedAt: 'soon' },
      { ...good, leaseUntil: good.claimedAt }, { ...good, leaseUntil: at(10 * 3_600_000).toISOString() }, { ...good, finished: 'yes' }];
    for (const b of bad) expect(parseClaim(b, at(1000)).ok).toBe(false);
  });
  it('refuses a claim dated well into the future (it would beat every honest claim)', () => {
    expect(parseClaim(claim(A, 3_600_000), at(0)).ok).toBe(false);
  });
});
