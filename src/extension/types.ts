/** Shared types for the Reckons.AI browser extension. */

export interface HighlightSettings {
  conflictColor: string;    // hex
  reinforceColor: string;   // hex
  newColor: string;         // hex
  saturation: number;       // 0–100
  labelFontSize: number;    // px — base size of the always-visible label
  labelHoverScale: number;  // multiplier on hover, e.g. 1.6 = 160%
  labelFontFamily: string;  // e.g. 'monospace', 'sans-serif', 'serif'
}

export const DEFAULT_HIGHLIGHT_SETTINGS: HighlightSettings = {
  conflictColor:   '#ef4444',
  reinforceColor:  '#22c55e',
  newColor:        '#63b3ed',
  saturation:      100,
  labelFontSize:   10,
  labelHoverScale: 1.6,
  labelFontFamily: 'monospace',
};

export interface ExtSettings {
  apiKey: string;
  apiProvider: 'claude' | 'openai' | 'gemini';
  apiModel: string;
  /** Base URL of the running Reckons.AI web app, e.g. http://localhost:5173 */
  reckonsUrl: string;
  highlight: HighlightSettings;
}

// Resolve provider/key/model from build-time env vars (VITE_ prefix baked in by Vite).
// This lets the extension reuse whatever is already configured in .env without manual
// entry in the options page.
const _envBackend = (import.meta.env.VITE_PREFERRED_BACKEND ?? 'claude') as string;
const _extProvider: ExtSettings['apiProvider'] =
  (_envBackend === 'openai' || _envBackend === 'gemini') ? _envBackend : 'claude';

const _envKey =
  _extProvider === 'openai' ? (import.meta.env.VITE_OPENAI_API_KEY ?? '')
  : _extProvider === 'gemini' ? (import.meta.env.VITE_GEMINI_API_KEY ?? '')
  : (import.meta.env.VITE_ANTHROPIC_API_KEY ?? '');

const _envModel =
  _extProvider === 'openai' ? (import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4o-mini')
  : _extProvider === 'gemini' ? (import.meta.env.VITE_GEMINI_MODEL ?? 'gemini-2.0-flash')
  : (import.meta.env.VITE_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001');

export const DEFAULT_SETTINGS: ExtSettings = {
  apiKey: _envKey,
  apiProvider: _extProvider,
  apiModel: _envModel,
  reckonsUrl: 'http://localhost:5173',
  highlight: { ...DEFAULT_HIGHLIGHT_SETTINGS },
};

// ── KB Snapshot ──────────────────────────────────────────────────────────────

export interface KBEntity {
  iri: string;
  label: string;
  type: string | null;
  predicates: string[]; // "predSlug → value" strings
}

export interface KBSnapshot {
  entities: KBEntity[];
  entityCount: number;
  capturedAt: number;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

export type TripleKind = 'reinforce' | 'conflict' | 'new';

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
  /** Verbatim text span from the page that supports this triple */
  textSpan: string;
  kind: TripleKind;
  /** Human-readable note about what it conflicts with (kind === 'conflict') */
  conflictNote?: string;
}

export interface DiffSummary {
  new: string;
  reinforcing: string;
  conflicting: string;
}

export interface AnalysisResult {
  url: string;
  title: string;
  triples: ExtractedTriple[];
  /** Structured diff summary; legacy string accepted for backwards compat */
  summary: DiffSummary | string;
  analyzedAt: number;
}

// ── Research Session ────────────────────────────────────────────────────────

export interface ResearchSession {
  pages: AnalysisResult[];
  startedAt: number;
  /** Optional research focus carried across all pages */
  focus?: string;
}

// ── Message protocol ─────────────────────────────────────────────────────────

/** Popup → Background */
export type PopupRequest =
  | { type: 'GET_STATE' }
  | { type: 'ANALYZE_PAGE'; focus?: string }
  | { type: 'HIGHLIGHT_PAGE' }
  | { type: 'CLEAR_HIGHLIGHTS' }
  | { type: 'SYNC_KB' }
  | { type: 'DISCARD_RESULT' }
  | { type: 'OPEN_COMPARE' }
  | { type: 'OPEN_INGEST' }
  | { type: 'DO_INGEST'; url: string; title: string; triples: Array<{ subject: string; predicate: string; object: string; kind: string }> }
  | { type: 'BUILD_PROMPT'; focus?: string }
  | { type: 'PARSE_RESPONSE'; text: string }
  | { type: 'CLEAR_SESSION' }
  | { type: 'REMOVE_SESSION_PAGE'; url: string }
  | { type: 'INGEST_SESSION'; kinds: ('new' | 'conflict' | 'reinforce')[] };

/** Background → Popup (response or push) */
export type BackgroundEvent =
  | { type: 'STATE'; state: ExtensionState }
  | { type: 'ERROR'; message: string }
  | { type: 'INGEST_RESULT'; status: 'started' | 'opened' | 'error'; message?: string }
  | { type: 'PROMPT_READY'; prompt: string };

export interface ExtensionState {
  settings: ExtSettings;
  snapshot: KBSnapshot | null;
  result: AnalysisResult | null;
  session: ResearchSession;
  analyzing: boolean;
  highlightsActive: boolean;
  currentTabId: number | null;
}

/** Background → Content Script */
export type ContentCommand =
  | { type: 'GET_TEXT' }
  | { type: 'HIGHLIGHT'; triples: ExtractedTriple[] }
  | { type: 'CLEAR_HIGHLIGHTS' }
  | { type: 'GET_KB_SNAPSHOT' };

/** Content Script → Background */
export type ContentResponse =
  | { type: 'TEXT'; text: string; title: string; url: string }
  | { type: 'HIGHLIGHTED'; count: number }
  | { type: 'CLEARED' }
  | { type: 'KB_SNAPSHOT'; snapshot: KBSnapshot | null };
