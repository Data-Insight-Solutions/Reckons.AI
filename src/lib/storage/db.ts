import Dexie, { type Table } from 'dexie';
import type { Statement, Source, TurtleSettings } from '../rdf/types';
import type { ChangeLogEntry, MergeDecision, TrustEvent } from './types';
import type { HighlightSettings } from '../../extension/types';

/**
 * Persistent storage for the personal KB. All data lives in IndexedDB so the
 * app works fully offline and survives reloads. No data leaves the device
 * unless the user explicitly invokes Claude or exports a Turtle file.
 */

/** A step in a user-defined KB story (played in Shelly's explore tab). */
export type KbStoryStep = {
  title: string;
  content: string;
  /** Entity IRIs to highlight in the graph during this step */
  highlights?: string[];
};

export type SettingsRecord = {
  key: 'main' | 'user-defaults';
  claudeApiKey?: string;
  claudeModel: string;
  openaiApiKey?: string;
  openaiModel: string;
  geminiApiKey?: string;
  geminiModel: string;
  wasmModel: string;
  /** Per-task WASM model overrides — fall back to wasmModel when absent */
  wasmIngestModel?: string;
  wasmAnalyzeModel?: string;
  wasmChatModel?: string;
  preferredBackend: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'mock' | 'openrouter' | 'chrome-ai' | 'reckons';
  /** Per-task backend overrides — fall back to preferredBackend when absent */
  ingestBackend?: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'mock' | 'openrouter' | 'chrome-ai' | 'reckons';
  analyzeBackend?: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'openrouter' | 'chrome-ai' | 'reckons';
  chatBackend?: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'openrouter' | 'chrome-ai' | 'reckons';
  /** Sub-task overrides within analyze — fall back to analyzeBackend when absent */
  diffSummaryBackend?: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'openrouter' | 'chrome-ai' | 'reckons';
  mergeAnalysisBackend?: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'openrouter' | 'chrome-ai' | 'reckons';
  ollamaModel: string;
  ollamaBaseUrl: string;
  /**
   * Ollama extraction prompt-variant override. 'auto' (default when unset)
   * picks the compact small-model prompt via a model-name heuristic; force
   * 'compact' or 'full' to bypass the heuristic.
   */
  ollamaPromptMode?: 'auto' | 'compact' | 'full';
  /**
   * Enables schema-constrained decoding for Ollama extraction (native
   * `/api/chat` `format` parameter). Defaults to true when unset; set to
   * false to always use the plain OpenAI-compatible chat path.
   */
  ollamaStructuredExtraction?: boolean;
  /**
   * Prefer-local routing: when true and Ollama is reachable, chat, diff
   * summary, and merge analysis default to the ollama backend unless a
   * per-task override says otherwise. See src/lib/integrations/llm/prefer-local.ts.
   */
  preferLocal?: boolean;
  /** Embedding model used for similarity, clustering, and alignment */
  embeddingModel?: string;
  embeddingThreshold: number;
  autoConfirmHighConfidence: boolean;
  humeAiApiKey?: string;
  openrouterApiKey?: string;
  openrouterModel: string;
  turtleSettings: TurtleSettings;
  /** Run KB re-analysis automatically after each source import */
  autoAnalyzeOnImport?: boolean;
  /** Periodic re-analysis interval in minutes. 0 or absent = disabled. */
  autoAnalyzeIntervalMinutes?: number;
  /** Google OAuth client ID (from Google Cloud Console) */
  googleClientId?: string;
  /** ID of the dedicated "Reckons.AI KB" Google Calendar (set after first connect) */
  googleCalendarId?: string;
  /** Human-readable name for this knowledge base */
  kbTitle?: string;
  /** What this KB is about — used to guide re-analysis and AI prompts */
  kbDescription?: string;
  /** Central guidance text for all analyze operations. Pre-fills from kbTitle + kbDescription. */
  analyzeGuidance?: string;
  /** Custom prompts per analyze type — overrides built-in defaults when set */
  analyzePrompts?: Partial<Record<'enrich' | 'merge' | 'entity-types' | 'delete', string>>;
  /** User-defined guided story for this KB (played in Shelly's explore tab) */
  kbStory?: KbStoryStep[];
  /**
   * Stable UUID identity for this KB — generated once on first use, never changes.
   * Used for MCP routing, cloud sync folder naming, and cross-device references.
   */
  kbStableId?: string;
  /** Highlight appearance settings synced to the browser extension */
  extensionHighlight?: HighlightSettings;
  /** Mistral API key — used for Mistral OCR (PDF/image parsing) */
  mistralApiKey?: string;
  /** Firecrawl API key — JS-rendered web scraping, replaces Jina Reader when set */
  firecrawlApiKey?: string;
  /** Reckons.AI Cloud Workers — managed AI inference hosted on Cloudflare Workers */
  reckonsApiKey?: string;
  reckonsModel?: string;
  reckonsBaseUrl?: string;
  /** Active mobile access sessions (QR-linked devices) */
  mobileSessions?: MobileSession[];
  /** Meshy.AI API key for text-to-3D node icon generation */
  meshyApiKey?: string;
  /** Hume.AI Secret Key — used with apiKey to generate an access token (more secure than apiKey alone) */
  humeSecretKey?: string;
  /** Hume.AI EVI Config ID — the custom voice persona configured in the Hume portal */
  humeConfigId?: string;
  /** Custom personality prompt override for Shelly (prepended to system prompt) */
  shellyCustomPrompt?: string;
  /** Base font size (px) for always-visible graph node labels */
  nodeLabelFontSize?: number;
  /** Prefer 2D canvas renderer over 3D WebGL */
  prefer2D?: boolean;
  /** Always render entity preview images on nodes (no hover needed). Slower to paint. */
  alwaysShowPreviews?: boolean;
  /** Overall UI text scale. 'sm' = 14px, 'md' = 16px (default), 'lg' = 18px root font. */
  uiScale?: 'sm' | 'md' | 'lg';
  /**
   * Whether to auto-save the KB to a local file after each mutation.
   * The actual FileSystemFileHandle is held in-memory by backup.ts and must
   * be re-linked each session via pickAutoSaveFile().
   */
  autoSaveEnabled?: boolean;
  /**
   * Display name of the selected local Workspace folder.
   * The actual FileSystemDirectoryHandle is stored in the `workspace` IndexedDB table
   * and must be re-granted permission each browser session.
   */
  workspaceName?: string;
  /** Indico server base URL (e.g. https://indico.example.com). Set via ?indico= query param or settings. */
  indicoServerUrl?: string;
  /** Indico API token for authenticated access to protected events */
  indicoApiToken?: string;
  /** Indico category ID to filter events (omit for root/all) */
  indicoCategoryId?: string;
  /** Last successful Indico sync timestamp */
  indicoLastSync?: number;
  /** Tavily API key — AI-optimized web search for KB enrichment (free tier: 1k searches/mo) */
  tavilyApiKey?: string;
  /** GitHub personal access token — enables repo ingest and higher API rate limits */
  githubToken?: string;
  /** Refresh all refreshable sources (URL, repo, calendar) when KB is opened */
  autoRefreshOnOpen?: boolean;
  /** Periodic source refresh interval in minutes. 0 or absent = disabled. */
  autoRefreshIntervalMinutes?: number;
  /** Show contextual tutorial nudges for first-time users */
  showTutorialHints?: boolean;
  /**
   * Base URL of the self-hosted n8n instance used for Cloud Sync (F20) and
   * Currents (F29.2). E.g. "https://n8n.example.com" — no trailing slash,
   * no /webhook suffix (callers append that per-endpoint).
   */
  n8nBaseUrl?: string;
  /**
   * When set, POST a small summary to the n8n review webhook
   * (/webhook/reckons-review) whenever new facts land for review — so n8n can
   * email you instead of you having to open the graph. Covers scraped grant
   * calls (currents), pod arrivals, and any pending ingest. Opt-in; needs
   * n8nBaseUrl. See src/lib/integrations/n8n/notify.ts.
   */
  n8nNotifyOnReview?: boolean;
};

