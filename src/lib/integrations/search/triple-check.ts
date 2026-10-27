import type { SettingsRecord } from '$lib/storage/db';
import { tavilySearch } from './tavily';
export type WebPassage = { url: string; title: string; content: string };
export function searchConfigurationError(s: SettingsRecord): string | null {
  if (s.tripleCheckWebEnabled === false) return 'Web not checked: disabled for this space.';
  if (s.tripleCheckSearch === 'searxng') { if (!s.searxngBaseUrl) return 'Web not checked: no SearXNG address is set.'; }
  else if (s.tripleCheckSearch === 'firecrawl' ? !s.firecrawlApiKey : !s.tavilyApiKey) return 'Web not checked: search credentials are missing.';
  if (s.tripleCheckScrape === 'firecrawl' && !s.firecrawlApiKey) return 'Web not checked: scraping credentials are missing.';
  return null;
}
async function firecrawl(s: SettingsRecord, endpoint: string, body: object, signal: AbortSignal) {
  const res = await fetch(`https://api.firecrawl.dev/v2/${endpoint}`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.firecrawlApiKey}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firecrawl request failed');
  const data = await res.json(); if (!data.success) throw new Error('Firecrawl incomplete response'); return data.data;
}
/** A self-hosted SearXNG instance: no account and no key, but it still queries public search engines from
 *  your machine. It must list `json` under search.formats and allow this app's origin (CORS), or the browser
 *  blocks the response; both are settings on the instance, not here. */
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
  if (s.tripleCheckSearch === 'searxng') return searxng(s.searxngBaseUrl!, query, signal);
  if (s.tripleCheckSearch !== 'firecrawl') return (await tavilySearch(s.tavilyApiKey!, query, 5, signal)).results;
  const result = await firecrawl(s, 'search', { query, limit: 5, sources: ['web'] }, signal);
  if (!Array.isArray(result?.web)) throw new Error('Invalid search response');
  return result.web.filter((r: Record<string, unknown>) => typeof r.url === 'string' && typeof r.title === 'string').map((r: Record<string, string>) => ({ url: r.url, title: r.title, content: r.markdown ?? r.description ?? '' }));
}
export async function scrapeTripleCheck(s: SettingsRecord, source: WebPassage, signal: AbortSignal): Promise<WebPassage> {
  if (s.tripleCheckScrape !== 'firecrawl') return source;
  const result = await firecrawl(s, 'scrape', { url: source.url, formats: ['markdown'], onlyMainContent: true }, signal);
  if (typeof result?.markdown !== 'string') throw new Error('Invalid page response');
  return { ...source, content: result.markdown.slice(0, 12000) };
}
