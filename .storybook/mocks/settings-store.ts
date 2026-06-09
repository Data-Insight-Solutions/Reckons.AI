/** Mock for $lib/stores/settings.svelte */
import type { SettingsRecord } from '$lib/storage/db';

const MOCK_SETTINGS: SettingsRecord = {
  key: 'main',
  claudeModel: 'claude-haiku-4-5-20251001',
  openaiModel: 'gpt-4o-mini',
  geminiModel: 'gemini-2.0-flash',
  wasmModel: 'Xenova/Qwen2.5-0.5B-Instruct',
  preferredBackend: 'mock',
  ollamaModel: 'llama3.2',
  ollamaBaseUrl: 'http://localhost:11434',
  openrouterModel: 'meta-llama/llama-3.2-3b-instruct:free',
  embeddingThreshold: 0.85,
  autoConfirmHighConfidence: false,
  reckonsModel: '@cf/meta/llama-3.1-8b-instruct',
  reckonsBaseUrl: 'https://api.reckons.ai',
  kbTitle: 'Demo KB',
  kbDescription: 'Storybook demo knowledge base',
  turtleSettings: {
    personality: 'helpful',
    patienceLevel: 75,
    engagement: 'medium',
    voiceEnabled: false,
    voiceType: 'tts',
    speechRate: 1,
    volume: 75,
    animationSpeed: 'normal',
    opacity: 100,
    size: 'medium',
    glowEffect: true,
    positionSticky: false,
    position: { x: 100, y: 100 },
    wanderRange: 20,
    clickBindings: { single: 'context-menu', double: 'help', right: 'quick-actions' },
    proactiveHelp: 'errors-only',
    showTutorialHints: true,
    responseFrequency: 50,
  },
};

export function settings(): SettingsRecord { return MOCK_SETTINGS; }
export function settingsLoaded(): boolean { return true; }
export async function loadSettings() {}
export async function updateSettings(_patch: Partial<SettingsRecord>) {}
