import { getSettings, saveSettings } from '../storage/db';
import type { TurtleSettings } from '../rdf/types';

import { DEFAULT_TURTLE_SETTINGS } from '../storage/db';

let _turtleSettings = $state<TurtleSettings>({ ...DEFAULT_TURTLE_SETTINGS });

let _loaded = $state(false);

export function turtleSettings(): TurtleSettings {
  return _turtleSettings;
}

export function turtleSettingsLoaded(): boolean {
  return _loaded;
}

export async function loadTurtleSettings() {
  const settings = await getSettings();
  // Guard: only overwrite if the DB actually has turtle settings saved
  if (settings.turtleSettings) {
    _turtleSettings = { ..._turtleSettings, ...settings.turtleSettings };
  }

  // Migrate legacy fields from main settings → turtleSettings (one-time)
  let migrated = false;
  if (settings.shellyCustomPrompt && !_turtleSettings.systemPrompt) {
    _turtleSettings.systemPrompt = settings.shellyCustomPrompt;
    migrated = true;
  }
  if (settings.humeAiApiKey && !_turtleSettings.humeApiKey) {
    _turtleSettings.humeApiKey = settings.humeAiApiKey;
    migrated = true;
  }
  if (settings.humeSecretKey && !_turtleSettings.humeSecretKey) {
    _turtleSettings.humeSecretKey = settings.humeSecretKey;
    migrated = true;
  }
  if (settings.humeConfigId && !_turtleSettings.humeConfigId) {
    _turtleSettings.humeConfigId = settings.humeConfigId;
    migrated = true;
  }
  if (migrated) {
    try { await saveSettings({ turtleSettings: _turtleSettings }); } catch {}
  }

  _loaded = true;
}

let _saveTimeout: number | undefined;

export async function updateTurtleSettings(patch: Partial<TurtleSettings>) {
  _turtleSettings = { ..._turtleSettings, ...patch };

  // Debounce database saves - avoid hammering IndexedDB on rapid updates
  // (e.g., mouse movements updating position dozens of times per second)
  if (_saveTimeout !== undefined) {
    clearTimeout(_saveTimeout);
  }

  _saveTimeout = window.setTimeout(async () => {
    _saveTimeout = undefined;
    try {
      await saveSettings({ turtleSettings: _turtleSettings });
    } catch (e) {
      console.error('Failed to save turtle settings:', e);
    }
  }, 500); // Debounce by 500ms
}

/**
 * Update turtle position (remember where user dragged it)
 */
export async function setTurtlePosition(x: number, y: number) {
  await updateTurtleSettings({ position: { x, y } });
}

/**
 * Update turtle personality/behavior
 */
export async function setTurtlePersonality(personality: 'helpful' | 'witty' | 'laid-back' | 'sarcastic') {
  await updateTurtleSettings({ personality });
}

/**
 * Update click action binding (what single/double/right click does)
 */
export async function setClickBinding(
  clickType: 'single' | 'double' | 'right',
  action: string
) {
  await updateTurtleSettings({
    clickBindings: {
      ...(_turtleSettings.clickBindings || {}),
      [clickType]: action
    }
  });
}

/**
 * Update wandering behavior
 */
export async function setWanderRange(range: number) {
  await updateTurtleSettings({ wanderRange: Math.min(100, Math.max(0, range)) });
}

/**
 * Enable/disable voice
 */
export async function setVoiceEnabled(enabled: boolean) {
  await updateTurtleSettings({ voiceEnabled: enabled });
}

/**
 * Set voice type (TTS, Hume.AI, or mute)
 */
export async function setVoiceType(type: 'tts' | 'hume') {
  await updateTurtleSettings({ voiceType: type });
}
