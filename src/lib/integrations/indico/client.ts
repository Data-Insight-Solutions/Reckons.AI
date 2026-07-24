/**
 * Indico HTTP Export API client.
 * Fetches events from a self-hosted Indico instance.
 * Supports both public and API-token-authenticated access.
 */

import type { IndicoEvent, IndicoSearchOptions, IndicoSearchResponse, IndicoConfig } from './types';

const DEFAULT_LIMIT = 50;

export class IndicoClient {
  private baseUrl: string;
  private apiToken: string | undefined;

  constructor(config: IndicoConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
  }

  private async request(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(`${this.baseUrl}${endpoint}`);

    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.append(k, v);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };

    // Auth: modern Indico (3.x) PERSONAL TOKENS are `indp_…` and MUST go in the Authorization
    // header — passing one as the legacy `ak=` query param returns 400 "Malformed API key"
    // (verified against a live Indico 3.x server, which is exactly what silently broke this
    // integration). Only the legacy fixed API keys use `ak=`, so route by the token's shape.
    if (this.apiToken) {
      if (this.apiToken.startsWith('indp_')) {
        headers.Authorization = `Bearer ${this.apiToken}`;
      } else {
        url.searchParams.append('ak', this.apiToken);
      }
    }

    const res = await fetch(url.toString(), { headers });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Indico ${res.status}: ${body}`);
    }

    return res.json();
  }

  /** Fetch events from a category (or root if no categoryId). */
  async fetchEvents(categoryId?: string, options: IndicoSearchOptions = {}): Promise<IndicoSearchResponse> {
    const { startDate, endDate, limit = DEFAULT_LIMIT } = options;

    const params: Record<string, string> = { pretty: 'yes' };
    if (startDate) params.from = startDate;
    if (endDate) params.to = endDate;

    const catPath = categoryId ? `/export/categ/${categoryId}.json` : '/export/categ/0.json';
    const data = await this.request(catPath, params);

    const events: IndicoEvent[] = (data.results ?? []).map(mapRawEvent);

    return {
      results: events.slice(0, limit),
      count: data.count ?? events.length,
      complete: data.complete ?? true
    };
  }

  /** Search events by keyword. */
  async searchEvents(term: string, options: IndicoSearchOptions = {}): Promise<IndicoSearchResponse> {
    const { page = 1, limit = DEFAULT_LIMIT, startDate, endDate, categories } = options;

    const params: Record<string, string> = { pretty: 'yes' };
    if (startDate) params.from = startDate;
    if (endDate) params.to = endDate;
    if (categories?.length) params.categ = categories.join(',');

    const data = await this.request(
      `/export/event/search/${encodeURIComponent(term)}.json`,
      params
    );

    const events: IndicoEvent[] = (data.results ?? []).map(mapRawEvent);
    const start = (page - 1) * limit;

    return {
      results: events.slice(start, start + limit),
      count: data.count ?? events.length,
      complete: data.complete ?? true
    };
  }

  /** Fetch a single event by ID. */
  async getEvent(id: string): Promise<IndicoEvent | null> {
    const data = await this.request(`/export/event/${id}.json`, { pretty: 'yes', occ: 'yes' });
    if (!data.results?.length) return null;
    return mapRawEvent(data.results[0]);
  }

  /** Fetch available categories. Returns category names from root. */
  async getCategories(): Promise<string[]> {
    try {
      const data = await this.request('/export/categ/0.json', { limit: '0' });
      // Extract unique category names from results metadata
      const cats = new Set<string>();
      for (const ev of data.results ?? []) {
        if (ev.category) cats.add(ev.category);
      }
      return [...cats].sort();
    } catch {
      return [];
    }
  }

  /** Force-sync: fetch all upcoming events (today onward). */
  async forceSync(categoryId?: string): Promise<IndicoEvent[]> {
    const today = new Date().toISOString().split('T')[0];
    const resp = await this.fetchEvents(categoryId, { startDate: today, limit: 500 });
    return resp.results;
  }
}

function mapRawEvent(raw: any): IndicoEvent {
  return {
    id: String(raw.id),
    title: raw.title ?? '',
    startDate: raw.startDate ?? { date: '', time: '00:00:00', tz: 'UTC' },
    endDate: raw.endDate,
    category: raw.category,
    type: raw.type ?? 'Event',
    description: raw.description,
    url: raw.url,
    location: raw.location,
    hasAnyProtection: raw.hasAnyProtection ?? false,
    organizers: raw.organizers,
    contacts: raw.contacts,
    speakers: raw.speakers
  };
}

/** Create a client from settings values. Returns null if no server URL configured. */
export function createIndicoClient(serverUrl: string | undefined, apiToken?: string): IndicoClient | null {
  if (!serverUrl?.trim()) return null;
  return new IndicoClient({ serverUrl: serverUrl.trim(), apiToken: apiToken?.trim() || undefined });
}
