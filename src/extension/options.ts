import type { ExtSettings, HighlightSettings } from './types';
import { DEFAULT_SETTINGS, DEFAULT_HIGHLIGHT_SETTINGS } from './types';

const MODEL_DEFAULTS: Record<string, string> = {
  claude:  'claude-haiku-4-5-20251001',
  openai:  'gpt-4o-mini',
  gemini:  'gemini-2.0-flash',
};

// ── LLM fields ────────────────────────────────────────────────────────────────
const providerEl  = document.getElementById('provider')      as HTMLSelectElement;
const apiKeyEl    = document.getElementById('api-key')       as HTMLInputElement;
const modelEl     = document.getElementById('model')         as HTMLInputElement;
const reckonsEl   = document.getElementById('reckons-url')   as HTMLInputElement;
const deepgramEl  = document.getElementById('deepgram-key')  as HTMLInputElement;
const saveBtn     = document.getElementById('btn-save')!;
const savedMsg    = document.getElementById('saved-msg')!;
const modelHint   = document.getElementById('model-hint')!;

// ── Highlight fields ──────────────────────────────────────────────────────────
const conflictColorEl  = document.getElementById('hl-conflict-color')  as HTMLInputElement;
const reinforceColorEl = document.getElementById('hl-reinforce-color') as HTMLInputElement;
const newColorEl       = document.getElementById('hl-new-color')       as HTMLInputElement;
const saturationEl     = document.getElementById('hl-saturation')      as HTMLInputElement;
const satValEl         = document.getElementById('hl-saturation-val')!;
const fontFamilyEl     = document.getElementById('hl-font-family')     as HTMLSelectElement;
const fontSizeEl       = document.getElementById('hl-font-size')       as HTMLInputElement;
const fontSizeValEl    = document.getElementById('hl-font-size-val')!;
const hoverScaleEl     = document.getElementById('hl-hover-scale')     as HTMLInputElement;
const hoverScaleValEl  = document.getElementById('hl-hover-scale-val')!;

// Live-update value labels
saturationEl.addEventListener('input',  () => { satValEl.textContent        = `${saturationEl.value}%`; });
fontSizeEl.addEventListener('input',    () => { fontSizeValEl.textContent   = `${fontSizeEl.value}px`; });
hoverScaleEl.addEventListener('input',  () => { hoverScaleValEl.textContent = `${hoverScaleEl.value}%`; });

providerEl.addEventListener('change', () => {
  modelHint.textContent = `Default: ${MODEL_DEFAULTS[providerEl.value] ?? ''}`;
});

// ── Load ──────────────────────────────────────────────────────────────────────
async function load() {
  const stored = await chrome.storage.local.get('settings') as Record<string, any>;
  const s: ExtSettings = { ...DEFAULT_SETTINGS, ...stored.settings };
  const hl: HighlightSettings = { ...DEFAULT_HIGHLIGHT_SETTINGS, ...(s.highlight ?? {}) };

  providerEl.value  = s.apiProvider;
  apiKeyEl.value    = s.apiKey;
  modelEl.value     = s.apiModel === MODEL_DEFAULTS[s.apiProvider] ? '' : s.apiModel;
  reckonsEl.value   = s.reckonsUrl;
  modelHint.textContent = `Default: ${MODEL_DEFAULTS[s.apiProvider] ?? ''}`;
  deepgramEl.value = s.deepgramApiKey ?? '';

  conflictColorEl.value  = hl.conflictColor;
  reinforceColorEl.value = hl.reinforceColor;
  newColorEl.value       = hl.newColor;

  saturationEl.value = String(hl.saturation);
  satValEl.textContent = `${hl.saturation}%`;

  // Match font family option
  const fontOpt = [...fontFamilyEl.options].find(o => o.value === hl.labelFontFamily);
  fontFamilyEl.value = fontOpt ? hl.labelFontFamily : 'monospace';

  fontSizeEl.value = String(hl.labelFontSize);
  fontSizeValEl.textContent = `${hl.labelFontSize}px`;

  hoverScaleEl.value = String(Math.round(hl.labelHoverScale * 100));
  hoverScaleValEl.textContent = `${Math.round(hl.labelHoverScale * 100)}%`;
}

// ── Save ──────────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  const provider = providerEl.value as ExtSettings['apiProvider'];
  const settings: ExtSettings = {
    apiProvider: provider,
    apiKey:      apiKeyEl.value.trim(),
    apiModel:    modelEl.value.trim() || MODEL_DEFAULTS[provider],
    reckonsUrl:  reckonsEl.value.trim().replace(/\/$/, '') || DEFAULT_SETTINGS.reckonsUrl,
    deepgramApiKey: deepgramEl.value.trim() || undefined,
    highlight: {
      conflictColor:   conflictColorEl.value,
      reinforceColor:  reinforceColorEl.value,
      newColor:        newColorEl.value,
      saturation:      Number(saturationEl.value),
      labelFontFamily: fontFamilyEl.value,
      labelFontSize:   Number(fontSizeEl.value),
      labelHoverScale: Number(hoverScaleEl.value) / 100,
    },
  };
  await chrome.storage.local.set({ settings });
  savedMsg.classList.add('show');
  setTimeout(() => savedMsg.classList.remove('show'), 2000);
});

load();
