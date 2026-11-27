/**
 * F303.3 — claims and leases, the pure half.
 *
 * A device that can run a request writes a claim to ITS OWN file (job-channel/claims/<device>/<request>.json,
 * one writer per file). Nobody edits another device's claim, so file sync has nothing to conflict on.
 * Each device reads every claim for a request and applies the SAME fixed rule, so they agree without
 * talking:
 *   - a claim is valid while its lease has not run out (or once it is marked finished, which never expires);
 *   - the winner is the valid claim with the EARLIEST claimedAt; a tie goes to the LOWEST device id;
 *   - every other valid claimant backs off; an expired lease is free, so a dead holder frees the job.
 *
 * WEAKNESSES, said here. Sync is eventual: two devices can both believe they won until each other's claim
 * arrives, so a duplicate run is possible (it is made harmless by content-addressed results, F303.5, and
 * made rare by the settle wait in the host). The rule trusts each device's clock for claimedAt: a device
 * with a clock set far back would win every time. Claims whose time is more than MAX_SKEW_MS ahead of
 * `now` are dropped as invalid, but a clock set back is not detected. Nothing here proves WHO wrote a
 * claim; the device id in the file path must match the id inside, which stops a stray file but not a
 * device that lies about its own id (that is what F196.2 signing is for).
 *
 * Pure: no files, no clock (the caller passes `now`).
 */

export type Claim = {
  requestId: string;
  /** The claimant's opaque device id (the directory the file sits in). */
  device: string;
  claimedAt: string;
  leaseUntil: string;
  /** Set by the holder when its run ended (passed or failed); a finished claim never expires. */
  finished?: true;
};

export const LEASE_MS = 10 * 60_000;
export const MAX_LEASE_MS = 60 * 60_000;
export const MAX_SKEW_MS = 5 * 60_000;
const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A claim from unchecked JSON, or a reason it is not one. Pure. */
export function parseClaim(raw: unknown, now: Date): { ok: true; claim: Claim } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'a claim must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || !ID_RE.test(r.requestId)) return { ok: false, reason: 'requestId is not a plain id' };
  if (typeof r.device !== 'string' || !DEVICE_RE.test(r.device)) return { ok: false, reason: 'device is not an opaque device id' };
  const at = typeof r.claimedAt === 'string' ? Date.parse(r.claimedAt) : NaN;
  const until = typeof r.leaseUntil === 'string' ? Date.parse(r.leaseUntil) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(until)) return { ok: false, reason: 'claimedAt and leaseUntil must be dates' };
  if (until <= at) return { ok: false, reason: 'the lease must end after the claim began' };
  if (until - at > MAX_LEASE_MS) return { ok: false, reason: 'the lease is longer than the allowed maximum' };
  if (at - now.getTime() > MAX_SKEW_MS) return { ok: false, reason: 'the claim is dated in the future' };
  if (r.finished !== undefined && r.finished !== true) return { ok: false, reason: 'finished may only be true' };
  const claim: Claim = { requestId: r.requestId, device: r.device, claimedAt: new Date(at).toISOString(), leaseUntil: new Date(until).toISOString(), ...(r.finished ? { finished: true as const } : {}) };
  return { ok: true, claim };
}

export const claimLive = (c: Claim, now: Date): boolean => c.finished === true || Date.parse(c.leaseUntil) > now.getTime();

export type Resolution = {
  /** The device that holds the request, if any valid claim exists. */
  winner: Claim | undefined;
  /** Every other valid claimant: it should back off. */
  backOff: string[];
  /** Devices whose lease ran out: free, and not counted. */
  expired: string[];
};

/**
 * Decide the holder of ONE request from its claims. Pure. The input order never matters; claims for
 * other requests are ignored; of two claims by one device the later claimedAt is kept (its own latest word).
 */
export function resolveClaims(claims: readonly Claim[], now: Date, requestId?: string): Resolution {
  const latest = new Map<string, Claim>();
  for (const c of claims) {
    if (requestId !== undefined && c.requestId !== requestId) continue;
    const prev = latest.get(c.device);
    if (!prev || Date.parse(c.claimedAt) > Date.parse(prev.claimedAt)) latest.set(c.device, c);
  }
  const live: Claim[] = [];
  const expired: Claim[] = [];
  for (const c of latest.values()) (claimLive(c, now) ? live : expired).push(c);
  const order = (a: Claim, b: Claim) => Date.parse(a.claimedAt) - Date.parse(b.claimedAt) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
  live.sort(order);
  return {
    winner: live[0],
    backOff: live.slice(1).map((c) => c.device),
    expired: expired.map((c) => c.device).sort(),
  };
}

/**
 * The holder's renewal. ONLY the holder may renew: another device's call is refused (its own claim
 * is the only file it writes). A live claim keeps its claimedAt (so it keeps its place in line) and
 * moves its lease; an expired one is re-claimed from `now`, because it was free in between.
 */
export function renewClaim(claim: Claim, device: string, now: Date, leaseMs: number = LEASE_MS): { ok: true; claim: Claim } | { ok: false; reason: string } {
  if (claim.device !== device) return { ok: false, reason: 'only the device that holds a claim may renew it' };
  if (claim.finished) return { ok: true, claim };
  const lease = Math.min(Math.max(leaseMs, 1000), MAX_LEASE_MS);
  const start = claimLive(claim, now) ? claim.claimedAt : now.toISOString();
  return { ok: true, claim: { ...claim, claimedAt: start, leaseUntil: new Date(now.getTime() + lease).toISOString() } };
}

/** A fresh claim by `device` on `requestId` starting `now`. */
export const newClaim = (requestId: string, device: string, now: Date, leaseMs: number = LEASE_MS): Claim => ({
  requestId, device, claimedAt: now.toISOString(), leaseUntil: new Date(now.getTime() + Math.min(Math.max(leaseMs, 1000), MAX_LEASE_MS)).toISOString(),
});