export const DEFAULT_TURTLE_SETTINGS: TurtleSettings = {
  name: import.meta.env.VITE_SHELLY_NAME ?? 'Shelly',
  greeting: import.meta.env.VITE_SHELLY_GREETING ?? '',
  personality: (import.meta.env.VITE_SHELLY_PERSONALITY as TurtleSettings['personality']) ?? 'helpful',
  systemPrompt: import.meta.env.VITE_SHELLY_PROMPT ?? '',
  responseStyle: (import.meta.env.VITE_SHELLY_RESPONSE_STYLE as TurtleSettings['responseStyle']) ?? 'concise',
  maxResponseWords: parseInt(import.meta.env.VITE_SHELLY_MAX_WORDS ?? '0', 10) || 0,
  patienceLevel: 75,
  engagement: 'medium',
  voiceEnabled: false,
  voiceType: 'tts',
  kokoroVoice: 'af_heart',
  speechRate: 0.75,
  volume: 75,
  humeApiKey: import.meta.env.VITE_HUME_API_KEY ?? '',
  humeSecretKey: import.meta.env.VITE_HUME_SECRET_KEY ?? '',
  humeConfigId: import.meta.env.VITE_HUME_CONFIG_ID ?? '',
  whisperModel: 'onnx-community/whisper-tiny',
  animationSpeed: 'normal',
  opacity: 100,
  size: 'medium',
  glowEffect: true,
  positionSticky: false,
  position: { x: 100, y: 100 },
  wanderRange: 20,
  clickBindings: {
    single: 'context-menu',
    double: 'help',
    right: 'quick-actions'
  },
  proactiveHelp: 'errors-only',
  showTutorialHints: true,
  responseFrequency: 50
};

