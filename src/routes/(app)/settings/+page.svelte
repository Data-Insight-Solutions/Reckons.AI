<script lang="ts">
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { ensureWasmReady, onWasmProgress } from '$lib/integrations/llm/wasm';
  import { providerStatus, warmProviderSdk, type ProviderInfo } from '$lib/integrations/llm/provider-status.svelte';
  import {
    exportKBClean, exportKBFull,
    exportPendingPreview, exportChangelog,
    exportSettingsProfile, parseSettingsProfile, buildSettingsProfileJson,
    isAutoSaveSupported, hasAutoSaveFile, getAutoSaveFileName,
    pickAutoSaveFile, clearAutoSaveFile
  } from '$lib/storage/backup';
  import { writeToWorkspace, readFromWorkspace } from '$lib/stores/workspace.svelte';
  import { DEFAULT_HIGHLIGHT_SETTINGS } from '../../../extension/types';
  import { startScheduler } from '$lib/stores/auto-analyze.svelte';
  import { page } from '$app/state';
  import { signIn, signOut, isSignedIn } from '$lib/integrations/google/auth';
  import { statements } from '$lib/stores/kb.svelte';
  import {
    getOrCreateStableId, formatStableId,
    computeContentHash, formatContentHash
  } from '$lib/storage/kb-fingerprint';
  import { onMount } from 'svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { Dialog } from 'bits-ui';
  import { DEFAULT_SETTINGS, getSettings, getUserDefaults, saveUserDefaults, clearUserDefaults, type SettingsRecord } from '$lib/storage/db';
  import {
    workspaceName, workspaceState, supportsWorkspace,
    pickWorkspace, reconnectWorkspace, clearWorkspace, loadWorkspace,
    syncAllKbs, listKbFolders, lastSyncTime, syncedKbCount,
    importKbsFromWorkspace
  } from '$lib/stores/workspace.svelte';
  import { exportJsonLd, exportLlmsTxt } from '$lib/storage/semantic-export';

  let key = $state(settings().claudeApiKey ?? '');
  let openaiKey = $state(settings().openaiApiKey ?? '');
  let geminiKey = $state(settings().geminiApiKey ?? '');
  let backend = $state(settings().preferredBackend);
  let ingestBackend       = $state(settings().ingestBackend       ?? settings().preferredBackend);
  let analyzeBackend      = $state(settings().analyzeBackend      ?? settings().preferredBackend);
  let chatBackend         = $state(settings().chatBackend         ?? settings().preferredBackend);
  let diffSummaryBackend  = $state(settings().diffSummaryBackend  ?? '');
  let mergeAnalysisBackend = $state(settings().mergeAnalysisBackend ?? '');
  let claudeModel = $state(settings().claudeModel);
  let openaiModel = $state(settings().openaiModel);
  let geminiModel = $state(settings().geminiModel);
  let ollamaModel = $state(settings().ollamaModel ?? 'llama3.2');
  let ollamaBaseUrl = $state(settings().ollamaBaseUrl ?? 'http://localhost:11434');
  let preferLocal = $state(settings().preferLocal ?? false);
  let wasmModel = $state(settings().wasmModel);
  let wasmIngestModel = $state(settings().wasmIngestModel ?? '');
  let wasmAnalyzeModel = $state(settings().wasmAnalyzeModel ?? '');
  let wasmChatModel = $state(settings().wasmChatModel ?? '');
  let openrouterKey = $state(settings().openrouterApiKey ?? '');
  let openrouterModel = $state(settings().openrouterModel ?? 'meta-llama/llama-3.2-3b-instruct:free');
  let mistralApiKey = $state(settings().mistralApiKey ?? '');
  let meshyApiKey = $state(settings().meshyApiKey ?? '');
  let uiScale = $state<'sm' | 'md' | 'lg'>(settings().uiScale ?? 'md');
  let nodeLabelFontSize = $state(settings().nodeLabelFontSize ?? 11);
  let prefer2D = $state(settings().prefer2D ?? false);

  async function saveDisplaySettings() {
    await updateSettings({ uiScale, nodeLabelFontSize, prefer2D });
  }

  // ── Shared backend option groups (consistent naming across all selectors) ──
  type OptGroup = { label: string; options: { value: string; label: string }[] };
  const LOCAL_GROUP: OptGroup = { label: 'local', options: [
    { value: 'wasm',      label: 'WASM (free · offline)' },
    { value: 'chrome-ai', label: 'Chrome AI (free · local)' },
    { value: 'ollama',    label: 'Ollama (free · local)' },
  ]};
  const CLOUD_GROUP: OptGroup = { label: 'cloud', options: [
    { value: 'openrouter', label: 'OpenRouter (free tier available)' },
    { value: 'gemini',     label: 'Gemini (free tier)' },
    { value: 'reckons',    label: 'Reckons.AI (managed)' },
    { value: 'claude',     label: 'Claude (paid)' },
    { value: 'openai',     label: 'OpenAI (paid)' },
  ]};
  const DEV_GROUP: OptGroup   = { label: 'dev', options: [
    { value: 'mock', label: 'Mock (testing)' },
  ]};
  const ALL_GROUPS:  OptGroup[] = [LOCAL_GROUP, CLOUD_GROUP, DEV_GROUP];
  const FULL_GROUPS: OptGroup[] = [LOCAL_GROUP, CLOUD_GROUP];
  const ANALYZE_SUB_GROUPS: OptGroup[] = [
    { label: 'default', options: [{ value: '', label: '← use analyze default' }] },
    ...FULL_GROUPS,
  ];
  let wasmStatus = $state('');
  let wasmPct = $state<number | null>(null);
  let wasmLoading = $state(false);

  // Google integration
  let googleClientId = $state(settings().googleClientId ?? '');
  let googleConnected = $state(isSignedIn());
  let googleConnecting = $state(false);
  let googleError = $state<string | null>(null);

  async function connectGoogle() {
    const clientId = googleClientId.trim();
    if (!clientId) return;
    googleConnecting = true;
    googleError = null;
    try {
      await signIn(clientId);
      await updateSettings({ googleClientId: clientId });
      googleConnected = true;
    } catch (e) {
      googleError = e instanceof Error ? e.message : String(e);
    } finally {
      googleConnecting = false;
    }
  }

  function disconnectGoogle() {
    signOut();
    googleConnected = false;
  }

  // transformers.js sends progress as 0–100 (percentage), not 0–1
  $effect(() => onWasmProgress((status, p) => {
    wasmStatus = status;
    wasmPct = p != null ? Math.min(100, Math.round(p)) : null;
  }));

  async function save() {
    await updateSettings({
      claudeApiKey: key.trim() || undefined,
      openaiApiKey: openaiKey.trim() || undefined,
      geminiApiKey: geminiKey.trim() || undefined,
      preferredBackend: backend,
      ingestBackend,
      analyzeBackend: analyzeBackend as SettingsRecord['analyzeBackend'],
      chatBackend: chatBackend as SettingsRecord['chatBackend'],
      diffSummaryBackend: (diffSummaryBackend || undefined) as SettingsRecord['diffSummaryBackend'],
      mergeAnalysisBackend: (mergeAnalysisBackend || undefined) as SettingsRecord['mergeAnalysisBackend'],
      claudeModel,
      openaiModel,
      geminiModel,
      ollamaModel,
      ollamaBaseUrl: ollamaBaseUrl.trim() || 'http://localhost:11434',
      preferLocal: preferLocal || undefined,
      wasmModel,
      wasmIngestModel: wasmIngestModel.trim() || undefined,
      wasmAnalyzeModel: wasmAnalyzeModel.trim() || undefined,
      wasmChatModel: wasmChatModel.trim() || undefined,
      openrouterApiKey: openrouterKey.trim() || undefined,
      openrouterModel: openrouterModel.trim() || 'meta-llama/llama-3.2-3b-instruct:free',
      mistralApiKey: mistralApiKey.trim() || undefined,
      meshyApiKey: meshyApiKey.trim() || undefined,
      autoAnalyzeOnImport,
      autoAnalyzeIntervalMinutes: Math.max(0, autoAnalyzeIntervalMinutes),
      autoRefreshOnOpen,
      autoRefreshIntervalMinutes: Math.max(0, autoRefreshIntervalMinutes),
      extensionHighlight: {
        conflictColor:   hlConflictColor,
        reinforceColor:  hlReinforceColor,
        newColor:        hlNewColor,
        saturation:      hlSaturation,
        labelFontFamily: hlFontFamily,
        labelFontSize:   hlFontSize,
        labelHoverScale: hlHoverScale / 100,
      },
    });
    startScheduler(); // restart with new interval
  }

  async function warmWasm() {
    wasmLoading = true;
    wasmPct = 0;
    try {
      await ensureWasmReady(wasmModel);
      wasmStatus = 'ready';
      wasmPct = 100;
    } catch (e) {
      wasmStatus = e instanceof Error ? e.message : String(e);
      wasmPct = null;
    } finally {
      wasmLoading = false;
    }
  }

  // ── Device profile for WASM model recommendations ────────────────────────
  type ModelRec = { id: string; label: string; size: string; note: string };

  const WASM_MODELS: ModelRec[] = [
    {
      id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      label: 'SmolLM2-135M',
      size: '~135 MB',
      note: 'ultra-light · fast download · basic chat only'
    },
    {
      id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
      label: 'SmolLM2-360M',
      size: '~360 MB',
      note: 'lightweight · limited extraction quality'
    },
    {
      id: 'onnx-community/Qwen2.5-0.5B-Instruct',
      label: 'Qwen2.5-0.5B',
      size: '~500 MB',
      note: 'default · best chat quality for size · multilingual'
    },
    {
      id: 'onnx-community/Qwen2.5-1.5B-Instruct',
      label: 'Qwen2.5-1.5B',
      size: '~1.5 GB',
      note: 'best extraction quality · needs 4 GB+ RAM'
    },
    {
      id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
      label: 'SmolLM2-1.7B',
      size: '~1.7 GB',
      note: 'best chat quality · slow · may crash in-browser'
    },
  ];

  interface DeviceProfile {
    ramGb: number | null;
    cores: number;
    hasWebGPU: boolean;
    tier: 'low' | 'mid' | 'high';
    recommendation: ModelRec;
    summary: string;
  }

  let deviceProfile = $state<DeviceProfile | null>(null);

  onMount(async () => {
    const id = await getOrCreateStableId(
      settings().kbStableId,
      (newId) => updateSettings({ kbStableId: newId })
    );
    stableId = id;

    // Detect device profile for WASM recommendations
    const nav = navigator as Navigator & { deviceMemory?: number };
    const ramGb: number | null = nav.deviceMemory ?? null;
    const cores = navigator.hardwareConcurrency ?? 2;
    const hasWebGPU = 'gpu' in navigator;

    let tier: DeviceProfile['tier'];
    if ((ramGb !== null && ramGb >= 8) || cores >= 8) {
      tier = 'high';
    } else if ((ramGb !== null && ramGb >= 4) || cores >= 4) {
      tier = 'mid';
    } else {
      tier = 'low';
    }

    const recommendation =
      tier === 'high' ? WASM_MODELS[3]   // Qwen2.5-1.5B
      : WASM_MODELS[2];                  // Qwen2.5-0.5B (default)

    const ramStr = ramGb !== null ? `${ramGb} GB RAM` : 'unknown RAM';
    const gpuStr = hasWebGPU ? ' · WebGPU available' : '';
    deviceProfile = {
      ramGb, cores, hasWebGPU, tier, recommendation,
      summary: `${ramStr} · ${cores} CPU cores${gpuStr}`
    };

    await loadWorkspace();
  });

  // Which provider sections to show — derived live from the task dropdowns
  const usedProviders = $derived(new Set([
    ingestBackend, analyzeBackend, chatBackend,
    diffSummaryBackend || analyzeBackend,
    mergeAnalysisBackend || analyzeBackend,
  ]));

  // Auto re-analysis
  let autoAnalyzeOnImport = $state(settings().autoAnalyzeOnImport ?? false);
  let autoAnalyzeIntervalMinutes = $state(settings().autoAnalyzeIntervalMinutes ?? 0);

  // Auto source refresh
  let autoRefreshOnOpen = $state(settings().autoRefreshOnOpen ?? false);
  let autoRefreshIntervalMinutes = $state(settings().autoRefreshIntervalMinutes ?? 0);

  // KB Identity
  let stableId = $state(settings().kbStableId ?? '');
  let contentHash = $state('');
  let hashLoading = $state(false);
  let copied = $state<'id' | 'hash' | null>(null);

  async function refreshHash() {
    hashLoading = true;
    contentHash = await computeContentHash(statements());
    hashLoading = false;
  }

  async function copyToClipboard(text: string, which: 'id' | 'hash') {
    await navigator.clipboard.writeText(text);
    copied = which;
    setTimeout(() => { copied = null; }, 1800);
  }

  // Extension highlight settings
  const _hl = { ...DEFAULT_HIGHLIGHT_SETTINGS, ...(settings().extensionHighlight ?? {}) };
  let hlConflictColor  = $state(_hl.conflictColor);
  let hlReinforceColor = $state(_hl.reinforceColor);
  let hlNewColor       = $state(_hl.newColor);
  let hlSaturation     = $state(_hl.saturation);
  let hlFontFamily     = $state(_hl.labelFontFamily);
  let hlFontSize       = $state(_hl.labelFontSize);
  let hlHoverScale     = $state(Math.round(_hl.labelHoverScale * 100));

  let backupLoading = $state(false);
  let exportingFull = $state(false);
  let exportingPending = $state(false);
  let exportingChangelog = $state(false);
  let exportingJsonLd = $state(false);
  let exportingLlmsTxt = $state(false);
  let autoSaveLinked = $state(hasAutoSaveFile());
  let autoSaveFileName = $state(getAutoSaveFileName());

  async function handleBackup() {
    backupLoading = true;
    try { await exportKBClean(); } catch (e) { console.error('Backup failed:', e); } finally { backupLoading = false; }
  }

  async function handleExportFull() {
    exportingFull = true;
    try { await exportKBFull(); } catch (e) { console.error(e); } finally { exportingFull = false; }
  }

  async function handleExportPending() {
    exportingPending = true;
    try { await exportPendingPreview(); } catch (e) { console.error(e); } finally { exportingPending = false; }
  }

  async function handleExportChangelog() {
    exportingChangelog = true;
    try { await exportChangelog(); } catch (e) { console.error(e); } finally { exportingChangelog = false; }
  }

  async function handleExportJsonLd() {
    exportingJsonLd = true;
    try { await exportJsonLd({ kbTitle: settings().kbTitle, kbDescription: settings().kbDescription }); }
    catch (e) { console.error(e); } finally { exportingJsonLd = false; }
  }

  async function handleExportLlmsTxt() {
    exportingLlmsTxt = true;
    try { await exportLlmsTxt({ kbTitle: settings().kbTitle, kbDescription: settings().kbDescription }); }
    catch (e) { console.error(e); } finally { exportingLlmsTxt = false; }
  }

  async function handlePickAutoSave() {
    const ok = await pickAutoSaveFile();
    if (ok) {
      autoSaveLinked = true;
      autoSaveFileName = getAutoSaveFileName();
      await updateSettings({ autoSaveEnabled: true });
    }
  }

  function handleClearAutoSave() {
    clearAutoSaveFile();
    autoSaveLinked = false;
    autoSaveFileName = null;
    updateSettings({ autoSaveEnabled: false });
  }

  // ── Auto-save ──────────────────────────────────────────────────────────────
  let _autoSaveInit = false;
  let _autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let savedPulse = $state(false);

  $effect(() => {
    // Track every form field — any change triggers debounced save
    void [key, openaiKey, geminiKey, backend, ingestBackend, analyzeBackend, chatBackend,
          diffSummaryBackend, mergeAnalysisBackend,
          claudeModel, openaiModel, geminiModel, ollamaModel, ollamaBaseUrl, preferLocal, wasmModel,
          wasmIngestModel, wasmAnalyzeModel, wasmChatModel,
          openrouterKey, openrouterModel, mistralApiKey, meshyApiKey, autoAnalyzeOnImport,
          autoAnalyzeIntervalMinutes, autoRefreshOnOpen, autoRefreshIntervalMinutes,
          hlConflictColor, hlReinforceColor, hlNewColor,
          hlSaturation, hlFontFamily, hlFontSize, hlHoverScale];
    if (!_autoSaveInit) { _autoSaveInit = true; return; }
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(async () => {
      await save();
      savedPulse = true;
      setTimeout(() => { savedPulse = false; }, 1400);
    }, 700);
  });

  // ── Reset to defaults ──────────────────────────────────────────────────────
  let confirmResetOpen = $state(false);

  async function handleReset() {
    const d = DEFAULT_SETTINGS;
    key                    = d.claudeApiKey         ?? '';
    openaiKey              = d.openaiApiKey          ?? '';
    geminiKey              = d.geminiApiKey          ?? '';
    backend                = d.preferredBackend;
    ingestBackend          = d.ingestBackend         ?? d.preferredBackend;
    analyzeBackend         = d.analyzeBackend        ?? d.preferredBackend;
    chatBackend            = d.chatBackend           ?? d.preferredBackend;
    diffSummaryBackend     = d.diffSummaryBackend    ?? '';
    mergeAnalysisBackend   = d.mergeAnalysisBackend  ?? '';
    claudeModel            = d.claudeModel;
    openaiModel            = d.openaiModel;
    geminiModel            = d.geminiModel;
    ollamaModel            = d.ollamaModel;
    ollamaBaseUrl          = d.ollamaBaseUrl;
    preferLocal            = d.preferLocal            ?? false;
    wasmModel              = d.wasmModel;
    wasmIngestModel        = d.wasmIngestModel        ?? '';
    wasmAnalyzeModel       = d.wasmAnalyzeModel       ?? '';
    wasmChatModel          = d.wasmChatModel          ?? '';
    openrouterKey          = d.openrouterApiKey      ?? '';
    openrouterModel        = d.openrouterModel;
    mistralApiKey          = d.mistralApiKey          ?? '';
    meshyApiKey            = d.meshyApiKey           ?? '';
    autoAnalyzeOnImport    = d.autoAnalyzeOnImport   ?? false;
    autoAnalyzeIntervalMinutes = d.autoAnalyzeIntervalMinutes ?? 0;
    autoRefreshOnOpen      = d.autoRefreshOnOpen     ?? false;
    autoRefreshIntervalMinutes = d.autoRefreshIntervalMinutes ?? 0;
    const dhl = { ...DEFAULT_HIGHLIGHT_SETTINGS, ...(d.extensionHighlight ?? {}) };
    hlConflictColor  = dhl.conflictColor;
    hlReinforceColor = dhl.reinforceColor;
    hlNewColor       = dhl.newColor;
    hlSaturation     = dhl.saturation;
    hlFontFamily     = dhl.labelFontFamily;
    hlFontSize       = dhl.labelFontSize;
    hlHoverScale     = Math.round(dhl.labelHoverScale * 100);
    confirmResetOpen = false;
    // auto-save effect will fire from the state changes above
  }

  // ── User defaults ──────────────────────────────────────────────────────────

  const UD_TS_KEY = 'reckons:user-defaults-saved-at';
  let userDefaultsSavedAt = $state<string | null>(localStorage.getItem(UD_TS_KEY));
  let confirmClearDefaultsOpen = $state(false);
  let exportProfileLoading = $state(false);
  let importProfileError = $state<string | null>(null);

  async function handleSaveDefaults() {
    const current = await getSettings();
    await saveUserDefaults(current);
    userDefaultsSavedAt = new Date().toLocaleString();
    localStorage.setItem(UD_TS_KEY, userDefaultsSavedAt);
  }

  async function handleRevertToDefaults() {
    const ud = await getUserDefaults();
    if (!ud) return;
    // Apply to DB
    await updateSettings({
      claudeApiKey: ud.claudeApiKey,
      openaiApiKey: ud.openaiApiKey,
      geminiApiKey: ud.geminiApiKey,
      preferredBackend: ud.preferredBackend,
      ingestBackend: ud.ingestBackend,
      analyzeBackend: ud.analyzeBackend as SettingsRecord['analyzeBackend'],
      chatBackend: ud.chatBackend as SettingsRecord['chatBackend'],
      diffSummaryBackend: ud.diffSummaryBackend as SettingsRecord['diffSummaryBackend'],
      mergeAnalysisBackend: ud.mergeAnalysisBackend as SettingsRecord['mergeAnalysisBackend'],
      claudeModel: ud.claudeModel,
      openaiModel: ud.openaiModel,
      geminiModel: ud.geminiModel,
      ollamaModel: ud.ollamaModel,
      ollamaBaseUrl: ud.ollamaBaseUrl,
      preferLocal: ud.preferLocal,
      wasmModel: ud.wasmModel,
      wasmIngestModel: ud.wasmIngestModel,
      wasmAnalyzeModel: ud.wasmAnalyzeModel,
      wasmChatModel: ud.wasmChatModel,
      openrouterApiKey: ud.openrouterApiKey,
      openrouterModel: ud.openrouterModel,
      mistralApiKey: ud.mistralApiKey,
      meshyApiKey: ud.meshyApiKey,
      autoAnalyzeOnImport: ud.autoAnalyzeOnImport,
      autoAnalyzeIntervalMinutes: ud.autoAnalyzeIntervalMinutes,
      autoRefreshOnOpen: ud.autoRefreshOnOpen,
      autoRefreshIntervalMinutes: ud.autoRefreshIntervalMinutes,
      uiScale: ud.uiScale,
      nodeLabelFontSize: ud.nodeLabelFontSize,
      prefer2D: ud.prefer2D,
      extensionHighlight: ud.extensionHighlight,
    });
    // Sync form state
    key                        = ud.claudeApiKey             ?? '';
    openaiKey                  = ud.openaiApiKey              ?? '';
    geminiKey                  = ud.geminiApiKey              ?? '';
    backend                    = ud.preferredBackend;
    ingestBackend              = ud.ingestBackend             ?? ud.preferredBackend;
    analyzeBackend             = ud.analyzeBackend            ?? ud.preferredBackend;
    chatBackend                = ud.chatBackend               ?? ud.preferredBackend;
    diffSummaryBackend         = ud.diffSummaryBackend        ?? '';
    mergeAnalysisBackend       = ud.mergeAnalysisBackend      ?? '';
    claudeModel                = ud.claudeModel;
    openaiModel                = ud.openaiModel;
    geminiModel                = ud.geminiModel;
    ollamaModel                = ud.ollamaModel;
    ollamaBaseUrl              = ud.ollamaBaseUrl;
    preferLocal                = ud.preferLocal              ?? false;
    wasmModel                  = ud.wasmModel;
    wasmIngestModel            = ud.wasmIngestModel           ?? '';
    wasmAnalyzeModel           = ud.wasmAnalyzeModel          ?? '';
    wasmChatModel              = ud.wasmChatModel             ?? '';
    openrouterKey              = ud.openrouterApiKey          ?? '';
    openrouterModel            = ud.openrouterModel;
    mistralApiKey              = ud.mistralApiKey              ?? '';
    meshyApiKey                = ud.meshyApiKey               ?? '';
    autoAnalyzeOnImport        = ud.autoAnalyzeOnImport       ?? false;
    autoAnalyzeIntervalMinutes = ud.autoAnalyzeIntervalMinutes ?? 0;
    autoRefreshOnOpen          = ud.autoRefreshOnOpen          ?? false;
    autoRefreshIntervalMinutes = ud.autoRefreshIntervalMinutes ?? 0;
    uiScale                    = ud.uiScale                   ?? 'md';
    nodeLabelFontSize          = ud.nodeLabelFontSize          ?? 11;
    prefer2D                   = ud.prefer2D                   ?? false;
    if (ud.extensionHighlight) {
      const hl = { ...DEFAULT_HIGHLIGHT_SETTINGS, ...ud.extensionHighlight };
      hlConflictColor  = hl.conflictColor;
      hlReinforceColor = hl.reinforceColor;
      hlNewColor       = hl.newColor;
      hlSaturation     = hl.saturation;
      hlFontFamily     = hl.labelFontFamily;
      hlFontSize       = hl.labelFontSize;
      hlHoverScale     = Math.round(hl.labelHoverScale * 100);
    }
  }

  async function handleClearDefaults() {
    await clearUserDefaults();
    userDefaultsSavedAt = null;
    localStorage.removeItem(UD_TS_KEY);
    confirmClearDefaultsOpen = false;
  }

  async function handleExportProfile() {
    exportProfileLoading = true;
    try { await exportSettingsProfile(); }
    catch (e) { console.error('Profile export failed:', e); }
    finally { exportProfileLoading = false; }
  }

  async function handleImportProfile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    importProfileError = null;
    try {
      const text = await file.text();
      const patch = parseSettingsProfile(text);
      if (!patch) { importProfileError = 'Not a valid Reckons.AI settings profile.'; return; }
      await updateSettings(patch);
      window.location.reload(); // sync all form fields from fresh DB state
    } catch (err) {
      importProfileError = err instanceof Error ? err.message : String(err);
    }
    // reset file input so the same file can be re-imported
    (e.target as HTMLInputElement).value = '';
  }

  // ── Workspace profile sync ─────────────────────────────────────────────────

  const WORKSPACE_PROFILE_FILE = 'settings_profile.json';
  let wsSaveLoading = $state(false);
  let wsLoadLoading = $state(false);
  let wsProfileError = $state<string | null>(null);
  let wsProfileSuccess = $state<string | null>(null);

  async function handleSaveProfileToWorkspace() {
    wsSaveLoading = true;
    wsProfileError = null;
    wsProfileSuccess = null;
    try {
      const json = await buildSettingsProfileJson();
      await writeToWorkspace(WORKSPACE_PROFILE_FILE, json);
      wsProfileSuccess = `Saved ${WORKSPACE_PROFILE_FILE} to workspace.`;
    } catch (e) {
      wsProfileError = e instanceof Error ? e.message : String(e);
    } finally {
      wsSaveLoading = false;
    }
  }

  async function handleLoadProfileFromWorkspace() {
    wsLoadLoading = true;
    wsProfileError = null;
    wsProfileSuccess = null;
    try {
      const text = await readFromWorkspace(WORKSPACE_PROFILE_FILE);
      if (!text) { wsProfileError = `No ${WORKSPACE_PROFILE_FILE} found in workspace.`; return; }
      const patch = parseSettingsProfile(text);
      if (!patch) { wsProfileError = 'File found but is not a valid Reckons.AI settings profile.'; return; }
      await updateSettings(patch);
      window.location.reload();
    } catch (e) {
      wsProfileError = e instanceof Error ? e.message : String(e);
    } finally {
      wsLoadLoading = false;
    }
  }

  // ── Workspace ──────────────────────────────────────────────────────────────
  let workspaceConnecting = $state(false);
  let wsSyncing = $state(false);
  let wsSyncMsg = $state('');
  let wsFolderCount = $state(0);

  async function handlePickWorkspace() {
    workspaceConnecting = true;
    const ok = await pickWorkspace();
    workspaceConnecting = false;
    if (ok) {
      // Check if folder already has KBs — import them instead of overwriting
      const folders = await listKbFolders();
      wsFolderCount = folders.length;
      if (folders.length > 0) {
        wsImporting = true;
        const { imported, skipped } = await importKbsFromWorkspace();
        wsImporting = false;
        if (imported.length > 0) {
          wsImportMsg = `Imported ${imported.length} graph(s): ${imported.join(', ')}`;
          setTimeout(() => { wsImportMsg = ''; }, 10000);
        } else {
          wsSyncMsg = `${folders.length} graph(s) found in folder (already imported or empty).`;
          setTimeout(() => { wsSyncMsg = ''; }, 5000);
        }
      } else {
        // Empty folder — export current KBs to it
        wsSyncing = true;
        const count = await syncAllKbs();
        wsSyncMsg = `Synced ${count} graph${count !== 1 ? 's' : ''} to folder.`;
        wsSyncing = false;
        setTimeout(() => { wsSyncMsg = ''; }, 5000);
      }
    }
  }

  async function handleReconnectWorkspace() {
    workspaceConnecting = true;
    const ok = await reconnectWorkspace();
    workspaceConnecting = false;
    if (ok) {
      const folders = await listKbFolders();
      wsFolderCount = folders.length;
      // Auto-import any new KBs found in the folder
      if (folders.length > 0) {
        const { imported } = await importKbsFromWorkspace();
        if (imported.length > 0) {
          wsImportMsg = `Imported ${imported.length} graph(s): ${imported.join(', ')}`;
          setTimeout(() => { wsImportMsg = ''; }, 10000);
        }
      }
    }
  }

  async function handleSyncAllKbs() {
    wsSyncing = true;
    wsSyncMsg = '';
    const count = await syncAllKbs();
    wsSyncMsg = `Synced ${count} graph${count !== 1 ? 's' : ''} to folder.`;
    wsSyncing = false;
    setTimeout(() => { wsSyncMsg = ''; }, 5000);
  }

  let wsImporting = $state(false);
  let wsImportMsg = $state('');

  async function handleImportFromWorkspace() {
    wsImporting = true;
    wsImportMsg = '';
    const { imported, skipped } = await importKbsFromWorkspace();
    const parts: string[] = [];
    if (imported.length > 0) parts.push(`Imported: ${imported.join(', ')}`);
    if (skipped.length > 0) parts.push(`Skipped: ${skipped.join(', ')}`);
    wsImportMsg = parts.join('. ') || 'No new graphs found.';
    wsImporting = false;
    // Refresh folder count
    const folders = await listKbFolders();
    wsFolderCount = folders.length;
    setTimeout(() => { wsImportMsg = ''; }, 10000);
  }
