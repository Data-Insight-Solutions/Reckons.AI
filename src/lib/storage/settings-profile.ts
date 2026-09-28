import type { SettingsProfile } from './backup';
import type { TurtleSettings } from '../rdf/types';
import type { HighlightSettings } from '../../extension/types';

type Rule = ((value: unknown) => boolean) | { [key: string]: Rule };
const text = (v: unknown) => typeof v === 'string';
const bool = (v: unknown) => typeof v === 'boolean';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (...values: string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
const backend = oneOf('claude', 'openai', 'gemini', 'ollama', 'wasm', 'mock', 'openrouter', 'chrome-ai', 'reckons');
const analysisBackend = oneOf('claude', 'openai', 'gemini', 'ollama', 'wasm', 'openrouter', 'chrome-ai', 'reckons');
const endpoint = (v: unknown) => {
  if (typeof v !== 'string') return false;
  if (v === '') return true;
  try {
    const url = new URL(v);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};

// Explicit nested allowlists: a future credential field does not become portable
// just because its name evades a secret-name heuristic. Type checks require each
// supported public field to be classified when these settings types grow.
const turtle = {
  name: text, greeting: text, personality: oneOf('helpful', 'witty', 'laid-back', 'sarcastic'),
  systemPrompt: text, responseStyle: oneOf('concise', 'detailed', 'conversational'),
  maxResponseWords: number, patienceLevel: number, engagement: oneOf('low', 'medium', 'high'),
  voiceEnabled: bool, voiceType: oneOf('tts', 'hume'), kokoroVoice: text,
  speechRate: number, volume: number, humeConfigId: text, humeTokenUrl: endpoint, whisperModel: text,
  animationSpeed: oneOf('slow', 'normal', 'fast'), opacity: number, size: oneOf('small', 'medium', 'large'),
  glowEffect: bool, positionSticky: bool, position: { x: number, y: number },
  wanderRange: number, clickBindings: { single: text, double: text, right: text },
  proactiveHelp: oneOf('never', 'errors-only', 'always'), showTutorialHints: bool, responseFrequency: number,
} satisfies Record<Exclude<keyof TurtleSettings, 'humeApiKey' | 'humeSecretKey'>, Rule>;

const highlight = {
  conflictColor: text, reinforceColor: text, newColor: text, saturation: number,
  labelFontSize: number, labelHoverScale: number, labelFontFamily: text,
} satisfies Record<keyof HighlightSettings, Rule>;

const profile = {
  kbTitle: text, kbDescription: text, preferredBackend: backend, ingestBackend: backend,
  analyzeBackend: analysisBackend, chatBackend: analysisBackend,
  diffSummaryBackend: analysisBackend, mergeAnalysisBackend: analysisBackend,
  claudeModel: text, openaiModel: text, geminiModel: text, ollamaModel: text,
  ollamaIngestModel: text, ollamaAnalyzeModel: text, ollamaChatModel: text,
  ollamaDiffSummaryModel: text, ollamaMergeAnalysisModel: text, ollamaBaseUrl: endpoint,
  wasmModel: text, wasmIngestModel: text, wasmAnalyzeModel: text, wasmChatModel: text,
  openrouterModel: text, autoAnalyzeOnImport: bool, autoAnalyzeIntervalMinutes: number,
  embeddingThreshold: number, autoConfirmHighConfidence: bool, uiScale: oneOf('sm', 'md', 'lg'),
  nodeLabelFontSize: number, shellyCustomPrompt: text, humeConfigId: text,
  turtleSettings: turtle, extensionHighlight: highlight,
} satisfies Record<Exclude<keyof SettingsProfile, '_format' | '_version' | 'exportedAt'>, Rule>;

function select(value: unknown, rules: Record<string, Rule>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings profile');
  const result: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(value, key)) continue;
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    if (typeof rule === 'function') {
      if (!rule(field)) throw new Error('Invalid settings profile'); // never echo credential-bearing input
      result[key] = field;
    } else result[key] = select(field, rule);
  }
  return result;
}

/** Strip unknown/credential fields; reject malformed known fields before any write. */
export function selectProfileFields(value: unknown): Partial<SettingsProfile> {
  return select(value, profile);
}