export const DEFAULT_SETTINGS: SettingsRecord = {
  key: 'main',
  claudeApiKey: import.meta.env.VITE_ANTHROPIC_API_KEY || undefined,
  claudeModel: import.meta.env.VITE_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001',
  openaiApiKey: import.meta.env.VITE_OPENAI_API_KEY || undefined,
  openaiModel: import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4o-mini',
  geminiApiKey: import.meta.env.VITE_GEMINI_API_KEY || undefined,
  geminiModel: import.meta.env.VITE_GEMINI_MODEL ?? 'gemini-2.0-flash',
  wasmModel: import.meta.env.VITE_WASM_MODEL ?? 'onnx-community/Qwen2.5-0.5B-Instruct',
  preferredBackend: (import.meta.env.VITE_PREFERRED_BACKEND as SettingsRecord['preferredBackend']) ?? 'claude',
  ingestBackend: (import.meta.env.VITE_INGEST_BACKEND as SettingsRecord['ingestBackend']) || undefined,
  analyzeBackend: (import.meta.env.VITE_ANALYZE_BACKEND as SettingsRecord['analyzeBackend']) || undefined,
  chatBackend: (import.meta.env.VITE_CHAT_BACKEND as SettingsRecord['chatBackend']) || undefined,
  ollamaModel: import.meta.env.VITE_OLLAMA_MODEL ?? 'llama3.2',
  ollamaBaseUrl: import.meta.env.VITE_OLLAMA_BASE_URL ?? 'http://localhost:11434',
  preferLocal: import.meta.env.VITE_PREFER_LOCAL === 'true' || undefined,
  openrouterApiKey: import.meta.env.VITE_OPENROUTER_API_KEY || undefined,
  openrouterModel: import.meta.env.VITE_OPENROUTER_MODEL ?? 'meta-llama/llama-3.2-3b-instruct:free',
  humeAiApiKey: import.meta.env.VITE_HUME_API_KEY || undefined,
  humeSecretKey: import.meta.env.VITE_HUME_SECRET_KEY || undefined,
  humeConfigId: import.meta.env.VITE_HUME_CONFIG_ID || undefined,
  mistralApiKey: import.meta.env.VITE_MISTRAL_API_KEY || undefined,
  firecrawlApiKey: import.meta.env.VITE_FIRECRAWL_API_KEY || undefined,
  reckonsApiKey: import.meta.env.VITE_RECKONS_API_KEY || undefined,
  reckonsModel: import.meta.env.VITE_RECKONS_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
  reckonsBaseUrl: import.meta.env.VITE_RECKONS_BASE_URL ?? 'https://api.reckons.ai',
  meshyApiKey: import.meta.env.VITE_MESHY_API_KEY || undefined,
  kbTitle: import.meta.env.VITE_KB_TITLE || undefined,
  kbDescription: import.meta.env.VITE_KB_DESCRIPTION || undefined,
  shellyCustomPrompt: import.meta.env.VITE_SHELLY_PROMPT || undefined,
  embeddingModel: import.meta.env.VITE_EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5',
  n8nBaseUrl: import.meta.env.VITE_N8N_BASE_URL || undefined,
  n8nNotifyOnReview: false,
  embeddingThreshold: 0.85,
  autoConfirmHighConfidence: false,
  turtleSettings: { ...DEFAULT_TURTLE_SETTINGS }
};

