import { DEFAULT_SETTINGS, getSettings, saveSettings, type SettingsRecord } from '../storage/db';

let _settings = $state<SettingsRecord>(DEFAULT_SETTINGS);
let loaded = $state(false);

export function settings(): SettingsRecord {
  return _settings;
}
export function settingsLoaded(): boolean {
  return loaded;
}

export async function loadSettings() {
  _settings = await getSettings();
  loaded = true;
}

export async function updateSettings(patch: Partial<SettingsRecord>) {
  _settings = { ..._settings, ...patch };
  await saveSettings(patch);
}
