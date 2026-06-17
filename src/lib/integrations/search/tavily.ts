/**
 * Tavily AI Search — web search optimized for AI/RAG applications.
 * Free tier: 1,000 searches/month. https://tavily.com
 *
 * Used by the KB enrichment pipeline to find facts about entities
 * that the KB likely has gaps on (Open World Assumption).
 */

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

/**
 * Search the web for facts relevant to a query.
 * Returns up to `maxResults` snippets ranked by relevance.
 */
export async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults = 5,
): Promise<TavilyResponse> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: true,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json() as TavilyResponse;
  return json;
}