function resolveDbName(): string {
  if (typeof window === 'undefined') return 'kbase';
  // Per-tab KB: check URL ?kb= param, then sessionStorage, then localStorage
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('kb');
    if (fromUrl) return fromUrl;
  } catch { /* ignore */ }
  return sessionStorage.getItem('sessionKbId')
    ?? localStorage.getItem('currentKbId')
    ?? 'kbase';
}

/** Editor-level GLB model override. Never exported to Turtle/RDF. */
export type GlbOverrideRow = { id: string; url: string };

/** Editor-level 2D icon override. URL or data URL for per-entity 2D graph icon. */
export type Icon2dOverrideRow = { id: string; url: string };

/**
 * Per-entity GIF preview. Exported to Turtle as urn:kbase:meta/gifPreview triples
 * and packaged into kb-export.zip alongside the .ttl file.
 */
export type EntityGifRow = { id: string; blob: Blob; filename: string };

export type MobileSession = {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  deviceName?: string;
};

export type WorkspaceRow = { id: string; handle: FileSystemDirectoryHandle; name: string };

export class KBaseDB extends Dexie {
  sources!: Table<Source, string>;
  statements!: Table<Statement, string>;
  settings!: Table<SettingsRecord, string>;
  changelog!: Table<ChangeLogEntry>;
  mergeDecisions!: Table<MergeDecision>;
  trustEvents!: Table<TrustEvent>;
  glbOverrides!: Table<GlbOverrideRow, string>;
  workspace!: Table<WorkspaceRow, string>;
  entityGifs!: Table<EntityGifRow, string>;
  icon2dOverrides!: Table<Icon2dOverrideRow, string>;

