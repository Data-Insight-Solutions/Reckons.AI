import type { SettingsRecord } from '$lib/storage/db';
import { isLoopbackUrl } from '../loopback';
export type WebPassage = { url: string; title: string; content: string };
/** Where a search goes when nothing is set: a SearXNG instance on this machine. */
export const DEFAULT_SEARXNG = 'http://localhost:8888';
/** Triple Check searches only through a SearXNG instance on this machine (F100.1, Matt 2026-10-28: no API
 *  services off this device other than the web GET). Hosted search settings saved earlier are refused. */
export function searchConfigurationError(s: SettingsRecord): string | null {
  if (s.tripleCheckWebEnabled === false) return 'Web not checked: disabled for this space.';
  if (s.tripleCheckSearch && s.tripleCheckSearch !== 'searxng') return 'Web not checked: only a SearXNG instance on this machine is supported.';
  if (s.tripleCheckScrape && s.tripleCheckScrape !== 'snippets') return 'Web not checked: only search passages are supported.';
  if (!isLoopbackUrl(s.searxngBaseUrl ?? DEFAULT_SEARXNG)) return 'Web not checked: the SearXNG address must be on this machine.';
  return null;
}
/** A SearXNG instance on this machine: a plain GET, no account, no key. It still queries public search
 *  engines from your machine. It must list `json` under search.formats and allow this app's origin (CORS), or
 *  the browser blocks the response; both are settings on the instance, not here. */
export async function searxng(base: string, query: string, signal: AbortSignal): Promise<WebPassage[]> {
  const url = new URL('search', base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('q', query); url.searchParams.set('format', 'json');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`SearXNG request failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data?.results)) throw new Error('Invalid SearXNG response');
  return data.results.filter((r: Record<string, unknown>) => typeof r.url === 'string' && typeof r.title === 'string').slice(0, 5)
    .map((r: Record<string, string>) => ({ url: r.url, title: r.title, content: typeof r.content === 'string' ? r.content : '' }));
}
export async function searchTripleCheck(s: SettingsRecord, query: string, signal: AbortSignal): Promise<WebPassage[]> {
  if (searchConfigurationError(s)) throw new Error('Search not configured.');
  return searxng(s.searxngBaseUrl ?? DEFAULT_SEARXNG, query, signal);
}
/** The search passage is the evidence. Reading whole pages through a hosted scraper is not offered. */
export async function scrapeTripleCheck(s: SettingsRecord, source: WebPassage, _signal: AbortSignal): Promise<WebPassage> {
  if (s.tripleCheckScrape && s.tripleCheckScrape !== 'snippets') throw new Error('Only search passages are supported.');
  return source;
}