</script>

<header class="head">
  <p class="kicker mono">settings</p>
  <h1>system configuration</h1>

  <div class="settings-nav">
    <a href="/settings" class:active={!page.url.pathname.includes('/turtle') && !page.url.pathname.includes('/entity-types') && !page.url.pathname.includes('/integrations')} class="nav-link">backends</a>
    <a href="/settings/integrations" class:active={page.url.pathname.includes('/integrations')} class="nav-link">integrations</a>
    <a href="/settings/turtle" class:active={page.url.pathname.includes('/turtle')} class="nav-link">turtle</a>
    <a href="/settings/entity-types" class:active={page.url.pathname.includes('/entity-types')} class="nav-link">entity types</a>
    <a href="/analyze" class="nav-link">analyze history ↗</a>
  </div>
  <nav class="section-toc">
    <a href="#s-status">status</a>
    <a href="#s-backends">backends</a>
    <a href="#s-claude">claude</a>
    <a href="#s-openai">openai</a>
    <a href="#s-openrouter">openrouter</a>
    <a href="#s-chrome">chrome</a>
    <a href="#s-ollama">ollama</a>
    <a href="#s-gemini">gemini</a>
    <a href="#s-wasm">wasm</a>
    <a href="#s-display">display</a>
    <a href="#s-mistral">mistral</a>
    <a href="#s-meshy">meshy</a>
    <a href="#s-google">google</a>
    <a href="#s-analyze">analyze</a>
    <a href="#s-defaults">defaults</a>
    <a href="#s-identity">identity</a>
    <a href="#s-extension">extension</a>
    <a href="#s-backup">backup</a>
    <a href="#s-workspace">workspace</a>
  </nav>
