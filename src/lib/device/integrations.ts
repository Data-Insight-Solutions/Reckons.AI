/**
 * Settings → This Device: which of the app's integrations are configured in THIS browser (F245).
 *
 * Matt, 2026-10-29, chose app integrations, local models + MCP servers, and the browser extension as
 * the "installed" list. There is no plugin system yet (F61), so an integration counts as configured when
 * the setting it cannot work without is filled in. That is all this can say: a key that is present
 * may still be wrong or revoked, so the page says "configured", never "working". Pure, and it never
 * returns a key or URL, only whether one is present; the n8n host is shown because it is not a secret.
 */
import type { SettingsRecord } from '$lib/storage/db';

export type IntegrationKind = 'model' | 'service';
export type IntegrationView = {
  id: string;
  name: string;
  kind: IntegrationKind;
  configured: boolean;
  /** Not secret: what it is for, or (for n8n) the host. */
  detail: string;
  /** Where to configure it. */
  href: string;
};

const set = (v: string | undefined | null): boolean => typeof v === 'string' && v.trim().length > 0;

const host = (url: string | undefined): string | undefined => {
  if (!set(url)) return undefined;
  try { return new URL(url!).host; } catch { return undefined; }
};

export function integrations(s: Partial<SettingsRecord>): IntegrationView[] {
  const backends = new Set([s.preferredBackend, s.ingestBackend, s.analyzeBackend, s.chatBackend, s.diffSummaryBackend, s.mergeAnalysisBackend].filter(Boolean));
  return [
    { id: 'claude', name: 'Claude', kind: 'model', configured: set(s.claudeApiKey), detail: 'API key', href: '/settings#s-claude' },
    { id: 'openai', name: 'OpenAI', kind: 'model', configured: set(s.openaiApiKey), detail: 'API key', href: '/settings#s-openai' },
    { id: 'gemini', name: 'Gemini', kind: 'model', configured: set(s.geminiApiKey), detail: 'API key', href: '/settings#s-gemini' },
    { id: 'openrouter', name: 'OpenRouter', kind: 'model', configured: set(s.openrouterApiKey), detail: 'API key', href: '/settings#s-openrouter' },
    // Ollama always has a base URL (it has a default), so "configured" means something is routed to it.
    { id: 'ollama', name: 'Ollama', kind: 'model', configured: backends.has('ollama') || !!s.preferLocal, detail: backends.has('ollama') ? 'used as a backend' : s.preferLocal ? 'prefer-local routing on' : 'not used by any task', href: '/settings#s-ollama' },
    { id: 'n8n', name: 'n8n', kind: 'service', configured: set(s.n8nBaseUrl), detail: host(s.n8nBaseUrl) ?? 'automation webhooks', href: '/settings/integrations' },
    { id: 'google', name: 'Google Workspace', kind: 'service', configured: set(s.googleClientId), detail: 'OAuth client ID', href: '/settings#s-google' },
    { id: 'github', name: 'GitHub', kind: 'service', configured: set(s.githubToken), detail: 'repo ingest token', href: '/settings/integrations' },
    { id: 'mistral', name: 'Mistral OCR', kind: 'service', configured: set(s.mistralApiKey), detail: 'document parsing', href: '/settings#s-mistral' },
    { id: 'meshy', name: 'Meshy', kind: 'service', configured: set(s.meshyApiKey), detail: '3D model generation', href: '/settings#s-meshy' },
    { id: 'firecrawl', name: 'Firecrawl', kind: 'service', configured: set(s.firecrawlApiKey), detail: 'web scraping', href: '/settings/integrations' },
    { id: 'tavily', name: 'Tavily', kind: 'service', configured: set(s.tavilyApiKey), detail: 'web search', href: '/settings/integrations' },
    { id: 'hume', name: 'Hume', kind: 'service', configured: set(s.humeAiApiKey), detail: 'voice', href: '/settings/integrations' },
    { id: 'indico', name: 'Indico', kind: 'service', configured: set(s.indicoServerUrl), detail: host(s.indicoServerUrl) ?? 'event import', href: '/settings/integrations' },
  ];
}