  constructor(name?: string) {
    super(name ?? resolveDbName());
    this.version(1).stores({
      sources: 'id, ingestedAt, kind',
      // composite index lets us answer (subject, predicate) lookups fast
      statements: 'id, sourceId, status, [s.value+p.value], createdAt',
      settings: 'key'
    });
    this.version(2).stores({
      sources: 'id, ingestedAt, kind, trustLevel',
      statements: 'id, sourceId, status, [s.value+p.value], createdAt',
      settings: 'key',
      changelog: '++id, timestamp, action, statementId, sourceId, entityKey',
      mergeDecisions: '++id, timestamp, entityKeyA, entityKeyB',
      trustEvents: '++id, timestamp, sourceId'
    });
    this.version(3).stores({
      sources: 'id, ingestedAt, kind, trustLevel',
      statements: 'id, sourceId, status, [s.value+p.value], createdAt',
      settings: 'key',
      changelog: '++id, timestamp, action, statementId, sourceId, entityKey',
      mergeDecisions: '++id, timestamp, entityKeyA, entityKeyB',
      trustEvents: '++id, timestamp, sourceId',
      glbOverrides: 'id'
    });
    this.version(4).stores({
      sources: 'id, ingestedAt, kind, trustLevel',
      statements: 'id, sourceId, status, [s.value+p.value], createdAt',
      settings: 'key',
      changelog: '++id, timestamp, action, statementId, sourceId, entityKey',
      mergeDecisions: '++id, timestamp, entityKeyA, entityKeyB',
      trustEvents: '++id, timestamp, sourceId',
      glbOverrides: 'id',
      workspace: 'id'
    });
    this.version(5).stores({
      sources: 'id, ingestedAt, kind, trustLevel',
      statements: 'id, sourceId, status, [s.value+p.value], createdAt',
      settings: 'key',
      changelog: '++id, timestamp, action, statementId, sourceId, entityKey',
      mergeDecisions: '++id, timestamp, entityKeyA, entityKeyB',
      trustEvents: '++id, timestamp, sourceId',
      glbOverrides: 'id',
      workspace: 'id',
      entityGifs: 'id'
    });
    this.version(6).stores({
      sources: 'id, ingestedAt, kind, trustLevel',
      statements: 'id, sourceId, status, [s.value+p.value], createdAt',
      settings: 'key',
      changelog: '++id, timestamp, action, statementId, sourceId, entityKey',
      mergeDecisions: '++id, timestamp, entityKeyA, entityKeyB',
      trustEvents: '++id, timestamp, sourceId',
      glbOverrides: 'id',
      workspace: 'id',
      entityGifs: 'id',
      icon2dOverrides: 'id'
    });
  }
}

export const db = new KBaseDB();

export async function getSettings(): Promise<SettingsRecord> {
  const s = await db.settings.get('main');
  const base: SettingsRecord = s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;
  if (!s) await db.settings.put(DEFAULT_SETTINGS);

  // Migrate stale WASM model references from older versions (e.g. Xenova/ namespace)
  const STALE_MODELS = ['Xenova/Qwen2.5-0.5B-Instruct', 'Xenova/', 'HuggingFaceTB/SmolLM2-360M-Instruct'];
  const isStale = (m: string | undefined) => m && STALE_MODELS.some(p => m.startsWith(p));
  if (isStale(base.wasmModel)) {
    base.wasmModel = DEFAULT_SETTINGS.wasmModel;
    db.settings.update('main', { wasmModel: base.wasmModel }).catch(() => {});
  }
  for (const field of ['wasmIngestModel', 'wasmAnalyzeModel', 'wasmChatModel'] as const) {
    if (isStale(base[field])) {
      base[field] = undefined;
      db.settings.update('main', { [field]: undefined }).catch(() => {});
    }
  }

  // Test-only override: Playwright sets localStorage['__reckons_test_backend__']
  // before page load to force a specific backend without touching IndexedDB.
  // This key is never set in production.
  if (typeof window !== 'undefined') {
    const testBackend = localStorage.getItem('__reckons_test_backend__') as SettingsRecord['preferredBackend'] | null;
    if (testBackend) {
      base.preferredBackend = testBackend;
      base.ingestBackend = testBackend as SettingsRecord['ingestBackend'];
      base.analyzeBackend = testBackend as SettingsRecord['analyzeBackend'];
      base.chatBackend = testBackend as SettingsRecord['chatBackend'];
    }
    // Pin the Ollama model for live-LLM tests (installed tags differ per machine).
    const testOllamaModel = localStorage.getItem('__reckons_test_ollama_model__');
    if (testOllamaModel) base.ollamaModel = testOllamaModel;
  }
  return base;
}

// ── User-defaults snapshot ───────────────────────────────────────────────────

/**
 * Save the current settings as the user's personal defaults.
 * Stored in the same table under key 'user-defaults'; API keys are included
 * so the user can fully restore their own setup on the same device.
 * The exported settings PROFILE (backup.ts) strips keys for safe sharing.
 */
