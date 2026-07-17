import { describe, it, expect, beforeEach, vi } from 'vitest';

let n8nBaseUrl: string | undefined = 'https://n8n.example.com';
vi.mock('../../../stores/settings.svelte', () => ({ settings: () => ({ n8nBaseUrl }) }));

import { submitContactForm, n8nConfigured, CONTACT_WEBHOOK_PATH } from '../contact';

beforeEach(() => {
  n8nBaseUrl = 'https://n8n.example.com';
  vi.restoreAllMocks();
});

describe('n8n contact form', () => {
  it('reports configured when a base URL is set', () => {
    expect(n8nConfigured()).toBe(true);
    n8nBaseUrl = '';
    expect(n8nConfigured()).toBe(false);
  });

  it('POSTs to the contact webhook and resolves ok on 200', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitContactForm({ name: 'Ada', email: 'ada@x.com', message: 'hi', source: 'about' });
    expect(res).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://n8n.example.com${CONTACT_WEBHOOK_PATH}`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ name: 'Ada', email: 'ada@x.com', message: 'hi', source: 'about' });
    expect(body.submittedAt).toBeTruthy();
  });

  it('trims a trailing slash on the base URL', async () => {
    n8nBaseUrl = 'https://n8n.example.com/';
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`https://n8n.example.com${CONTACT_WEBHOOK_PATH}`);
  });

  it('returns unconfigured when no base URL is set', async () => {
    n8nBaseUrl = '';
    const res = await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect(res).toEqual({ ok: false, error: 'No n8n instance configured.', unconfigured: true });
  });

  it('surfaces a non-200 response as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })));
    const res = await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect(res).toEqual({ ok: false, error: 'n8n responded 502' });
  });

  it('surfaces a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const res = await submitContactForm({ name: 'A', email: 'a@x.com', message: 'm' });
    expect(res).toEqual({ ok: false, error: 'offline' });
  });
});
