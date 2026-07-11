import { describe, it, expect, beforeEach, vi } from 'vitest';

let n8nBaseUrl: string | undefined = 'https://n8n.example.com';
let n8nNotifyOnReview: boolean | undefined = true;
vi.mock('../../../stores/settings.svelte', () => ({
  settings: () => ({ n8nBaseUrl, n8nNotifyOnReview }),
}));

import { notifyReview, reviewNotifyEnabled, REVIEW_WEBHOOK_PATH } from '../notify';

beforeEach(() => {
  n8nBaseUrl = 'https://n8n.example.com';
  n8nNotifyOnReview = true;
  vi.restoreAllMocks();
});

describe('n8n review notification', () => {
  it('is enabled only when opted in AND a base URL is set', () => {
    expect(reviewNotifyEnabled()).toBe(true);
    n8nNotifyOnReview = false;
    expect(reviewNotifyEnabled()).toBe(false);
    n8nNotifyOnReview = true;
    n8nBaseUrl = '';
    expect(reviewNotifyEnabled()).toBe(false);
  });

  it('POSTs a review summary to the review webhook and resolves ok on 200', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await notifyReview({ count: 3, kind: 'scrape', source: 'grant scrape', samples: ['grant-a', 'grant-b'] });
    expect(res).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://n8n.example.com${REVIEW_WEBHOOK_PATH}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ count: 3, kind: 'scrape', source: 'grant scrape' });
    expect(body.at).toBeTruthy();
  });

  it('caps samples at 5', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await notifyReview({ count: 9, samples: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.samples).toHaveLength(5);
  });

  it('skips (no fetch) when disabled, unconfigured, or count<=0', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    n8nNotifyOnReview = false;
    expect((await notifyReview({ count: 2 })).ok).toBe(false);
    n8nNotifyOnReview = true;
    n8nBaseUrl = '';
    expect((await notifyReview({ count: 2 })).ok).toBe(false);
    n8nBaseUrl = 'https://n8n.example.com';
    expect((await notifyReview({ count: 0 })).ok).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an error (not throw) when n8n is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await notifyReview({ count: 1 });
    expect(res.ok).toBe(false);
  });
});