</header>

<section id="s-status" class="card provider-status-card">
  <h3>provider status</h3>
  <p class="sub">providers load their SDK chunk on first use — no network traffic until you activate them.</p>
  <div class="provider-dots">
    {#each providerStatus() as p (p.key)}
      <div
        class="provider-dot"
        class:dot-ready={p.state === 'ready'}
        class:dot-configured={p.state === 'configured'}
        class:dot-loading={p.state === 'sdk-loading'}
        class:dot-error={p.state === 'sdk-error'}
        class:dot-off={p.state === 'not-configured'}
        title="{p.label} — {p.state}{p.sdkSize && p.state === 'configured' ? ' · ' + p.sdkSize + ' on first use' : ''}"
      >
        <span class="dot-label mono">{p.key}</span>
        <span class="dot-pip"></span>
        {#if p.state === 'configured' && p.hasLazySdk}
          <button class="dot-warm mono" onclick={() => warmProviderSdk(p.key)}>load SDK</button>
        {/if}
      </div>
    {/each}
  </div>
</section>

<section id="s-backends" class="card">
  <h3>AI backends per task</h3>
  <p class="sub">each task uses its own model — mix a fast free model for ingestion with a smarter cloud model for analysis. provider keys and model names are set in the sections below. if a cloud backend has no key configured, ingest and chat fall back to WASM automatically.</p>

  <label class="check-row">
    <input type="checkbox" bind:checked={preferLocal} />
    <div>
      <strong>prefer local</strong>
      <p class="check-hint">when Ollama is running, chat, diff summaries, and merge analysis route to it automatically — explicit per-task choices below still win.</p>
    </div>
  </label>

  <div class="task-backends">
    <!-- ── Ingest ── -->
    <div class="task-category-header mono">ingest</div>
    <div class="task-row">
      <div class="task-info">
        <span class="task-label mono">extraction</span>
        <span class="task-desc">text → triples</span>
      </div>
      <div class="backend-sel-wrap"><Select bind:value={ingestBackend} groups={ALL_GROUPS} /></div>
    </div>

    <!-- ── Analyze ── -->
    <div class="task-category-header mono">
      analyze
      <button class="set-all-btn mono" onclick={() => { diffSummaryBackend = ''; mergeAnalysisBackend = ''; }}>
        reset sub-tasks
      </button>
    </div>
    <div class="task-row">
      <div class="task-info">
        <span class="task-label mono">default</span>
        <span class="task-desc">all analysis tasks below</span>
      </div>
      <div class="backend-sel-wrap"><Select bind:value={analyzeBackend} groups={FULL_GROUPS} /></div>
    </div>
    <div class="task-row task-row-sub">
      <div class="task-info">
        <span class="task-label mono">enrich</span>
        <span class="task-desc">discover missing relations + web search</span>
      </div>
      <span class="task-inherits mono">← default</span>
    </div>
    <div class="task-row task-row-sub">
      <div class="task-info">
        <span class="task-label mono">entity types</span>
        <span class="task-desc">assign rdf:type to entities</span>
      </div>
      <span class="task-inherits mono">← default</span>
    </div>
    <div class="task-row task-row-sub">
      <div class="task-info">
        <span class="task-label mono">merge</span>
        <span class="task-desc">entity deduplication</span>
      </div>
      <div class="backend-sel-wrap"><Select bind:value={mergeAnalysisBackend} groups={ANALYZE_SUB_GROUPS} /></div>
    </div>
    <div class="task-row task-row-sub">
      <div class="task-info">
        <span class="task-label mono">prune</span>
        <span class="task-desc">remove low-value statements</span>
      </div>
      <span class="task-inherits mono">← default</span>
    </div>
    <div class="task-row task-row-sub">
      <div class="task-info">
        <span class="task-label mono">diff summary</span>
        <span class="task-desc">summarize new & conflicting</span>
      </div>
      <div class="backend-sel-wrap"><Select bind:value={diffSummaryBackend} groups={ANALYZE_SUB_GROUPS} /></div>
    </div>

    <!-- ── Chat ── -->
    <div class="task-category-header mono">chat</div>
    <div class="task-row">
      <div class="task-info">
        <span class="task-label mono">shelly</span>
        <span class="task-desc">assistant conversations</span>
      </div>
      <div class="backend-sel-wrap"><Select bind:value={chatBackend} groups={FULL_GROUPS} /></div>
    </div>

    <!-- ── Extension ── -->
    <div class="task-category-header mono">extension</div>
    <div class="task-row">
      <div class="task-info">
        <span class="task-label mono">page summary</span>
        <span class="task-desc">compare page against graph</span>
      </div>
      <span class="task-inherits mono">← ingest</span>
    </div>
    <div class="task-row">
      <div class="task-info">
        <span class="task-label mono">session summary</span>
        <span class="task-desc">aggregate research session</span>
      </div>
      <span class="task-inherits mono">← diff summary</span>
    </div>
  </div>

  <details class="backend-detail">
    <summary class="mono">provider descriptions</summary>
    <div class="backend-detail-body">
      <p><strong>WASM</strong> — transformers.js in a web worker. 100% offline and private. slower and smaller than cloud, but zero cost.</p>
      <p><strong>Chrome AI</strong> — Gemini Nano inside Chrome, no API key. requires enabling an experimental flag. Chrome/Edge only.</p>
      <p><strong>Ollama</strong> — fully local LLM via <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>. run <code>ollama serve</code> and pull a model. best free quality option.</p>
      <p><strong>OpenRouter</strong> — one account, many models. free-tier models: Llama 3, Mistral, etc. key from openrouter.ai/keys, no credit card for free models.</p>
      <p><strong>Gemini</strong> — Gemini 2.0 Flash free up to 1,500 req/day via Google AI Studio. key from aistudio.google.com.</p>
      <p><strong>Reckons.AI</strong> — managed AI inference on Cloudflare Workers. fast, private, no cold starts.</p>
      <p><strong>Claude</strong> — highest reasoning quality. usage-billed, not subscription. key from console.anthropic.com.</p>
      <p><strong>OpenAI</strong> — GPT-4o-mini or better. usage-billed. key from platform.openai.com.</p>
    </div>
  </details>
</section>

{#if usedProviders.has('claude')}
<section id="s-claude" class="card">
  <h3>claude</h3>
  <label class="field">
    <span class="lbl mono">api key</span>
    <input type="password" bind:value={key} placeholder="sk-ant-..." />
  </label>
  <label class="field">
    <span class="lbl mono">model</span>
    <input type="text" bind:value={claudeModel} />
  </label>
</section>
{/if}

{#if usedProviders.has('openai')}
<section id="s-openai" class="card">
  <h3>openai</h3>
  <label class="field">
    <span class="lbl mono">api key</span>
    <input type="password" bind:value={openaiKey} placeholder="sk-..." />
  </label>
  <label class="field">
    <span class="lbl mono">model</span>
    <input type="text" bind:value={openaiModel} />
  </label>
</section>
{/if}

{#if usedProviders.has('openrouter')}
<section id="s-openrouter" class="card">
  <h3>openrouter</h3>
  <p class="hint">free models: <code>meta-llama/llama-3.2-3b-instruct:free</code>, <code>mistralai/mistral-7b-instruct:free</code>. get a key at openrouter.ai/keys — no credit card needed for free-tier models.</p>
  <label class="field">
    <span class="lbl mono">api key</span>
    <input type="password" bind:value={openrouterKey} placeholder="sk-or-..." />
  </label>
  <label class="field">
    <span class="lbl mono">model</span>
    <input type="text" bind:value={openrouterModel} placeholder="meta-llama/llama-3.2-3b-instruct:free" />
  </label>
</section>
{/if}

{#if usedProviders.has('chrome-ai')}
<section id="s-chrome" class="card">
  <h3>chrome built-in AI</h3>
  <p class="hint">runs Gemini Nano inside Chrome with no API key. currently requires enabling an experimental flag — not yet available in stable Chrome by default.</p>
  <p class="hint" style="margin-top: 0.4rem;">
    enable: <code>chrome://flags/#prompt-api-for-gemini-nano</code> → Enabled → restart →
    <code>chrome://components</code> → update <em>Optimization Guide On Device Model</em>.
  </p>
  <p class="hint" style="margin-top: 0.4rem; color: var(--muted);">not supported in Firefox or mobile browsers.</p>
</section>
{/if}

{#if usedProviders.has('ollama')}
<section id="s-ollama" class="card">
  <h3>ollama <span class="local-badge mono">local</span></h3>
  <p class="hint">No API key needed. Run <code>ollama serve</code> then pull a model: <code>ollama pull llama3.2</code></p>
  <label class="field">
    <span class="lbl mono">base url</span>
    <input type="text" bind:value={ollamaBaseUrl} placeholder="http://localhost:11434" />
  </label>
  <label class="field">
    <span class="lbl mono">model</span>
    <input type="text" bind:value={ollamaModel} placeholder="llama3.2" />
  </label>
</section>
{/if}

{#if usedProviders.has('gemini')}
<section id="s-gemini" class="card">
  <h3>gemini</h3>
  <label class="field">
    <span class="lbl mono">api key</span>
    <input type="password" bind:value={geminiKey} placeholder="AIza..." />
  </label>
  <label class="field">
    <span class="lbl mono">model</span>
    <input type="text" bind:value={geminiModel} />
  </label>
</section>
{/if}

{#if usedProviders.has('wasm')}
<section id="s-wasm" class="card">
  <h3>local wasm</h3>

  {#if deviceProfile}
    <div class="device-profile">
      <span class="device-tier" class:tier-low={deviceProfile.tier === 'low'} class:tier-mid={deviceProfile.tier === 'mid'} class:tier-high={deviceProfile.tier === 'high'}>
        {deviceProfile.tier} spec
      </span>
      <span class="device-summary mono">{deviceProfile.summary}</span>
    </div>
  {/if}

  <div class="wasm-recs">
    {#each WASM_MODELS as rec}
      {@const isActive = wasmModel === rec.id}
      {@const isRecommended = deviceProfile?.recommendation.id === rec.id}
      <button
        class="wasm-rec-row"
        class:wasm-rec-active={isActive}
        onclick={() => { wasmModel = rec.id; }}
      >
        <div class="wasm-rec-top">
          <span class="wasm-rec-name mono">{rec.label}</span>
          <span class="wasm-rec-size mono">{rec.size}</span>
          {#if isRecommended}
            <span class="wasm-rec-badge">recommended</span>
          {/if}
        </div>
        <span class="wasm-rec-note">{rec.note}</span>
      </button>
    {/each}
  </div>

  <label class="field" style="margin-top: 0.75rem;">
    <span class="lbl mono">default wasm model</span>
    <input type="text" bind:value={wasmModel} placeholder="org/model-name" />
  </label>
  <p class="hint">
    any ONNX-exported instruct model works. browse
    <a href="https://huggingface.co/models?pipeline_tag=text-generation&library=transformers.js" target="_blank" rel="noopener">transformers.js-compatible models on HuggingFace</a>
    (filter: library → transformers.js).
  </p>

  <details class="per-task-wasm">
    <summary class="mono">per-task model overrides</summary>
    <p class="hint" style="margin-top: 0.5rem;">
      optionally use different models for each task. leave blank to use the default model above.
    </p>
    <label class="field">
      <span class="lbl mono">ingest model</span>
      <input type="text" bind:value={wasmIngestModel} placeholder="← default" />
    </label>
    <label class="field">
      <span class="lbl mono">analyze / diff model</span>
      <input type="text" bind:value={wasmAnalyzeModel} placeholder="← default" />
    </label>
    <label class="field">
      <span class="lbl mono">chat model</span>
      <input type="text" bind:value={wasmChatModel} placeholder="← default" />
    </label>
  </details>

  <div class="row">
    <button onclick={warmWasm} disabled={wasmLoading}>
      {wasmLoading ? 'preparing…' : 'download / prepare model'}
    </button>
  </div>
  {#if wasmLoading || wasmStatus}
    <div class="wasm-progress">
      {#if wasmLoading}
        <div class="wasm-prog-track" class:wasm-prog-indeterminate={wasmPct === null || wasmPct === 0}>
          {#if wasmPct !== null && wasmPct > 0}
            <div class="wasm-prog-fill" style="width: {wasmPct}%"></div>
          {:else}
            <div class="wasm-prog-fill wasm-prog-pulse"></div>
          {/if}
        </div>
      {/if}
      <span class="wasm-prog-text mono" class:wasm-prog-ready={wasmStatus === 'ready'} class:wasm-prog-error={!wasmLoading && wasmStatus && wasmStatus !== 'ready'}>
        {wasmStatus || 'starting…'}{wasmLoading && wasmPct !== null && wasmPct > 0 ? ` · ${wasmPct}%` : ''}
      </span>
      {#if !wasmLoading && wasmStatus && wasmStatus !== 'ready' && (wasmStatus.includes('registerBackend') || wasmStatus.includes('ONNX runtime'))}
        <p class="hint" style="margin-top:0.4rem;">
          ONNX runtime is not supported in this browser.
          Try <strong>Chrome AI</strong> (built-in Gemini Nano) or <strong>Ollama</strong> as a local alternative.
        </p>
      {/if}
    </div>
  {/if}
  <p class="hint">
    embedding model (all-MiniLM-L6-v2 · 22 MB) is downloaded automatically on first use. models are cached in the browser after the first download.
  </p>
</section>
{/if}

<section id="s-display" class="card">
  <h3>display</h3>
  <p class="hint">Adjust text size and graph label size. Changes take effect immediately.</p>

  <div class="field-row" style="margin-bottom: 1rem;">
    <span class="lbl mono">ui text size</span>
    <div class="btn-group">
      {#each (['sm', 'md', 'lg'] as const) as s}
        <button
          class="scale-btn"
          class:active={uiScale === s}
          onclick={() => { uiScale = s; saveDisplaySettings(); }}
        >{s === 'sm' ? 'small' : s === 'md' ? 'medium' : 'large'}</button>
      {/each}
    </div>
  </div>

  <label class="field">
    <span class="lbl mono">node label size <span class="muted">({nodeLabelFontSize}px)</span></span>
    <input
      type="range"
      min="7" max="20" step="1"
      bind:value={nodeLabelFontSize}
      onchange={saveDisplaySettings}
      style="flex: 1;"
    />
  </label>

  <div class="field row-field">
    <div>
      <span class="lbl mono">graph renderer</span>
      <p class="hint" style="margin: 0.1rem 0 0;">3D uses WebGL with interactive camera. 2D is lighter and works everywhere.</p>
    </div>
    <div class="btn-group">
      <button class="scale-btn" class:active={!prefer2D} onclick={() => { prefer2D = false; saveDisplaySettings(); }}>3D</button>
      <button class="scale-btn" class:active={prefer2D} onclick={() => { prefer2D = true; saveDisplaySettings(); }}>2D</button>
    </div>
  </div>

  <div class="field row-field">
    <div>
      <span class="lbl mono">always-on previews</span>
      <p class="hint" style="margin: 0.1rem 0 0;">Show every node's preview image at all times, instead of only on hover or during the story. The graph paints slower with many images.</p>
    </div>
    <button
      class="toggle-btn"
      class:on={settings().alwaysShowPreviews === true}
      onclick={() => updateSettings({ alwaysShowPreviews: settings().alwaysShowPreviews !== true })}
    >
      {settings().alwaysShowPreviews === true ? 'on' : 'off'}
    </button>
  </div>

  <div class="field row-field">
    <div>
      <span class="lbl mono">tutorial hints</span>
      <p class="hint" style="margin: 0.1rem 0 0;">Show contextual nudges as you use the app for the first time. Dismiss any hint to permanently hide it.</p>
    </div>
    <button
      class="toggle-btn"
      class:on={settings().showTutorialHints !== false}
      onclick={async () => {
        const next = settings().showTutorialHints === false;
        await updateSettings({ showTutorialHints: next });
        if (next) {
          // Clear dismissed tips so they can appear again
          try { localStorage.removeItem('reckons:dismissed-tips'); } catch { /* ignore */ }
        }
      }}
    >
      {settings().showTutorialHints !== false ? 'on' : 'off'}
    </button>
  </div>
</section>

<section id="s-mistral" class="card">
  <h3>mistral ocr <span class="badge paid">paid · document parsing</span></h3>
  <p class="hint">Convert PDFs and images to clean markdown before fact extraction. Drop a PDF or image on the <strong>document</strong> tab in Ingest and it will be parsed automatically when this key is set. Get a key at console.mistral.ai.</p>
  <label class="field">
    <span class="lbl mono">api key</span>
    <input type="password" bind:value={mistralApiKey} placeholder="..." />
  </label>
</section>

<section id="s-meshy" class="card">
  <h3>meshy.ai <span class="badge paid">paid · 3D generation</span></h3>
  <p class="hint">Generate a 3D .glb model icon for each entity type using text-to-3D AI. Configure entity type icons in <a href="/settings/entity-types">Settings → Entity Types</a>. Get a key at meshy.ai.</p>
  <label class="field">
    <span class="lbl mono">api key</span>
    <input type="password" bind:value={meshyApiKey} placeholder="msy_..." />
  </label>
</section>

<section id="s-google" class="card">
  <h3>google workspace</h3>
  <p class="sub">connect Google Drive and Calendar for file sync and timeline integration.</p>

  <label class="field">
    <span class="lbl mono">oauth client id</span>
    <input
      type="text"
      bind:value={googleClientId}
      placeholder="xxxx.apps.googleusercontent.com"
    />
  </label>
  <p class="hint">
    create a project at console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application). add your app's origin as an authorised JavaScript origin.
  </p>

  <div class="row" style="margin-top: 0.85rem;">
    {#if googleConnected}
      <span class="google-badge">● connected</span>
      <button onclick={disconnectGoogle}>disconnect</button>
    {:else}
      <button
        class="primary"
        onclick={connectGoogle}
        disabled={googleConnecting || !googleClientId.trim()}
      >
        {googleConnecting ? 'connecting…' : 'connect google account'}
      </button>
    {/if}
  </div>
  {#if googleError}
    <p class="hint" style="color: var(--danger); margin-top: 0.5rem;">{googleError}</p>
  {/if}
</section>

<section id="s-analyze" class="card analyze-card">
  <div class="analyze-header">
    <div>
      <h3>auto re-analysis</h3>
      <p class="sub">periodically scan your confirmed graph for new type, relation, and merge suggestions.</p>
    </div>
    <a href="/analyze" class="analyze-history-link mono">history ↗</a>
  </div>

  <div class="cost-warn mono">
    ⚠ each run sends entity data to your configured AI provider and costs API credits.
  </div>

  <div class="analyze-types-grid">
    <div class="analyze-type-chip">
      <span class="atype-glyph">◎</span>
      <span class="atype-label">enrich</span>
    </div>
    <div class="analyze-type-chip">
      <span class="atype-glyph">⟷</span>
      <span class="atype-label">merge entities</span>
    </div>
    <div class="analyze-type-chip">
      <span class="atype-glyph">◈</span>
      <span class="atype-label">entity types</span>
    </div>
    <div class="analyze-type-chip">
      <span class="atype-glyph">✕</span>
      <span class="atype-label">prune</span>
    </div>
  </div>

  <label class="check-row">
    <input type="checkbox" bind:checked={autoAnalyzeOnImport} />
    <div>
      <strong>re-analyze after each import</strong>
      <p class="check-hint">triggers one analysis run (with 1.5 s delay) every time a new source is imported.</p>
    </div>
  </label>

  <div class="interval-row">
    <span class="lbl mono">analyze every</span>
    <input
      class="interval-input"
      type="number"
      bind:value={autoAnalyzeIntervalMinutes}
      min="0"
      step="1"
    />
    <span class="lbl mono">minutes&nbsp;<span class="muted">(0 = off)</span></span>
  </div>
</section>

<section class="card">
  <h3>source refresh</h3>
  <p class="sub">automatically re-ingest URL, repository, and calendar sources to pick up changes.</p>

  <label class="check-row">
    <input type="checkbox" bind:checked={autoRefreshOnOpen} />
    <div>
      <strong>refresh sources on graph open</strong>
      <p class="check-hint">when the app loads, refresh all URL and repo sources to check for updates.</p>
    </div>
  </label>

  <div class="interval-row">
    <span class="lbl mono">refresh every</span>
    <input
      class="interval-input"
      type="number"
      bind:value={autoRefreshIntervalMinutes}
      min="0"
      step="1"
    />
    <span class="lbl mono">minutes&nbsp;<span class="muted">(0 = off)</span></span>
  </div>
</section>

<section id="s-defaults" class="card">
  <h3>my defaults</h3>
  <p class="sub">Save a snapshot of your current settings to restore later, or share as a portable profile. API keys are never included in shared profiles.</p>

  <div class="defaults-block">
    <div class="defaults-info">
      <strong>saved snapshot</strong>
      <p class="check-hint">
        {#if userDefaultsSavedAt}
          saved {userDefaultsSavedAt}
        {:else}
          no snapshot saved yet — save to enable one-click revert
        {/if}
      </p>
    </div>
    <div class="btn-group">
      <button class="primary" onclick={handleSaveDefaults}>save current</button>
      {#if userDefaultsSavedAt}
        <button onclick={handleRevertToDefaults}>revert</button>
        <button class="ghost danger-text" onclick={() => confirmClearDefaultsOpen = true}>clear</button>
      {/if}
    </div>
  </div>

  <div class="defaults-block" style="margin-top:0.75rem">
    <div class="defaults-info">
      <strong>settings profile</strong>
      <p class="check-hint">Portable JSON with model preferences and UI settings — no API keys. Import on another device to recreate your setup instantly.</p>
    </div>
    <div class="btn-group">
      <button onclick={handleExportProfile} disabled={exportProfileLoading}>
        {exportProfileLoading ? '…' : '↓ .json'}
      </button>
      <label class="btn ghost" style="cursor:pointer">
        import…
        <input type="file" accept=".json" style="display:none" onchange={handleImportProfile} />
      </label>
    </div>
  </div>
  {#if importProfileError}
    <p class="hint" style="color:var(--danger);margin-top:0.5rem">{importProfileError}</p>
  {/if}

  {#if confirmClearDefaultsOpen}
    <div class="confirm-inline">
      <span>Clear saved defaults?</span>
      <button class="ghost danger-text" onclick={handleClearDefaults}>yes, clear</button>
      <button class="ghost" onclick={() => confirmClearDefaultsOpen = false}>cancel</button>
    </div>
  {/if}
</section>

<section id="s-identity" class="card">
  <h3>graph identity</h3>
  <p class="sub">Unique identifiers for this graph — no account required.</p>

  <div class="id-row">
    <div class="id-block">
      <span class="lbl mono">stable ID</span>
      <p class="id-hint">Permanent — never changes as content evolves. Use for MCP routing and cloud sync.</p>
      <div class="id-value-row">
        <code class="id-value mono">{stableId ? formatStableId(stableId) : '…'}</code>
        {#if stableId}
          <button class="id-copy ghost mono" onclick={() => copyToClipboard(stableId, 'id')}>
            {copied === 'id' ? 'copied ✓' : 'copy full'}
          </button>
        {/if}
      </div>
      {#if stableId}
        <span class="id-full mono">{stableId}</span>
      {/if}
    </div>

    <div class="id-block">
      <span class="lbl mono">content fingerprint</span>
      <p class="id-hint">SHA-256 of confirmed facts — changes with every edit. Use for sync verification.</p>
      <div class="id-value-row">
        {#if contentHash}
          <code class="id-value mono">{formatContentHash(contentHash)}</code>
          <button class="id-copy ghost mono" onclick={() => copyToClipboard(contentHash, 'hash')}>
            {copied === 'hash' ? 'copied ✓' : 'copy full'}
          </button>
        {:else}
          <span class="id-value mono muted">—</span>
        {/if}
        <button class="id-refresh mono" onclick={refreshHash} disabled={hashLoading}>
          {hashLoading ? 'hashing…' : contentHash ? '↻' : 'compute'}
        </button>
      </div>
      {#if contentHash}
        <span class="id-full mono">{contentHash}</span>
      {/if}
    </div>
  </div>
</section>

<section id="s-extension" class="card">
  <h3>browser extension highlights</h3>
  <p class="sub">colors and label style for the Compare page overlay. click "sync graph" in the extension after saving to apply.</p>

  <div class="field">
    <span class="lbl mono">highlight colors</span>
    <div class="color-row">
      <div class="color-field">
        <span class="lbl mono" style="font-size:0.62rem">conflict</span>
        <input type="color" bind:value={hlConflictColor} />
      </div>
      <div class="color-field">
        <span class="lbl mono" style="font-size:0.62rem">reinforce</span>
        <input type="color" bind:value={hlReinforceColor} />
      </div>
      <div class="color-field">
        <span class="lbl mono" style="font-size:0.62rem">new</span>
        <input type="color" bind:value={hlNewColor} />
      </div>
    </div>
  </div>

  <div class="field">
    <span class="lbl mono">saturation</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" bind:value={hlSaturation} />
      <span class="slider-val mono">{hlSaturation}%</span>
    </div>
  </div>

  <div class="field">
    <span class="lbl mono">label font</span>
    <Select bind:value={hlFontFamily} options={[
      { value: 'monospace', label: 'Monospace' },
      { value: 'sans-serif', label: 'Sans-serif' },
      { value: 'serif', label: 'Serif' },
      { value: "'Courier New', monospace", label: 'Courier New' },
      { value: "'Georgia', serif", label: 'Georgia' },
    ]} />
  </div>

  <div class="field">
    <span class="lbl mono">label size (base)</span>
    <div class="slider-row">
      <input type="range" min="7" max="18" bind:value={hlFontSize} />
      <span class="slider-val mono">{hlFontSize}px</span>
    </div>
  </div>

  <div class="field">
    <span class="lbl mono">on-hover enlarge</span>
    <div class="slider-row">
      <input type="range" min="100" max="300" bind:value={hlHoverScale} />
      <span class="slider-val mono">{hlHoverScale}%</span>
    </div>
  </div>
</section>

<section id="s-backup" class="card">
  <h3>backup & export</h3>
  <p class="sub">export your graph as RDF Turtle (.ttl). no data is sent anywhere.</p>

  {#if isAutoSaveSupported()}
    <div class="autosave-row">
      <div class="autosave-info">
        <strong>auto-save to file</strong>
        <p class="check-hint">
          {#if autoSaveLinked}
            writing to <code class="mono">{autoSaveFileName}</code> after each change
          {:else}
            pick a .ttl file — the graph will be written there after every mutation
          {/if}
        </p>
      </div>
      {#if autoSaveLinked}
        <button class="ghost mono" onclick={handleClearAutoSave}>unlink</button>
      {:else}
        <button class="primary" onclick={handlePickAutoSave}>pick file…</button>
      {/if}
    </div>
  {:else}
    <p class="hint" style="color:var(--muted)">auto-save requires Chrome or Edge (File System Access API)</p>
  {/if}

  <div class="export-grid">
    <div class="export-item">
      <div>
        <strong>clean export</strong>
        <p class="check-hint">confirmed &amp; refined facts only — standard RDF, no annotations. best for interop with other tools.</p>
      </div>
      <button onclick={handleBackup} disabled={backupLoading} class="backup-btn">
        {backupLoading ? '…' : '↓ .ttl'}
      </button>
    </div>

    <div class="export-item">
      <div>
        <strong>full export</strong>
        <p class="check-hint">all facts (pending, rejected, superseded) with status, confidence, and source metadata as RDF annotations. round-trips on import.</p>
      </div>
      <button onclick={handleExportFull} disabled={exportingFull}>
        {exportingFull ? '…' : '↓ .ttl'}
      </button>
    </div>

    <div class="export-item">
      <div>
        <strong>pending preview</strong>
        <p class="check-hint">pending facts only — save as a temporary graph to inspect before confirming.</p>
      </div>
      <button onclick={handleExportPending} disabled={exportingPending}>
        {exportingPending ? '…' : '↓ .ttl'}
      </button>
    </div>

    <div class="export-item">
      <div>
        <strong>changelog</strong>
        <p class="check-hint">full mutation history — all confirms, rejects, merges, and trust changes with timestamps.</p>
      </div>
      <button onclick={handleExportChangelog} disabled={exportingChangelog}>
        {exportingChangelog ? '…' : '↓ .csv'}
      </button>
    </div>
  </div>
</section>

<section class="settings-section">
  <h2 class="section-title">Semantic Web &amp; LLM Search</h2>
  <p class="section-desc">Export your graph in structured formats that help AI crawlers, LLM search systems, and Schema.org-aware tools understand your content.</p>
  <div class="export-list">
    <div class="export-item">
      <div>
        <strong>JSON-LD / Schema.org</strong>
        <p class="check-hint">Structured data graph using Schema.org vocabulary. Embed in a <code>&lt;script type="application/ld+json"&gt;</code> tag on any web page for Google, Bing, and LLM crawlers.</p>
      </div>
      <button onclick={handleExportJsonLd} disabled={exportingJsonLd}>
        {exportingJsonLd ? '…' : '↓ .jsonld'}
      </button>
    </div>
    <div class="export-item">
      <div>
        <strong>llms.txt</strong>
        <p class="check-hint">Plain-text graph summary for AI crawlers, following the <a href="https://llmstxt.org" target="_blank" rel="noopener">llmstxt.org</a> spec. Serve at <code>/llms.txt</code> on your site so LLMs can quickly understand your content during indexing or RAG retrieval.</p>
      </div>
      <button onclick={handleExportLlmsTxt} disabled={exportingLlmsTxt}>
        {exportingLlmsTxt ? '…' : '↓ llms.txt'}
      </button>
    </div>
  </div>
</section>

<!-- ── Workspace ──────────────────────────────────────────────────────────── -->
<section id="s-workspace" class="card">
  <h3>local workspace</h3>
  <p class="sub">
    Link a local folder as your Reckons home. All graphs are auto-synced there as TTL files,
    so your data survives browser cache clears. Place the folder inside Dropbox, iCloud
    Drive, or OneDrive for cross-device sync — no account required.
  </p>

  {#if supportsWorkspace()}
    {#if workspaceState() === 'none'}
      <button class="primary" onclick={handlePickWorkspace} disabled={workspaceConnecting}>
        {workspaceConnecting ? 'picking…' : 'pick Reckons home folder…'}
      </button>
    {:else if workspaceState() === 'disconnected'}
      <div class="ws-row">
        <span class="ws-name mono">{workspaceName()}</span>
        <span class="ws-badge ws-badge-off">permission required</span>
        <button onclick={handleReconnectWorkspace} disabled={workspaceConnecting}>
          {workspaceConnecting ? 'requesting…' : 'reconnect'}
        </button>
        <button class="ghost" onclick={clearWorkspace}>unlink</button>
      </div>
      <p class="hint">Browser security requires re-granting folder access each session.</p>
    {:else}
      <div class="ws-row">
        <span class="ws-name mono">{workspaceName()}</span>
        <span class="ws-badge ws-badge-on">connected</span>
        <button class="ghost" onclick={clearWorkspace}>unlink</button>
      </div>
    {/if}

    {#if workspaceState() === 'connected'}
      <div class="ws-profile-row">
        <div class="defaults-info">
          <strong>graph folder sync</strong>
          <p class="check-hint">
            All graphs are auto-synced to <code>kbs/</code> in your workspace folder on every change.
            {#if lastSyncTime()}
              Last synced: {new Date(lastSyncTime()!).toLocaleTimeString()}.
            {/if}
            {#if syncedKbCount() > 0}
              {syncedKbCount()} graph{syncedKbCount() !== 1 ? 's' : ''} in folder.
            {/if}
          </p>
        </div>
        <div class="btn-group">
          <button onclick={handleSyncAllKbs} disabled={wsSyncing}>
            {wsSyncing ? 'syncing…' : 'sync all graphs now'}
          </button>
        </div>
      </div>
      {#if wsSyncMsg}
        <p class="hint" style="color:var(--accent);margin-top:0.4rem">{wsSyncMsg}</p>
      {/if}

      <div class="ws-profile-row">
        <div class="defaults-info">
          <strong>import from folder</strong>
          <p class="check-hint">
            Import graphs found in the workspace folder that aren't in the browser yet.
            <strong>Any <code>.ttl</code> anywhere in the folder</strong> becomes a graph (searched
            recursively; <code>node_modules</code>, <code>build</code>, and hidden folders like
            <code>.git</code> are skipped).
          </p>
        </div>
        <div class="btn-group">
          <button onclick={handleImportFromWorkspace} disabled={wsImporting}>
            {wsImporting ? 'importing…' : 'import graphs from folder'}
          </button>
        </div>
      </div>
      {#if wsImportMsg}
        <p class="hint" style="color:var(--accent);margin-top:0.4rem">{wsImportMsg}</p>
      {/if}

      <div class="ws-profile-row">
        <div class="defaults-info">
          <strong>settings profile sync</strong>
          <p class="check-hint">
            Save <code>settings_profile.json</code> to your workspace and load it on any
            browser or device. No API keys are included — those stay on this device.
          </p>
        </div>
        <div class="btn-group">
          <button onclick={handleSaveProfileToWorkspace} disabled={wsSaveLoading}>
            {wsSaveLoading ? '…' : '↓ save to folder'}
          </button>
          <button onclick={handleLoadProfileFromWorkspace} disabled={wsLoadLoading}>
            {wsLoadLoading ? '…' : '↑ load from folder'}
          </button>
        </div>
      </div>
      {#if wsProfileError}
        <p class="hint" style="color:var(--danger);margin-top:0.4rem">{wsProfileError}</p>
      {/if}
      {#if wsProfileSuccess}
        <p class="hint" style="color:var(--accent);margin-top:0.4rem">{wsProfileSuccess}</p>
      {/if}
    {/if}
  {:else}
    <p class="hint" style="color:var(--muted)">
      Local workspace requires Chrome or Edge (File System Access API). Firefox and Safari
      do not support this feature. Use the settings profile export/import in "My Defaults"
      above as a cross-browser alternative.
    </p>
  {/if}
</section>

<!-- ── .env reference ──────────────────────────────────────────────────────── -->
<section class="card">
  <details>
    <summary class="mono" style="cursor:pointer; color:var(--muted)">developer · .env configuration</summary>
    <div class="env-body">
      <p class="hint">
        When running a self-hosted instance, create a <code>.env</code> file in the project root
        (or in your workspace folder) with any of the variables below. They are baked in at
        <code>vite build</code> time — a deployed web app cannot read .env at runtime.
      </p>
      <table class="env-table">
        <thead><tr><th>Variable</th><th>Maps to</th><th>Default</th></tr></thead>
        <tbody>
          <tr><td><code>VITE_ANTHROPIC_API_KEY</code></td><td>Claude API key</td><td>—</td></tr>
          <tr><td><code>VITE_CLAUDE_MODEL</code></td><td>Claude model</td><td>claude-haiku-4-5-20251001</td></tr>
          <tr><td><code>VITE_OPENAI_API_KEY</code></td><td>OpenAI API key</td><td>—</td></tr>
          <tr><td><code>VITE_OPENAI_MODEL</code></td><td>OpenAI model</td><td>gpt-4o-mini</td></tr>
          <tr><td><code>VITE_GEMINI_API_KEY</code></td><td>Gemini API key</td><td>—</td></tr>
          <tr><td><code>VITE_GEMINI_MODEL</code></td><td>Gemini model</td><td>gemini-2.0-flash</td></tr>
          <tr><td><code>VITE_PREFERRED_BACKEND</code></td><td>Default backend</td><td>claude</td></tr>
          <tr><td><code>VITE_OLLAMA_BASE_URL</code></td><td>Ollama URL</td><td>http://localhost:11434</td></tr>
          <tr><td><code>VITE_OLLAMA_MODEL</code></td><td>Ollama model</td><td>llama3.2</td></tr>
          <tr><td><code>VITE_OPENROUTER_MODEL</code></td><td>OpenRouter model</td><td>meta-llama/llama-3.2-3b-instruct:free</td></tr>
          <tr><td><code>VITE_WASM_MODEL</code></td><td>WASM/HuggingFace model ID</td><td>onnx-community/Qwen2.5-0.5B-Instruct</td></tr>
        </tbody>
      </table>
      <p class="hint" style="margin-top:0.6rem">
        Settings saved in-app (this page) always override .env values for the current session.
        For a new user on the deployed site, only in-app settings apply.
      </p>
    </div>
  </details>
</section>

<!-- ── Reset to defaults ──────────────────────────────────────────────────── -->
<section class="card">
  <div class="reset-row">
    <div>
      <h3>reset to defaults</h3>
      <p class="sub">Restore all backend, model, and analysis settings to factory defaults. API keys will also be cleared.</p>
    </div>
    <button class="danger-btn" onclick={() => { confirmResetOpen = true; }}>reset…</button>
  </div>
</section>

<!-- ── Support footer ───────────────────────────────────────────────────── -->
<footer class="settings-support-footer">
  <a href="https://www.paypal.com/ncp/payment/KH5J484QMVFS2" target="_blank" rel="noopener noreferrer" class="support-link mono">☕ buy me a coffee</a>
  <p class="mono support-sub">Reckons.AI is free, open source, and self-funded.</p>
</footer>

<!-- Reset confirmation dialog -->
<Dialog.Root bind:open={confirmResetOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="reset-overlay" />
    <Dialog.Content class="reset-modal" aria-describedby="reset-desc">
      <Dialog.Title class="reset-title">Reset all settings?</Dialog.Title>
      <Dialog.Description id="reset-desc" class="reset-desc">
        This will clear all API keys, model selections, and preferences, restoring
        factory defaults. Your graph data is not affected.
      </Dialog.Description>
      <div class="reset-actions">
        <Dialog.Close class="reset-cancel">Cancel</Dialog.Close>
        <button class="danger-btn" onclick={handleReset}>Yes, reset everything</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Auto-save indicator -->
<div class="autosave-indicator" class:autosave-pulse={savedPulse}>
  {savedPulse ? 'saved ✓' : 'settings auto-save on'}
</div>

<style>
  /* ── Provider status dots ───────────────────────────────────────────────── */
  .provider-status-card { padding-bottom: 0.75rem; }
  .provider-dots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  .provider-dot {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem 0.2rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    font-size: 0.68rem;
  }
  .dot-pip {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--muted);
    flex-shrink: 0;
  }
  .dot-ready .dot-pip    { background: var(--accent); }
  .dot-configured .dot-pip { background: #e8a838; }
  .dot-loading .dot-pip  { background: #e8a838; animation: dot-pulse 1s ease-in-out infinite; }
  .dot-error .dot-pip    { background: var(--danger, #e55); }
  .dot-off               { opacity: 0.4; }
  .dot-warm {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.62rem;
    padding: 0;
    text-decoration: underline;
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .head { margin-bottom: 1.25rem; }
  .kicker {
    color: var(--accent);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .settings-nav {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    border-bottom: 1px solid var(--line);
    padding-bottom: 0.75rem;
  }
  .section-toc {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.75rem;
    padding: 0;
  }
  .section-toc a {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.22rem 0.5rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    text-decoration: none;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
    white-space: nowrap;
  }
  .section-toc a:hover {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .nav-link {
    padding: 0.35rem 0.75rem;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    border: 1px solid transparent;
    transition: all 0.15s;
  }
  .nav-link:hover {
    color: var(--ink-2);
    border-color: var(--muted-2);
  }
  .nav-link.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .card + .card { margin-top: 1rem; }
  .card h3 {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }
  .sub { color: var(--muted); margin: 0 0 0.9rem; }
  .radio { display: flex; flex-direction: column; gap: 0.6rem; }
  .radio label {
    display: flex;
    gap: 0.85rem;
    padding: 0.85rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    cursor: pointer;
    align-items: flex-start;
  }
  .radio label:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .radio strong { font-family: var(--font-display); font-size: 1.1rem; }
  .radio p { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.82rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.7rem; }
  .field-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .btn-group { display: flex; gap: 0.35rem; flex-wrap: wrap; }
  .defaults-block { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .defaults-info { flex: 1; min-width: 0; }
  .defaults-info strong { font-size: 0.9rem; }
  .danger-text { color: var(--danger) !important; }
  .confirm-inline { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; padding: 0.6rem 0.75rem; background: var(--surface-2); border-radius: var(--rad-sm); font-size: 0.82rem; flex-wrap: wrap; }
  label.btn { display: inline-flex; align-items: center; padding: 0.35rem 0.7rem; border: 1px solid var(--line); border-radius: var(--rad-sm); background: var(--surface-2); font-size: 0.8rem; color: var(--muted); transition: all 0.15s; }
  label.btn:hover { color: var(--ink-2); border-color: var(--muted); }
  .scale-btn {
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .scale-btn:hover { color: var(--ink-2); border-color: var(--muted); }
  .scale-btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .lbl { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; }
  .row { display: flex; gap: 0.7rem; align-items: center; margin-top: 0.7rem; flex-wrap: wrap; }
  .status { color: var(--data); font-size: 0.78rem; }
  .wasm-progress { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.5rem; }
  .wasm-prog-track {
    height: 4px; background: var(--surface-3); border-radius: 999px; overflow: hidden;
  }
  .wasm-prog-fill {
    height: 100%; background: var(--accent); border-radius: 999px;
    transition: width 0.4s ease-out;
  }
  .wasm-prog-pulse {
    width: 40%;
    animation: wasm-slide 1.4s ease-in-out infinite;
  }
  @keyframes wasm-slide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }
  .wasm-prog-text { font-size: 0.72rem; color: var(--muted); }
  .wasm-prog-ready { color: var(--ok, #22c55e); }
  .wasm-prog-error { color: var(--danger, #ef4444); }
  .hint { color: var(--muted); font-size: 0.78rem; margin: 0.3rem 0 0.7rem; }
  .hint a { color: var(--accent); text-decoration: underline; }
  /* Device profile */
  .device-profile {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;
    padding: 0.4rem 0.6rem; border-radius: var(--rad-sm);
    background: var(--surface-2); border: 1px solid var(--line);
  }
  .device-tier {
    font-size: 0.65rem; font-family: var(--font-mono); border-radius: 999px;
    padding: 0.1rem 0.5rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  }
  .tier-low { background: rgba(239,68,68,0.12); color: #f87171; }
  .tier-mid { background: rgba(251,191,36,0.12); color: #fbbf24; }
  .tier-high { background: rgba(34,211,238,0.12); color: var(--accent); }
  .device-summary { font-size: 0.7rem; color: var(--muted); }
  /* WASM model recommendations */
  .wasm-recs { display: flex; flex-direction: column; gap: 0.35rem; }
  .wasm-rec-row {
    display: flex; flex-direction: column; gap: 0.15rem;
    padding: 0.55rem 0.65rem; border-radius: var(--rad-sm);
    background: var(--surface-2); border: 1px solid var(--line);
    text-align: left; cursor: pointer; transition: border-color 0.15s, background 0.15s;
    width: 100%;
  }
  .wasm-rec-row:hover { border-color: var(--accent); background: var(--accent-soft); }
  .wasm-rec-active { border-color: var(--accent) !important; background: var(--accent-soft) !important; }
  .wasm-rec-top { display: flex; align-items: center; gap: 0.5rem; }
  .wasm-rec-name { font-size: 0.78rem; color: var(--ink); }
  .wasm-rec-size { font-size: 0.7rem; color: var(--muted); }
  .wasm-rec-badge {
    font-size: 0.6rem; font-family: var(--font-mono); border-radius: 999px;
    padding: 0.05rem 0.45rem; background: rgba(34,211,238,0.15);
    color: var(--accent); border: 1px solid var(--accent); margin-left: auto;
  }
  .wasm-rec-note { font-size: 0.7rem; color: var(--muted); }
  .per-task-wasm { margin-top: 0.75rem; }
  .per-task-wasm summary {
    font-size: 0.75rem; color: var(--accent); cursor: pointer;
    padding: 0.3rem 0; user-select: none;
  }
  .per-task-wasm summary:hover { text-decoration: underline; }
  .per-task-wasm .field { margin-top: 0.4rem; }
  .local-badge { font-size: 0.62rem; color: var(--ok); border: 1px solid var(--ok); border-radius: 999px; padding: 0.05rem 0.4rem; vertical-align: middle; margin-left: 0.3rem; }
  .badge { font-size: 0.6rem; border-radius: 999px; padding: 0.05rem 0.45rem; vertical-align: middle; margin-left: 0.35rem; font-family: var(--font-mono); font-weight: 500; }
  .badge.free { color: var(--ok, #22c55e); border: 1px solid var(--ok, #22c55e); }
  .badge.openrouter { color: #a78bfa; border: 1px solid #a78bfa; }
  .badge.gemini { color: #60a5fa; border: 1px solid #60a5fa; }
  .badge.paid { color: var(--muted); border: 1px solid var(--muted); }
  /* Task backends */
  .task-backends { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.9rem; }
  .task-category-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    padding: 0.6rem 0.2rem 0.15rem;
    border-bottom: 1px solid var(--line);
    margin-top: 0.3rem;
  }
  .task-category-header:first-child { margin-top: 0; }
  .set-all-btn {
    font-size: 0.6rem;
    color: var(--accent);
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.15s;
  }
  .set-all-btn:hover { opacity: 1; }
  .task-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.65rem 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .task-row-sub {
    margin-left: 1rem;
    opacity: 0.85;
    border-style: dashed;
  }
  .task-info { flex: 1; display: flex; flex-direction: column; gap: 0.15rem; }
  .task-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); }
  .task-desc  { font-size: 0.75rem; color: var(--muted); }
  .task-inherits { font-size: 0.68rem; color: var(--muted); opacity: 0.7; white-space: nowrap; }
  .backend-sel-wrap {
    width: 250px;
    flex-shrink: 0;
  }
  .backend-detail {
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    overflow: hidden;
  }
  .backend-detail summary {
    padding: 0.45rem 0.75rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    cursor: pointer;
    background: var(--surface-2);
    list-style: none;
  }
  .backend-detail summary::-webkit-details-marker { display: none; }
  .backend-detail summary::before { content: '▶ '; font-size: 0.6rem; }
  .backend-detail[open] summary::before { content: '▼ '; }
  .backend-detail-body {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .backend-detail-body p { margin: 0; font-size: 0.78rem; color: var(--muted); }
  .backend-detail-body strong { color: var(--ink-2); }

  .save-row { margin-top: 1.25rem; }
  .backup-btn {
    padding: 0.6rem 1.2rem;
    background: var(--data-soft);
    border: 1px solid var(--data);
    border-radius: var(--rad-sm);
    color: var(--data);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .backup-btn:hover:not(:disabled) {
    background: var(--data);
    color: #fff;
  }
  .backup-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .autosave-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem;
    background: var(--surface-2);
    border-radius: var(--rad-sm);
    margin-bottom: 1rem;
  }
  .autosave-info { flex: 1; }
  .autosave-info strong { font-size: 0.85rem; }
  .export-grid {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .export-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .export-item > div { flex: 1; }
  .export-item strong { font-size: 0.82rem; }
  .export-item button {
    white-space: nowrap;
    padding: 0.35rem 0.8rem;
    font-size: 0.78rem;
  }
  .google-badge {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--ok);
  }
  .cost-warn {
    font-size: 0.72rem;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line));
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.7rem;
    margin-bottom: 0.75rem;
    line-height: 1.4;
  }
  .check-row {
    display: flex;
    gap: 0.85rem;
    padding: 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    cursor: pointer;
    align-items: flex-start;
    margin-bottom: 0.6rem;
  }
  .check-row:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .check-row strong { font-family: var(--font-display); font-size: 1rem; }
  .check-hint { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.78rem; }
  .interval-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
  }
  .interval-input {
    width: 5rem;
    text-align: center;
    padding: 0.3rem 0.5rem;
  }
  .muted { color: var(--muted); }

  /* Extension highlight fields */
  .color-row { display: flex; gap: 0.6rem; }
  .color-field { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }
  .color-field input[type="color"] {
    width: 100%; height: 36px; padding: 2px 4px; cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .slider-row { display: flex; align-items: center; gap: 0.6rem; }
  .slider-row input[type="range"] { flex: 1; accent-color: var(--accent); }
  .slider-val { font-size: 0.72rem; color: var(--muted); min-width: 38px; text-align: right; }

  /* KB Identity */
  .id-row {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .id-block {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.75rem 0.9rem;
  }
  .id-hint {
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0.2rem 0 0.6rem;
    line-height: 1.4;
  }
  .id-value-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .id-value {
    font-size: 1rem;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: 0.08em;
    background: none;
    padding: 0;
  }
  .id-full {
    display: block;
    font-size: 0.6rem;
    color: var(--muted);
    margin-top: 0.35rem;
    word-break: break-all;
    line-height: 1.4;
    opacity: 0.7;
  }
  .id-copy, .id-refresh {
    font-size: 0.65rem;
    color: var(--muted);
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    cursor: pointer;
    background: var(--surface);
    transition: all 0.12s;
  }
  .id-copy:hover, .id-refresh:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .id-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Analyze card ── */
  .analyze-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.1rem;
  }
  .analyze-history-link {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 0.25rem 0.65rem;
    white-space: nowrap;
    transition: background 0.12s;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }
  .analyze-history-link:hover { background: var(--accent-soft); }

  .analyze-types-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.4rem;
    margin: 0.75rem 0;
  }
  .analyze-type-chip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    padding: 0.55rem 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .atype-glyph {
    font-size: 0.95rem;
    color: var(--accent);
    font-family: var(--font-mono);
    line-height: 1;
  }
  .atype-label {
    font-size: 0.58rem;
    color: var(--muted);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    text-align: center;
    line-height: 1.3;
  }

  /* ── Workspace ── */
  .ws-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .ws-profile-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--line); }
  .ws-name { font-size: 0.82rem; color: var(--ink-2); }
  .ws-badge { font-size: 0.7rem; font-family: var(--font-mono); padding: 0.15rem 0.5rem; border-radius: var(--rad-sm); }
  .ws-badge-on  { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid var(--accent); }
  .ws-badge-off { background: color-mix(in srgb, var(--muted) 12%, transparent);  color: var(--muted);  border: 1px solid var(--line); }

  /* ── .env table ── */
  .env-body { margin-top: 0.75rem; }
  .env-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; margin-top: 0.5rem; }
  .env-table th { text-align: left; color: var(--muted); font-family: var(--font-mono); font-weight: 400; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--line); }
  .env-table td { padding: 0.3rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); vertical-align: top; }
  .env-table code { font-size: 0.75rem; }

  /* ── Reset section ── */
  .reset-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .reset-row h3 { margin: 0 0 0.25rem; }
  .danger-btn {
    padding: 0.4rem 0.9rem;
    background: color-mix(in srgb, #e53e3e 15%, transparent);
    color: #e53e3e;
    border: 1px solid #e53e3e;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .danger-btn:hover { background: color-mix(in srgb, #e53e3e 25%, transparent); }

  /* ── Reset dialog ── */
  :global(.reset-overlay) {
    position: fixed; inset: 0;
    background: #0007;
    backdrop-filter: blur(4px);
    z-index: 800;
  }
  :global(.reset-modal) {
    position: fixed; left: 50%; top: 50%; translate: -50% -50%;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.5rem;
    z-index: 801;
    max-width: 420px;
    width: calc(100vw - 2rem);
    box-shadow: 0 8px 32px #0006;
  }
  :global(.reset-title) { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.6rem; }
  :global(.reset-desc) { color: var(--muted); font-size: 0.85rem; margin: 0 0 1.2rem; line-height: 1.5; }
  :global(.reset-actions) { display: flex; gap: 0.6rem; justify-content: flex-end; }
  :global(.reset-cancel) {
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    cursor: pointer;
  }
  :global(.reset-cancel:hover) { color: var(--ink-2); border-color: var(--muted-2); }

  /* ── Auto-save indicator ── */
  .autosave-indicator {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--muted);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.25rem 0.6rem;
    opacity: 0.6;
    transition: color 0.3s, opacity 0.3s;
    pointer-events: none;
  }
  .autosave-indicator.autosave-pulse {
    color: var(--accent);
    opacity: 1;
  }

  /* ── Support footer ──────────────────────────────────────────── */
  .settings-support-footer {
    text-align: center;
    padding: 1.5rem 1rem;
    margin-top: 0.5rem;
    border-top: 1px solid var(--line);
  }
  .support-link {
    font-size: 0.8rem;
    color: var(--accent);
    text-decoration: none;
    transition: opacity 0.15s;
  }
  .support-link:hover { opacity: 0.7; }
  .support-sub {
    font-size: 0.65rem;
    color: var(--muted);
    margin: 0.3rem 0 0;
  }
</style>
