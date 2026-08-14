import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitContactForm, n8nConfigured, CONTACT_WEBHOOK_PATH, feedbackWebhookUrl } from '../contact';
import { normalizeSource } from '../../../stores/feedback.svelte';

const ENDPOINT = `https://feedback.example.com${CONTACT_WEBHOOK_PATH}`;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('VITE_FEEDBACK_WEBHOOK_URL', ENDPOINT);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('feedback endpoint routing', () => {
  /**
   * The regression this block exists to prevent. The form used to POST to settings().n8nBaseUrl —
   * the USER's own automation instance. A user running their own n8n therefore sent feedback to
   * their own server, which has no reckons-contact workflow, got a 404, and the maintainers never
   * saw it. Feedback is a message TO US; it must not be routed by the sender's own config.
   */
  it('goes to the product endpoint, whatever the user has configured for their own n8n', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await submitContactForm({ name: 'Ada', email: 'ada@x.com', message: 'hi' });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(ENDPOINT);
  });

  it('reports configured only when the product endpoint is set', () => {
    expect(n8nConfigured()).toBe(true);
    vi.stubEnv('VITE_FEEDBACK_WEBHOOK_URL', '');
    expect(n8nConfigured()).toBe(false);
  });

  it('unset endpoint fails as unconfigured, so the form falls back to mailto', async () => {
    vi.stubEnv('VITE_FEEDBACK_WEBHOOK_URL', '');
    const res = await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect(res).toEqual({ ok: false, error: 'No feedback endpoint configured.', unconfigured: true });
  });

  it('strips trailing slashes so a config typo does not produce a double slash', () => {
    vi.stubEnv('VITE_FEEDBACK_WEBHOOK_URL', `${ENDPOINT}//`);
    expect(feedbackWebhookUrl()).toBe(ENDPOINT);
  });
});

describe('n8n contact form', () => {
  it('POSTs to the feedback endpoint and resolves ok on 200', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitContactForm({ name: 'Ada', email: 'ada@x.com', message: 'hi', source: 'about' });
    expect(res).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ name: 'Ada', email: 'ada@x.com', message: 'hi', source: 'about' });
    expect(body.submittedAt).toBeTruthy();
  });

  it('surfaces a non-200 response as an error rather than a silent success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })));
    const res = await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect(res).toEqual({ ok: false, error: 'n8n responded 502' });
  });

  it('surfaces a network error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const res = await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect(res).toEqual({ ok: false, error: 'offline' });
  });
});

describe('feedback source normalization', () => {
  /**
   * A raw pathname can carry graph names and entity IRIs. A user telling us the UI is confusing
   * has not agreed to send us the contents of their private graph, so only the first segment
   * survives and query strings are dropped entirely.
   */
  it('keeps only the first path segment', () => {
    expect(normalizeSource('/review')).toBe('review');
    expect(normalizeSource('/kb/my-private-graph-name')).toBe('kb');
  });

  it('drops query strings and fragments, which is where identifiers hide', () => {
    expect(normalizeSource('/kb?kb=urn:kbase:entity/AdaLovelace')).toBe('kb');
    expect(normalizeSource('/review?tab=align#node-42')).toBe('review');
  });

  it('labels the root route rather than returning empty', () => {
    expect(normalizeSource('/')).toBe('home');
  });

  it('never returns undefined for junk input', () => {
    expect(normalizeSource('')).toBe('unknown');
  });
});
