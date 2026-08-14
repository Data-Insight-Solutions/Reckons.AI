/**
 * Reachability diagnostics.
 *
 * This exists because the Indico integration was recorded as "functional" while the app could
 * never reach a real Indico server from a browser at all. Two layers refused it — the app's own
 * CSP, and the server's missing CORS headers — and BOTH surfaced to the user as the same
 * four-word string, `TypeError: Failed to fetch`. Measured 2026-07-31 against a live Indico 3.x
 * server: CSP blocked the request, and once CSP was fixed CORS blocked it, with no change in what
 * the user saw.
 *
 * These tests pin the property that matters: the message must name the layer that refused and the
 * fix THAT layer needs, because the two remedies are in different places (rebuild this app vs
 * configure the Indico server) and picking the wrong one wastes hours.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeUnreachable, watchCspViolations } from '../reachability';
import { IndicoClient } from '../client';

afterEach(() => vi.restoreAllMocks());

describe('describeUnreachable', () => {
  it('names CSP, and the rebuild that fixes it, when the policy blocked the request', () => {
    const { cause, message } = describeUnreachable({
      serverOrigin: 'https://indico.example.com',
      appOrigin: 'https://app.example.com',
      cspBlocked: true
    });

    expect(cause).toBe('csp');
    expect(message).toContain('Content-Security-Policy');
    expect(message).toContain('connect-src');
    expect(message).toContain('VITE_INDICO_SERVER_URL=https://indico.example.com');
    // It must NOT send the user to the server to fix a policy that lives in this app.
    expect(message).not.toContain('Access-Control-Allow-Origin');
  });

  it('names CORS, the app origin the server must allow, and where to fix it', () => {
    const { cause, message } = describeUnreachable({
      serverOrigin: 'https://indico.example.com',
      appOrigin: 'https://app.example.com',
      cspBlocked: false
    });

    expect(cause).toBe('cors-or-network');
    expect(message).toContain('Access-Control-Allow-Origin');
    expect(message).toContain('https://app.example.com'); // the value the header must name
    expect(message).toContain('indico-verify.ts'); // how to prove the API itself is healthy
    // Honest: CORS is the usual cause but a dead server fails identically, and saying so is the
    // difference between a diagnosis and a guess presented as one.
    expect(message).toMatch(/down or misnamed/i);
  });

  it('does not blame CORS outside a browser, where CORS is not enforced', () => {
    const { cause, message } = describeUnreachable({
      serverOrigin: 'https://indico.example.com',
      appOrigin: null,
      cspBlocked: false,
      cause: new Error('getaddrinfo ENOTFOUND indico.example.com')
    });

    expect(cause).toBe('network');
    expect(message).toContain('ENOTFOUND');
    expect(message).not.toContain('Access-Control-Allow-Origin');
  });
});

describe('watchCspViolations', () => {
  it('is inert outside a browser rather than throwing on a missing document', () => {
    const probe = watchCspViolations('https://indico.example.com');
    expect(probe.blocked()).toBe(false);
    expect(() => probe.stop()).not.toThrow();
  });
});

describe('IndicoClient surfaces a reachable diagnosis, not "Failed to fetch"', () => {
  it('replaces the bare TypeError with an actionable message and keeps the original as cause', async () => {
    const original = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw original; }));

    const client = new IndicoClient({ serverUrl: 'https://indico.example.com' });
    const err = (await client.fetchEvents().catch((e) => e)) as Error & { cause?: unknown };

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toBe('Failed to fetch');
    expect(err.message).toContain('https://indico.example.com');
    // The original is preserved so a developer can still see what the platform actually threw.
    expect(err.cause).toBe(original);
  });

  it('still reports a real HTTP error from the server unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Malformed API key', { status: 400 })));

    const client = new IndicoClient({ serverUrl: 'https://indico.example.com', apiToken: 'indp_bad' });
    const err = (await client.fetchEvents().catch((e) => e)) as Error & { cause?: unknown };

    // A server that answers is not a reachability problem — that path must not be swallowed by
    // the new diagnostic.
    expect(err.message).toBe('Indico 400: Malformed API key');
  });
});
