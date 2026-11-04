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
  // A patch built from reactive state (a $state array, or an item read back from settings()) carries Svelte
  // proxies, which IndexedDB cannot clone: the put threw DataCloneError while memory already showed the change.
  const plain = $state.snapshot(patch) as Partial<SettingsRecord>;
  _settings = { ..._settings, ...plain };
  await saveSettings(plain);
}
