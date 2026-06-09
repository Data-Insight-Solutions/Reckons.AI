/**
 * Indico event types — matches the Indico HTTP Export API response shape.
 */

export interface IndicoDateTime {
  date: string;   // "2025-03-15"
  time: string;   // "14:00:00"
  tz: string;     // "America/Chicago"
}

export interface IndicoContact {
  name: string;
  email?: string;
  phone?: string;
  role: string;
  affiliation?: string;
}

export interface IndicoEvent {
  id: string;
  title: string;
  startDate: IndicoDateTime;
  endDate?: IndicoDateTime;
  category?: string;
  type?: string;
  description?: string;
  url?: string;
  location?: string;
  hasAnyProtection: boolean;
  organizers?: IndicoContact[];
  contacts?: IndicoContact[];
  speakers?: IndicoContact[];
}

export interface IndicoSearchResponse {
  results: IndicoEvent[];
  count: number;
  complete: boolean;
}

export interface IndicoSearchOptions {
  page?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
  categories?: string[];
}

export interface IndicoConfig {
  serverUrl: string;
  apiToken?: string;
  categoryId?: string;
}