export async function saveUserDefaults(current: SettingsRecord): Promise<void> {
  await db.settings.put({ ...current, key: 'user-defaults' });
}

export async function getUserDefaults(): Promise<SettingsRecord | null> {
  const s = await db.settings.get('user-defaults' as 'main');
  return s ?? null;
}

export async function clearUserDefaults(): Promise<void> {
  await db.settings.delete('user-defaults' as 'main');
}

export async function saveSettings(patch: Partial<SettingsRecord>): Promise<void> {
  try {
    const cur = await getSettings();
    // Merge patch over current DB values, then build a plain serializable object.
    // turtleSettings is JSON round-tripped to strip any Svelte 5 reactive proxy.
    const m = { ...cur, ...patch };
    const toSave: SettingsRecord = {
      key: 'main',
      claudeApiKey: m.claudeApiKey,
      claudeModel: m.claudeModel,
      openaiApiKey: m.openaiApiKey,
      openaiModel: m.openaiModel,
      geminiApiKey: m.geminiApiKey,
      geminiModel: m.geminiModel,
      wasmModel: m.wasmModel,
      wasmIngestModel: m.wasmIngestModel,
      wasmAnalyzeModel: m.wasmAnalyzeModel,
      wasmChatModel: m.wasmChatModel,
      preferredBackend: m.preferredBackend,
      ingestBackend: m.ingestBackend,
      analyzeBackend: m.analyzeBackend,
      chatBackend: m.chatBackend,
      diffSummaryBackend: m.diffSummaryBackend,
      mergeAnalysisBackend: m.mergeAnalysisBackend,
      ollamaModel: m.ollamaModel,
      ollamaBaseUrl: m.ollamaBaseUrl,
      ollamaPromptMode: m.ollamaPromptMode,
      ollamaStructuredExtraction: m.ollamaStructuredExtraction,
      embeddingThreshold: m.embeddingThreshold,
      autoConfirmHighConfidence: m.autoConfirmHighConfidence,
      humeAiApiKey: m.humeAiApiKey,
      humeSecretKey: m.humeSecretKey,
      openrouterApiKey: m.openrouterApiKey,
      openrouterModel: m.openrouterModel,
      googleClientId: m.googleClientId,
      googleCalendarId: m.googleCalendarId,
      autoAnalyzeOnImport: m.autoAnalyzeOnImport,
      autoAnalyzeIntervalMinutes: m.autoAnalyzeIntervalMinutes,
      kbTitle: m.kbTitle,
      kbDescription: m.kbDescription,
      kbStableId: m.kbStableId,
      extensionHighlight: m.extensionHighlight ? JSON.parse(JSON.stringify(m.extensionHighlight)) : undefined,
      mistralApiKey: m.mistralApiKey,
      firecrawlApiKey: m.firecrawlApiKey,
      reckonsApiKey: m.reckonsApiKey,
      reckonsModel: m.reckonsModel,
      reckonsBaseUrl: m.reckonsBaseUrl,
      mobileSessions: m.mobileSessions ? JSON.parse(JSON.stringify(m.mobileSessions)) : undefined,
      meshyApiKey: m.meshyApiKey,
      nodeLabelFontSize: m.nodeLabelFontSize,
      prefer2D: m.prefer2D,
      alwaysShowPreviews: m.alwaysShowPreviews,
      uiScale: m.uiScale,
      autoSaveEnabled: m.autoSaveEnabled,
      workspaceName: m.workspaceName,
      humeConfigId: m.humeConfigId,
      shellyCustomPrompt: m.shellyCustomPrompt,
      indicoServerUrl: m.indicoServerUrl,
      indicoApiToken: m.indicoApiToken,
      indicoCategoryId: m.indicoCategoryId,
      indicoLastSync: m.indicoLastSync,
      turtleSettings: JSON.parse(JSON.stringify(m.turtleSettings))
    };
    await db.settings.put(toSave);
  } catch (e) {
    console.error('Failed to save settings:', e);
    throw e;
  }
}
