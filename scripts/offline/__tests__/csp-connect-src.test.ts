/**
 * CSP connect-src widening.
 *
 * This exists because the placeholder shipped as a LITERAL `%RECKONS_EXTRA_CONNECT_SRC%` token
 * inside the served `connect-src` directive (observed 2026-07-31) — a half-finished substitution
 * is worse than none, because an invalid source expression sits in the middle of a security
 * policy. The tests pin both halves: the origins are derived correctly, and the placeholder never
 * survives into the output.
 */
import { describe, it, expect } from 'vitest';
import {
  originOf,
  extraConnectSrc,
  fillConnectSrcPlaceholder,
  CONNECT_SRC_PLACEHOLDER
} from '../csp-connect-src.js';

describe('originOf', () => {
  it('reduces a URL to scheme + host + port', () => {
    expect(originOf('https://indico.example.com/export/categ/0.json')).toBe('https://indico.example.com');
    expect(originOf('http://localhost:11434')).toBe('http://localhost:11434');
    expect(originOf('https://n8n.example.com:8443/webhook/abc')).toBe('https://n8n.example.com:8443');
  });

  it('drops the PATH — a webhook path is secret-ish and the CSP is public', () => {
    // VITE_FEEDBACK_WEBHOOK_URL carries an unguessable path; baking it into the shipped HTML
    // would publish it. This is the reason the module reduces to an origin at all.
    const origin = originOf('https://n8n.example.com/webhook/93gfOyLx8pzcMoka');
    expect(origin).toBe('https://n8n.example.com');
    expect(origin).not.toContain('93gfOyLx8pzcMoka');
  });

  it('refuses anything that is not an absolute http(s)/ws(s) URL', () => {
    // A typo must not silently widen the policy.
    expect(originOf('indico.example.com')).toBeNull();
    expect(originOf('/relative/path')).toBeNull();
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('file:///etc/passwd')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('extraConnectSrc', () => {
  it('collects configured self-hosted origins, deduped and sorted', () => {
    const origins = extraConnectSrc({
      VITE_INDICO_SERVER_URL: 'https://indico.example.com',
      VITE_N8N_BASE_URL: 'https://n8n.example.com/',
      VITE_OLLAMA_BASE_URL: 'http://localhost:11434'
    });
    expect(origins).toEqual([
      'http://localhost:11434',
      'https://indico.example.com',
      'https://n8n.example.com'
    ]);
  });

  it('is deterministic regardless of env ordering, so builds stay reproducible', () => {
    const a = extraConnectSrc({ VITE_INDICO_SERVER_URL: 'https://b.example.com', VITE_N8N_BASE_URL: 'https://a.example.com' });
    const b = extraConnectSrc({ VITE_N8N_BASE_URL: 'https://a.example.com', VITE_INDICO_SERVER_URL: 'https://b.example.com' });
    expect(a).toEqual(b);
  });

  it('never emits an API key as an origin', () => {
    const origins = extraConnectSrc({
      VITE_ANTHROPIC_API_KEY: 'sk-ant-secret',
      VITE_INDICO_API_TOKEN: 'indp_secret',
      VITE_INDICO_SERVER_URL: 'https://indico.example.com'
    });
    expect(origins).toEqual(['https://indico.example.com']);
    expect(origins.join(' ')).not.toMatch(/secret/);
  });

  it('splits the VITE_EXTRA_CONNECT_SRC escape hatch on spaces and commas', () => {
    expect(extraConnectSrc({ VITE_EXTRA_CONNECT_SRC: 'https://a.example.com, https://b.example.com' }))
      .toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('returns nothing when no self-hosted integration is configured', () => {
    expect(extraConnectSrc({})).toEqual([]);
    expect(extraConnectSrc({ VITE_INDICO_SERVER_URL: '' })).toEqual([]);
  });
});

describe('fillConnectSrcPlaceholder', () => {
  const html = `<meta content="connect-src 'self' http://localhost:* ${CONNECT_SRC_PLACEHOLDER}; img-src 'self';" />`;

  it('substitutes the configured origins', () => {
    const out = fillConnectSrcPlaceholder(html, ['https://indico.example.com']);
    expect(out).toContain("connect-src 'self' http://localhost:* https://indico.example.com;");
    expect(out).not.toContain(CONNECT_SRC_PLACEHOLDER);
  });

  it('leaves NO placeholder and no stray double space when nothing is configured', () => {
    // The bug this file was written for: an unsubstituted token inside a live security policy.
    const out = fillConnectSrcPlaceholder(html, []);
    expect(out).not.toContain(CONNECT_SRC_PLACEHOLDER);
    expect(out).not.toContain('%');
    expect(out).toContain("connect-src 'self' http://localhost:*;");
  });

  it('is a no-op on HTML that has no placeholder', () => {
    const plain = '<meta content="connect-src \'self\';" />';
    expect(fillConnectSrcPlaceholder(plain, ['https://indico.example.com'])).toBe(plain);
  });

  it('keeps the real app.html in sync with the substitution it depends on', async () => {
    // A guard against the two halves drifting apart: if someone removes the placeholder from
    // app.html the hook silently stops widening anything, and self-hosted integrations break
    // again with no failing test. That is exactly how this shipped broken.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const appHtml = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
    expect(appHtml).toContain(CONNECT_SRC_PLACEHOLDER);
  });
});
