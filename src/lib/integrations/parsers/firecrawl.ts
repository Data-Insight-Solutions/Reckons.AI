/**
 * Firecrawl — JS-rendered web scraping for URL ingestion.
 *
 * Falls back to Jina Reader when no Firecrawl key is configured.
 * Firecrawl handles SPAs, paywalls, and complex layouts that Jina misses.
 *
 * API docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */

const FIRECRAWL_URL = 'https://api.firecrawl.dev/v1/scrape';

export async function fetchWithFirecrawl(
  url: string,
  apiKey: string
): Promise<{ title: string; text: string }> {
  const res = await fetch(FIRECRAWL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: 1000 // ms — allow JS to render
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firecrawl ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const markdown: string = data?.data?.markdown ?? '';
  const title: string =
    data?.data?.metadata?.title ??
    data?.data?.metadata?.ogTitle ??
    url;

  return { title, text: markdown };
}
