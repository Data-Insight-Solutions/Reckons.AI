<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import type { SettingsRecord } from '$lib/storage/db';
  import QRSharePanel from '$lib/components/QRSharePanel.svelte';
  import {
    inspectModelCache, sideloadModel, purgeModelCache, formatBytes,
    MODEL_MANIFESTS, type CachedModelStatus, type SideloadProgress,
    saveModelToWorkspace, restoreModelFromWorkspace, inspectWorkspaceModels,
    type WorkspaceModelStatus
  } from '$lib/integrations/llm/model-cache';
  import { workspaceState } from '$lib/stores/workspace.svelte';

  /**
   * Integrations — provider-first settings matrix.
   *
   * Instead of choosing a provider per-feature, you configure each
   * provider once (key + model) and assign which features use it.
   * A "local-first" preference toggle controls fallback behavior.
   *
   * Offline tiers:
   *   GPU   → Ollama (needs dedicated GPU, best quality)
   *   CPU   → WASM transformers.js (runs anywhere, slower)
   *   None  → Cloud only; offline = degraded
   */

  type Feature = 'ingest' | 'analyze' | 'chat';

  type ProviderDef = {
    id: string;
    label: string;
    offline: boolean;
    offlineTier?: 'gpu' | 'cpu';
    color: string;
    keyField?: keyof SettingsRecord;
    modelField?: keyof SettingsRecord;
    keyPlaceholder?: string;
    modelDefault?: string;
    features: Feature[];
    docsUrl: string;
    note: string;
  };

  const PROVIDERS: ProviderDef[] = [
    {
      id: 'claude',
      label: 'Claude',
      offline: false,
      color: '#d4845a',
      keyField: 'claudeApiKey',
      modelField: 'claudeModel',
      keyPlaceholder: 'sk-ant-...',
      modelDefault: 'claude-haiku-4-5-20251001',
      features: ['ingest', 'analyze', 'chat'],
      docsUrl: 'https://console.anthropic.com/',
      note: 'Best reasoning quality. Paid. Haiku is fast + cheap for ingest.'
    },
    {
      id: 'openai',
      label: 'OpenAI',
      offline: false,
      color: '#19c37d',
      keyField: 'openaiApiKey',
      modelField: 'openaiModel',
      keyPlaceholder: 'sk-...',
      modelDefault: 'gpt-4o-mini',
      features: ['ingest', 'analyze', 'chat'],
      docsUrl: 'https://platform.openai.com/',
      note: 'GPT-4o-mini is fast and cheap. GPT-4o for best quality.'
    },
    {
      id: 'gemini',
      label: 'Gemini',
      offline: false,
      color: '#4285f4',
      keyField: 'geminiApiKey',
      modelField: 'geminiModel',
      keyPlaceholder: 'AIza...',
      modelDefault: 'gemini-2.0-flash',
      features: ['ingest', 'analyze', 'chat'],
      docsUrl: 'https://aistudio.google.com/',
      note: 'Gemini 2.0 Flash: generous free tier (1,500 req/day). Great for ingest.'
    },
    {
      id: 'reckons',
      label: 'Reckons.AI',
      offline: false,
      color: '#1a9b8e',
      keyField: 'reckonsApiKey' as keyof SettingsRecord,
      modelField: 'reckonsModel' as keyof SettingsRecord,
      keyPlaceholder: 'rck-...',
      modelDefault: '@cf/meta/llama-3.1-8b-instruct',
      features: ['ingest', 'analyze', 'chat'] as Feature[],
      docsUrl: 'https://reckons.ai',
      note: 'Managed AI inference on Cloudflare Workers — fast, private, no cold starts. Keys provisioned via reckons.ai subscription.'
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      offline: false,
      color: '#7c3aed',
      keyField: 'openrouterApiKey',
      modelField: 'openrouterModel',
      keyPlaceholder: 'sk-or-...',
      modelDefault: 'meta-llama/llama-3.2-3b-instruct:free',
      features: ['ingest', 'analyze', 'chat'],
      docsUrl: 'https://openrouter.ai/keys',
      note: 'Access 200+ models via one key. Many free-tier options. No credit card for free models.'
    },
    {
      id: 'firecrawl',
      label: 'Firecrawl',
      offline: false,
      color: '#e05c4b',
      keyField: 'firecrawlApiKey' as keyof SettingsRecord,
      modelField: undefined,
      keyPlaceholder: 'fc-...',
      features: [],
      docsUrl: 'https://firecrawl.dev',
      note: 'JS-rendered web scraping — replaces Jina Reader for URL ingestion when a key is set. Handles SPAs, paywalled content, and complex layouts. 500 free credits/mo.'
    },
    {
      id: 'tavily',
      label: 'Tavily',
      offline: false,
      color: '#6366f1',
      keyField: 'tavilyApiKey' as keyof SettingsRecord,
      modelField: undefined,
      keyPlaceholder: 'tvly-...',
      features: [],
      docsUrl: 'https://tavily.com',
      note: 'AI-optimized web search for graph enrichment. Powers the Enrich analysis action. 1,000 free searches/mo.'
    },
    {
      id: 'mistral',
      label: 'Mistral',
      offline: false,
      color: '#f97316',
      keyField: 'mistralApiKey',
      modelField: undefined,
      keyPlaceholder: '...',
      features: [],  // Mistral used for OCR parsing only (not chat/ingest extraction yet)
      docsUrl: 'https://console.mistral.ai/',
      note: 'Used for Mistral OCR: PDF and image → markdown parsing. Drop a PDF on the document ingest tab.'
    },
    {
      id: 'github',
      label: 'GitHub',
      offline: false,
      color: '#8b949e',
      keyField: 'githubToken' as keyof SettingsRecord,
      modelField: undefined,
      keyPlaceholder: 'ghp_...',
      features: [],
      docsUrl: 'https://github.com/settings/tokens',
      note: 'Personal access token for repo ingest. Enables private repos and 5,000 req/hr (vs 60/hr unauthenticated). Fine-grained tokens recommended.'
    },
    {
      id: 'ollama',
      label: 'Ollama',
      offline: true,
      offlineTier: 'gpu',
      color: '#1a9b8e',
      keyField: undefined,
      modelField: 'ollamaModel',
      modelDefault: 'llama3.2',
      features: ['ingest', 'analyze', 'chat'],
      docsUrl: 'https://ollama.com/',
      note: 'Fully local, GPU-accelerated. Best offline quality. Run: ollama serve + ollama pull llama3.2'
    },
    {
      id: 'wasm',
      label: 'WASM',
      offline: true,
      offlineTier: 'cpu',
      color: '#6b4399',
      keyField: undefined,
      modelField: 'wasmModel',
      modelDefault: 'onnx-community/Qwen2.5-0.5B-Instruct',
      features: ['ingest', 'chat'],
      docsUrl: '',
      note: 'Runs in-browser via transformers.js. No GPU needed, works on mobile. Auto-fallback for ingest and chat.'
    },
    {
      id: 'chrome-ai',
      label: 'Chrome AI',
      offline: true,
      offlineTier: 'cpu',
      color: '#facc15',
      keyField: undefined,
      modelField: undefined,
      features: ['ingest', 'chat'],
      docsUrl: 'https://developer.chrome.com/docs/ai/built-in',
      note: 'Gemini Nano inside Chrome. Requires enabling chrome://flags/#prompt-api-for-gemini-nano. Chrome/Edge only.'
    }
  ];

  const FEATURE_LABELS: Record<Feature, string> = {
    ingest: 'ingest',
    analyze: 'analyze',
    chat: 'chat'
  };

  type BackendValue = SettingsRecord['ingestBackend'];

  // Which provider currently handles each feature
  const featureBackend = $derived({
    ingest:  settings().ingestBackend  ?? settings().preferredBackend,
    analyze: settings().analyzeBackend ?? settings().preferredBackend,
    chat:    settings().chatBackend    ?? settings().preferredBackend
  });

  // Preference mode
  let prefMode = $state<'local-first' | 'balanced' | 'cloud-first'>(
    (settings() as any).providerPreference ?? 'balanced'
  );

  // Offline tier
  let offlineTier = $state<'gpu' | 'cpu' | 'none'>(
    (settings() as any).offlineTier ?? 'none'
  );

  async function assignFeature(feature: Feature, providerId: string) {
    const patch: Partial<SettingsRecord> = {};
    if (feature === 'ingest')   patch.ingestBackend  = providerId as BackendValue;
    if (feature === 'analyze')  patch.analyzeBackend = providerId as SettingsRecord['analyzeBackend'];
    if (feature === 'chat')     patch.chatBackend    = providerId as SettingsRecord['chatBackend'];
    await updateSettings(patch);
  }

  async function setPrimaryProvider(providerId: string) {
    // Sets this provider for all its supported features at once
    const p = PROVIDERS.find(p => p.id === providerId);
    if (!p) return;
    const patch: Partial<SettingsRecord> = { preferredBackend: providerId as SettingsRecord['preferredBackend'] };
    if (p.features.includes('ingest'))  patch.ingestBackend  = providerId as BackendValue;
    if (p.features.includes('analyze')) patch.analyzeBackend = providerId as SettingsRecord['analyzeBackend'];
    if (p.features.includes('chat'))    patch.chatBackend    = providerId as SettingsRecord['chatBackend'];
    await updateSettings(patch);
  }

  async function applyLocalFirst() {
    // Sets all features to the best available local backend
    const gpuAvail  = !!settings().ollamaBaseUrl; // assume ollama if configured
    const preferred = offlineTier === 'gpu' ? 'ollama' : offlineTier === 'cpu' ? 'wasm' : null;
    if (!preferred) return;
    await updateSettings({
      ingestBackend:  preferred as BackendValue,
      analyzeBackend: preferred === 'wasm' ? 'ollama' : preferred as SettingsRecord['analyzeBackend'],
      chatBackend:    preferred as SettingsRecord['chatBackend'],
      preferredBackend: preferred as SettingsRecord['preferredBackend']
    });
  }

  function isConfigured(p: ProviderDef): boolean {
    if (!p.keyField) return true; // key-free providers are always "configured"
    const val = settings()[p.keyField];
    return typeof val === 'string' && val.length > 0;
  }

  function getKeyValue(p: ProviderDef): string {
    if (!p.keyField) return '';
    return (settings()[p.keyField] as string | undefined) ?? '';
  }

  function getModelValue(p: ProviderDef): string {
    if (!p.modelField) return '';
    return (settings()[p.modelField] as string | undefined) ?? p.modelDefault ?? '';
  }

  // Also persist firecrawlApiKey through the standard save path
  // (it's handled generically via the provider card saveProvider())
  let keyInputs = $state<Record<string, string>>(
    Object.fromEntries(PROVIDERS.map(p => [p.id, getKeyValue(p)]))
  );
  let modelInputs = $state<Record<string, string>>(
    Object.fromEntries(PROVIDERS.map(p => [p.id, getModelValue(p)]))
  );

  async function saveProvider(p: ProviderDef) {
    const patch: Partial<SettingsRecord> = {};
    if (p.keyField)   patch[p.keyField]   = keyInputs[p.id]?.trim() || undefined as any;
    if (p.modelField) patch[p.modelField] = modelInputs[p.id]?.trim() || p.modelDefault as any;
    await updateSettings(patch);
  }

  // ── Model cache ──────────────────────────────────────────────────────────
  let modelStatuses = $state<CachedModelStatus[]>([]);
  let sideloadingId = $state<string | null>(null);
  let sideloadProgress = $state<SideloadProgress | null>(null);
  let sideloadError = $state<string | null>(null);
  let purging = $state<string | null>(null);
  let wsModelStatuses = $state<WorkspaceModelStatus[]>([]);
  let wsModelSaving = $state<string | null>(null);
  let wsModelRestoring = $state<string | null>(null);
  let wsModelProgress = $state<SideloadProgress | null>(null);
  let wsModelMsg = $state('');

  onMount(() => { refreshModelCache(); refreshWorkspaceModels(); });

  async function refreshModelCache() {
    try { modelStatuses = await inspectModelCache(); } catch { /* Cache API unavailable */ }
  }

  async function handleSideload(manifestId: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    sideloadingId = manifestId;
    sideloadError = null;
    sideloadProgress = null;
    try {
      const count = await sideloadModel(manifestId, files, (p) => { sideloadProgress = p; });
      const manifest = MODEL_MANIFESTS.find(m => m.id === manifestId);
      if (count < (manifest?.files.length ?? 0)) {
        sideloadError = `Loaded ${count} of ${manifest?.files.length} files. Some files were not found in the selected folder.`;
      }
      await refreshModelCache();
    } catch (e) {
      sideloadError = e instanceof Error ? e.message : String(e);
    } finally {
      sideloadingId = null;
      sideloadProgress = null;
    }
  }

  async function handlePurge(manifestId: string) {
    purging = manifestId;
    await purgeModelCache(manifestId);
    await refreshModelCache();
    purging = null;
  }

  async function refreshWorkspaceModels() {
    if (workspaceState() !== 'connected') return;
    try { wsModelStatuses = await inspectWorkspaceModels(); } catch { /* no workspace */ }
  }

  async function handleSaveToWorkspace(manifestId: string) {
    wsModelSaving = manifestId;
    wsModelProgress = null;
    wsModelMsg = '';
    try {
      const count = await saveModelToWorkspace(manifestId, (p) => { wsModelProgress = p; });
      const manifest = MODEL_MANIFESTS.find(m => m.id === manifestId);
      wsModelMsg = `Saved ${count}/${manifest?.files.length ?? '?'} files to workspace.`;
      await refreshWorkspaceModels();
    } catch (e) {
      wsModelMsg = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      wsModelSaving = null;
      wsModelProgress = null;
      setTimeout(() => { wsModelMsg = ''; }, 5000);
    }
  }

  async function handleRestoreFromWorkspace(manifestId: string) {
    wsModelRestoring = manifestId;
    wsModelProgress = null;
    wsModelMsg = '';
    try {
      const count = await restoreModelFromWorkspace(manifestId, (p) => { wsModelProgress = p; });
      const manifest = MODEL_MANIFESTS.find(m => m.id === manifestId);
      wsModelMsg = `Restored ${count}/${manifest?.files.length ?? '?'} files from workspace.`;
      await refreshModelCache();
    } catch (e) {
      wsModelMsg = `Restore failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      wsModelRestoring = null;
      wsModelProgress = null;
      setTimeout(() => { wsModelMsg = ''; }, 5000);
    }
  }

  // ── Indico server ──────────────────────────────────────────────────────────
  let indicoServerUrl = $state(settings().indicoServerUrl ?? '');
  let indicoApiToken = $state(settings().indicoApiToken ?? '');
  let indicoCategoryId = $state(settings().indicoCategoryId ?? '');
  let indicoSaving = $state(false);

  async function saveIndico() {
    indicoSaving = true;
    await updateSettings({
      indicoServerUrl: indicoServerUrl.trim() || undefined,
      indicoApiToken: indicoApiToken.trim() || undefined,
      indicoCategoryId: indicoCategoryId.trim() || undefined,
    });
    indicoSaving = false;
  }

  // ── n8n automation server (F20) ──────────────────────────────────────────────
  let n8nBaseUrl = $state(settings().n8nBaseUrl ?? '');
  let n8nSaving = $state(false);

  async function saveN8n() {
    n8nSaving = true;
    await updateSettings({ n8nBaseUrl: n8nBaseUrl.trim() || undefined });
    n8nSaving = false;
  }
</script>

<header class="head">
  <p class="kicker mono">settings</p>
  <h1>system configuration</h1>
  <div class="settings-nav">
    <a href="/settings" class="nav-link">backends</a>
    <a href="/settings/integrations" class="nav-link active">integrations</a>
    <a href="/settings/turtle" class="nav-link">turtle</a>
    <a href="/settings/entity-types" class="nav-link">entity types</a>
    <a href="/analyze" class="nav-link">analyze history ↗</a>
  </div>
  <nav class="section-toc">
    <a href="#s-mobile">mobile</a>
    <a href="#s-preference">preference</a>
    <a href="#s-models">models</a>
    <a href="#s-features">features</a>
    <a href="#s-indico">indico</a>
    <a href="#s-planned">roadmap</a>
  </nav>
</header>

<!-- Mobile access -->
<section id="s-mobile" class="card">
  <h3>mobile access <span class="badge-local mono">local network</span></h3>
  <p class="sub">Generate a QR code to link a phone or tablet to this graph. The device must be on the same network. The token grants read-write access — treat it like a password.</p>

  <div class="firewall-notice">
    <span class="firewall-icon">⚠</span>
    <div class="firewall-body">
      <strong>Firewall ports must be open</strong>
      <p>Your OS firewall likely blocks inbound LAN connections by default. You need to allow port <code>5173</code> (Vite) and <code>11434</code> (Ollama) from your local network.</p>
      <p class="firewall-warn">Only do this on a <strong>trusted home or personal network</strong>. Do not open these ports on public Wi-Fi, hotel networks, or shared office networks — it exposes your graph to others on the same network.</p>
      <p class="firewall-cmds mono">Ubuntu/Debian: <code>sudo ufw allow 5173/tcp &amp;&amp; sudo ufw allow 11434/tcp</code></p>
      <span class="firewall-link">Full setup guide: <code>docs/MOBILE_LOCAL_SERVER.md</code></span>
    </div>
  </div>

  <QRSharePanel />
</section>

<!-- Preference mode -->
<section id="s-preference" class="card">
  <h3>provider preference</h3>
  <p class="sub">set a global priority. individual feature assignments below can override this.</p>

  <div class="pref-row">
    <div class="pref-group">
      <label class="pref-label mono">compute preference</label>
      <div class="seg">
        {#each ['local-first', 'balanced', 'cloud-first'] as mode}
          <button
            class="seg-btn"
            class:active={prefMode === mode}
            onclick={() => { prefMode = mode as typeof prefMode; updateSettings({ providerPreference: mode } as any); }}
          >{mode}</button>
        {/each}
      </div>
      <p class="hint">
        {#if prefMode === 'local-first'}local providers used whenever available; cloud only as fallback.{/if}
        {#if prefMode === 'balanced'}choose the best available per-feature.{/if}
        {#if prefMode === 'cloud-first'}cloud providers preferred; local only if no key is set.{/if}
      </p>
    </div>

    <div class="pref-group">
      <label class="pref-label mono">offline capability</label>
      <div class="seg">
        {#each [['none','no offline'], ['cpu','cpu / wasm'], ['gpu','gpu / ollama']] as [val, label]}
          <button
            class="seg-btn"
            class:active={offlineTier === val}
            onclick={() => { offlineTier = val as typeof offlineTier; updateSettings({ offlineTier: val } as any); }}
          >{label}</button>
        {/each}
      </div>
      <p class="hint">
        {#if offlineTier === 'none'}no local inference — cloud backends required.{/if}
        {#if offlineTier === 'cpu'}WASM in-browser inference. works on any device, limited to small models.{/if}
        {#if offlineTier === 'gpu'}Ollama on a GPU machine (local server or attached GPU). full-size models available.{/if}
      </p>
    </div>
  </div>

  {#if prefMode === 'local-first' || offlineTier !== 'none'}
    <button class="btn-apply" onclick={applyLocalFirst}>
      Apply local-first to all features
    </button>
  {/if}
</section>

<!-- Model cache & sideload -->
<section id="s-models" class="card">
  <h3>local model cache</h3>
  <p class="sub">Models are cached in the browser after first download. Sideload from disk for fully offline setup.</p>

  {#if modelStatuses.length === 0}
    <p class="hint">Checking cache...</p>
  {:else}
    <div class="model-grid">
      {#each modelStatuses as ms (ms.manifest.id)}
        {@const m = ms.manifest}
        {@const wsMs = wsModelStatuses.find(w => w.manifestId === m.id)}
        <div class="model-row" class:model-complete={ms.complete}>
          <div class="model-info">
            <div class="model-head">
              <strong>{m.label}</strong>
              {#if ms.complete}
                <span class="badge-ok mono">cached</span>
              {:else if ms.cachedCount > 0}
                <span class="badge-partial mono">{ms.cachedCount}/{ms.totalCount} files</span>
              {:else}
                <span class="badge-missing mono">not cached</span>
              {/if}
              {#if wsMs?.complete}
                <span class="badge-ws mono">in folder</span>
              {:else if wsMs && wsMs.folderCount > 0}
                <span class="badge-ws-partial mono">folder: {wsMs.folderCount}/{wsMs.totalCount}</span>
              {/if}
            </div>
            <p class="model-desc">{m.description}</p>
            {#if ms.cachedBytes > 0}
              <span class="model-size mono">{formatBytes(ms.cachedBytes)} cached</span>
            {/if}
          </div>
          <div class="model-actions">
            {#if sideloadingId === m.id || wsModelSaving === m.id || wsModelRestoring === m.id}
              <span class="sideload-progress mono">
                {#if wsModelProgress}
                  {wsModelSaving === m.id ? 'saving' : wsModelRestoring === m.id ? 'restoring' : 'loading'} {wsModelProgress.index + 1}/{wsModelProgress.total}...
                {:else if sideloadProgress}
                  loading {sideloadProgress.index + 1}/{sideloadProgress.total}...
                {:else}
                  reading files...
                {/if}
              </span>
            {:else}
              {#if workspaceState() === 'connected'}
                {#if ms.complete && !wsMs?.complete}
                  <button class="btn-sideload" onclick={() => handleSaveToWorkspace(m.id)}>
                    save to folder
                  </button>
                {/if}
                {#if !ms.complete && wsMs?.complete}
                  <button class="btn-sideload" onclick={() => handleRestoreFromWorkspace(m.id)}>
                    restore from folder
                  </button>
                {/if}
              {/if}
              <label class="btn-sideload">
                <input
                  type="file"
                  multiple
                  accept=".onnx,.json,.bin,.txt"
                  style="display:none"
                  onchange={(e) => handleSideload(m.id, (e.target as HTMLInputElement).files)}
                />
                sideload files
              </label>
              <label class="btn-sideload">
                <input
                  type="file"
                  webkitdirectory
                  style="display:none"
                  onchange={(e) => handleSideload(m.id, (e.target as HTMLInputElement).files)}
                />
                sideload folder
              </label>
            {/if}
            {#if ms.cachedCount > 0}
              <button class="btn-purge" onclick={() => handlePurge(m.id)} disabled={purging === m.id}>
                {purging === m.id ? 'purging...' : 'purge'}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if sideloadError}
      <p class="sideload-error">{sideloadError}</p>
    {/if}
    {#if wsModelMsg}
      <p class="hint" style="color:var(--accent);margin-top:0.5rem">{wsModelMsg}</p>
    {/if}

    <div class="model-help">
      <p class="hint">
        To sideload: download model files from
        <a href="https://huggingface.co" target="_blank" rel="noopener">huggingface.co</a>
        on a connected device, transfer to this device, then use "sideload folder" to load the entire repo directory.
        Individual ONNX + JSON files also work via "sideload files".
        {#if workspaceState() === 'connected'}
          Models saved to your workspace folder persist across browser cache clears.
        {/if}
      </p>
      <button class="btn-refresh" onclick={() => { refreshModelCache(); refreshWorkspaceModels(); }}>refresh cache status</button>
    </div>
  {/if}
</section>

<!-- Feature assignment overview -->
<section id="s-features" class="card">
  <h3>current feature assignments</h3>
  <p class="sub">click a feature pill to reassign it. changes take effect immediately.</p>

  <div class="assignment-grid">
    {#each (['ingest', 'analyze', 'chat'] as Feature[]) as feat}
      {@const current = featureBackend[feat]}
      {@const currentProvider = PROVIDERS.find(p => p.id === current)}
      <div class="assignment-row">
        <span class="feat-name mono">{feat}</span>
        <div class="feat-pills">
          {#each PROVIDERS.filter(p => p.features.includes(feat)) as p}
            <button
              class="feat-pill"
              class:active={current === p.id}
              class:configured={isConfigured(p)}
              style="--pc: {p.color}"
              onclick={() => assignFeature(feat, p.id)}
            >
              {p.label}
              {#if p.offline}<span class="local-dot" title="local/offline">●</span>{/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</section>

<!-- Provider cards -->
<p class="section-label mono">configure providers</p>

{#each PROVIDERS as p}
  {@const configured = isConfigured(p)}
  {@const isCurrent = featureBackend.ingest === p.id || featureBackend.analyze === p.id || featureBackend.chat === p.id}
  <section class="card provider-card" class:active-provider={isCurrent}>
    <div class="provider-header">
      <div class="provider-title">
        <span class="provider-dot" style="background: {p.color}"></span>
        <strong>{p.label}</strong>
        {#if p.offline}
          <span class="badge-local mono">local · {p.offlineTier === 'gpu' ? 'GPU' : 'CPU'}</span>
        {:else}
          <span class="badge-cloud mono">cloud</span>
        {/if}
        {#if configured}
          <span class="badge-ok mono">✓ configured</span>
        {/if}
      </div>

      {#if p.features.length > 0}
        <button class="btn-set-primary" onclick={() => setPrimaryProvider(p.id)}>
          set as primary
        </button>
      {/if}
    </div>

    <p class="provider-note">{p.note}</p>

    {#if p.features.length > 0}
      <div class="feature-tags">
        <span class="feat-tag-label mono">used for:</span>
        {#each (['ingest', 'analyze', 'chat'] as Feature[]) as feat}
          <span
            class="feat-tag"
            class:feat-active={featureBackend[feat] === p.id}
            class:feat-available={p.features.includes(feat)}
          >
            {feat}
          </span>
        {/each}
      </div>
    {/if}

    <div class="provider-fields">
      {#if p.keyField}
        <label class="field">
          <span class="lbl mono">api key</span>
          <div class="field-row">
            <input
              type="password"
              bind:value={keyInputs[p.id]}
              placeholder={p.keyPlaceholder}
              onblur={() => saveProvider(p)}
            />
            {#if p.docsUrl}
              <a href={p.docsUrl} target="_blank" rel="noopener" class="get-key-link mono">get key ↗</a>
            {/if}
          </div>
        </label>
      {/if}

      {#if p.id === 'ollama'}
        <label class="field">
          <span class="lbl mono">base url</span>
          <input
            type="text"
            value={settings().ollamaBaseUrl ?? 'http://localhost:11434'}
            onblur={(e) => updateSettings({ ollamaBaseUrl: (e.target as HTMLInputElement).value.trim() })}
          />
        </label>
      {/if}

      {#if p.modelField}
        <label class="field">
          <span class="lbl mono">model</span>
          <input
            type="text"
            bind:value={modelInputs[p.id]}
            placeholder={p.modelDefault}
            onblur={() => saveProvider(p)}
          />
        </label>
      {/if}

      {#if p.features.length > 0}
        <div class="assign-row">
          <span class="lbl mono">assign to</span>
          <div class="assign-pills">
            {#each (['ingest', 'analyze', 'chat'] as Feature[]) as feat}
              {#if p.features.includes(feat)}
                <button
                  class="assign-pill"
                  class:assigned={featureBackend[feat] === p.id}
                  onclick={() => assignFeature(feat, p.id)}
                >{feat}</button>
              {:else}
                <span class="assign-pill unavail">{feat}</span>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>
{/each}

<!-- Indico Calendar Server -->
<section id="s-indico" class="card">
  <h3>Indico Server <span class="badge-local mono">calendar</span></h3>
  <p class="sub">Connect an Indico server to import community events. Events appear in the ingest calendar tab.</p>

  <div class="indico-fields">
    <label class="field-row">
      <span class="field-label mono">server url</span>
      <input
        type="url"
        class="field-input"
        placeholder="https://indico.example.com"
        bind:value={indicoServerUrl}
      />
    </label>
    <label class="field-row">
      <span class="field-label mono">api token</span>
      <input
        type="password"
        class="field-input"
        placeholder="optional — for protected events"
        bind:value={indicoApiToken}
      />
    </label>
    <label class="field-row">
      <span class="field-label mono">category id</span>
      <input
        type="text"
        class="field-input"
        placeholder="optional — filter by category"
        bind:value={indicoCategoryId}
      />
    </label>
    <button class="save-indico-btn" onclick={saveIndico} disabled={indicoSaving}>
      {indicoSaving ? 'saving...' : 'save'}
    </button>
  </div>
</section>

<section id="s-n8n" class="card">
  <h3>n8n automation <span class="badge-local mono">self-host</span></h3>
  <p class="sub">Point at your self-hosted n8n instance to route web integrations — graph sync, currents, and the contact form — through your own automation workflows. Open-source, no SaaS.</p>

  <div class="indico-fields">
    <label class="field-row">
      <span class="field-label mono">base url</span>
      <input
        type="url"
        class="field-input"
        placeholder="https://n8n.example.com"
        bind:value={n8nBaseUrl}
      />
    </label>
    <p class="sub" style="margin: 0.2rem 0 0; font-size: 0.72rem;">
      The contact form posts to <code>/webhook/reckons-contact</code> on this instance.
    </p>
    <button class="save-indico-btn" onclick={saveN8n} disabled={n8nSaving}>
      {n8nSaving ? 'saving...' : 'save'}
    </button>
  </div>
</section>

<!-- Roadmap integrations -->
<section id="s-planned" class="card roadmap-card">
  <h3>planned integrations <span class="badge-planned mono">roadmap</span></h3>
  <p class="sub">features in development — track progress or contribute on GitHub.</p>

  <div class="roadmap-list">
    {#each [
      { label: 'MCP server', desc: 'Expose the graph as tools to Claude, Cursor, Windsurf, and any MCP-compatible agent.', score: '25/25' },
      { label: 'Firecrawl', desc: 'JS-rendered web scraping + full-site crawls. Each page becomes a sourced fact batch.', score: '20/25' },
      { label: 'Markdown / Obsidian ingest', desc: 'Drop .md files or vault folders → auto-extract facts with wikilink structure preserved.', score: '25/25' },
      { label: 'Git version backbone', desc: 'Commit .ttl snapshots to a local git repo. GitHub remote + Actions for automated analysis.', score: '16/25' },
      { label: 'Deepgram audio ingest', desc: 'Upload audio/video → transcribe → extract facts. Speaker diarization = multi-source provenance.', score: '15/25' },
      { label: 'LlamaParse', desc: 'DOCX, PPTX, complex PDF parsing as an alternative to Mistral OCR.', score: '14/25' },
      { label: 'Hume.AI voice (complete)', desc: 'Finish the voice integration scaffolded in settings. Voice → facts with speaker provenance.', score: '15/25' },
      { label: 'Tavily search + extract', desc: 'Research a topic: Tavily retrieves N pages, each becomes its own sourced fact batch.', score: '12/25' },
    ] as item}
      <div class="rm-row">
        <div class="rm-title">
          <strong>{item.label}</strong>
          <span class="rm-score mono">{item.score}</span>
        </div>
        <p>{item.desc}</p>
      </div>
    {/each}
  </div>
</section>

<!-- ── Support footer ───────────────────────────────────────────────────── -->
<footer class="settings-support-footer">
  <a href="https://www.paypal.com/ncp/payment/KH5J484QMVFS2" target="_blank" rel="noopener noreferrer" class="support-link mono">☕ buy me a coffee</a>
  <p class="mono support-sub">Reckons.AI is free, open source, and self-funded.</p>
</footer>

<style>
  .head { margin-bottom: 2rem; }
  .kicker { font-size: 0.7rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 0.25rem; font-family: var(--font-mono); }
  h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); margin: 0 0 1rem; }

  .settings-nav {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--line);
    padding-bottom: 0.5rem;
  }
  .nav-link {
    font-size: 0.82rem;
    font-family: var(--font-mono);
    color: var(--muted);
    text-decoration: none;
    padding: 0.3rem 0.7rem;
    border-radius: var(--rad-sm);
    transition: color 0.15s, background 0.15s;
  }
  .nav-link:hover { color: var(--ink); background: var(--surface-2); }
  .nav-link.active { color: var(--accent); background: var(--accent-soft); }

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

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.4rem;
    margin-bottom: 1rem;
  }

  h3 {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    margin: 0 0 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sub { font-size: 0.82rem; color: var(--muted); margin: 0 0 1rem; line-height: 1.5; }

  /* ── Firewall notice ── */
  .firewall-notice {
    display: flex;
    gap: 0.7rem;
    background: color-mix(in srgb, var(--warn, #f59e0b) 8%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--warn, #f59e0b) 40%, var(--line));
    border-radius: var(--rad);
    padding: 0.85rem 1rem;
    margin-bottom: 1rem;
  }
  .firewall-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
    color: #f59e0b;
    line-height: 1.3;
  }
  .firewall-body {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .firewall-body strong { font-size: 0.85rem; color: var(--ink); }
  .firewall-body p { font-size: 0.78rem; color: var(--ink-2); margin: 0; line-height: 1.5; }
  .firewall-warn { color: var(--ink) !important; }
  .firewall-cmds { font-size: 0.72rem !important; color: var(--muted) !important; }
  .firewall-cmds code {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--data);
  }
  .firewall-link {
    font-size: 0.75rem;
    color: var(--accent);
    text-decoration: none;
  }
  .firewall-link:hover { text-decoration: underline; }
  .hint { font-size: 0.78rem; color: var(--muted); margin: 0.4rem 0 0; line-height: 1.4; }

  /* Preference seg controls */
  .pref-row { display: flex; gap: 1.5rem; flex-wrap: wrap; }
  .pref-group { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 0.4rem; }
  .pref-label { font-size: 0.72rem; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }

  .seg { display: flex; border: 1px solid var(--line); border-radius: var(--rad-sm); overflow: hidden; }
  .seg-btn {
    flex: 1;
    padding: 0.4rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    background: var(--surface-2);
    color: var(--muted);
    border: none;
    cursor: pointer;
    border-right: 1px solid var(--line);
    transition: background 0.15s, color 0.15s;
  }
  .seg-btn:last-child { border-right: none; }
  .seg-btn.active { background: var(--accent-soft); color: var(--accent); }
  .seg-btn:hover:not(.active) { background: var(--surface-3); color: var(--ink-2); }

  .btn-apply {
    margin-top: 1rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    padding: 0.4rem 0.9rem;
    cursor: pointer;
  }
  .btn-apply:hover { background: var(--accent); color: #fff; }

  /* Assignment grid */
  .assignment-grid { display: flex; flex-direction: column; gap: 0.75rem; }
  .assignment-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .feat-name { font-size: 0.78rem; color: var(--muted); min-width: 60px; }
  .feat-pills { display: flex; gap: 0.4rem; flex-wrap: wrap; }

  .feat-pill {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    opacity: 0.6;
  }
  .feat-pill.configured { opacity: 1; }
  .feat-pill.active {
    background: color-mix(in srgb, var(--pc) 20%, transparent);
    color: var(--pc);
    border-color: var(--pc);
    opacity: 1;
  }
  .feat-pill:hover:not(.active) { background: var(--surface-3); opacity: 1; }
  .local-dot { font-size: 0.5rem; color: var(--ok); }

  /* Provider cards */
  .section-label { font-size: 0.7rem; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin: 1.5rem 0 0.5rem; display: block; }

  .provider-card { transition: border-color 0.2s; }
  .provider-card.active-provider { border-color: var(--accent); }

  .provider-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .provider-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .provider-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .provider-title strong { font-size: 0.95rem; color: var(--ink); }

  .badge-local, .badge-cloud, .badge-ok, .badge-planned {
    font-size: 0.65rem;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
  }
  .badge-local { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent); }
  .badge-cloud { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
  .badge-ok    { background: #6ab68a22; color: var(--ok); border: 1px solid var(--ok); }
  .badge-planned { background: var(--data-soft); color: var(--data); border: 1px solid var(--data); }

  .btn-set-primary {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.3rem 0.65rem;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .btn-set-primary:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

  .provider-note { font-size: 0.8rem; color: var(--muted); margin: 0 0 0.8rem; line-height: 1.4; }

  .feature-tags {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
  }
  .feat-tag-label { font-size: 0.68rem; color: var(--muted-2); }
  .feat-tag {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted-2);
    background: var(--surface-2);
  }
  .feat-tag.feat-active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
  .feat-tag.feat-available:not(.feat-active) { color: var(--muted); border-color: var(--line); }

  .provider-fields { display: flex; flex-direction: column; gap: 0.6rem; }

  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .field-row { display: flex; gap: 0.5rem; align-items: center; }
  .lbl { font-size: 0.72rem; color: var(--muted); letter-spacing: 0.06em; }

  input[type="password"],
  input[type="text"] {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    padding: 0.45rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    flex: 1;
    min-width: 0;
  }
  input:focus { outline: none; border-color: var(--accent); }

  .get-key-link {
    font-size: 0.72rem;
    color: var(--accent);
    text-decoration: none;
    white-space: nowrap;
  }
  .get-key-link:hover { text-decoration: underline; }

  .assign-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .assign-pills { display: flex; gap: 0.35rem; }
  .assign-pill {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s;
  }
  .assign-pill.assigned { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
  .assign-pill.unavail { opacity: 0.3; cursor: default; }
  .assign-pill:not(.unavail):not(.assigned):hover { background: var(--surface-3); color: var(--ink-2); }

  /* Indico */
  .indico-fields { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.75rem; }
  .indico-fields .field-row { display: flex; flex-direction: column; gap: 0.3rem; }
  .field-label { font-size: 0.7rem; color: var(--muted); letter-spacing: 0.08em; }
  .field-input {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    padding: 0.45rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    width: 100%;
    box-sizing: border-box;
  }
  .field-input:focus { outline: none; border-color: var(--accent); }
  .save-indico-btn {
    align-self: flex-start;
    padding: 0.4rem 1rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    color: var(--accent);
    cursor: pointer;
    margin-top: 0.25rem;
  }
  .save-indico-btn:hover:not(:disabled) { background: var(--accent); color: #fff; }
  .save-indico-btn:disabled { opacity: 0.5; cursor: wait; }

  /* Roadmap */
  .roadmap-card h3 { text-transform: none; }
  .roadmap-list { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--line); border-radius: var(--rad-sm); overflow: hidden; margin-top: 1rem; }
  .rm-row { padding: 0.9rem 1rem; border-bottom: 1px solid var(--line); background: var(--surface-2); }
  .rm-row:last-child { border-bottom: none; }
  .rm-row:hover { background: var(--surface-3); }
  .rm-title { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 0.25rem; }
  .rm-title strong { font-size: 0.88rem; color: var(--ink-2); }
  .rm-score { font-size: 0.65rem; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent); padding: 0.1rem 0.4rem; border-radius: 999px; }
  .rm-row p { font-size: 0.78rem; color: var(--muted); margin: 0; line-height: 1.4; }

  /* ── Model cache ── */
  .model-grid { display: flex; flex-direction: column; gap: 0.5rem; }
  .model-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    padding: 0.85rem 1rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .model-row.model-complete { border-color: color-mix(in srgb, var(--data) 40%, var(--line)); }
  .model-info { flex: 1; min-width: 0; }
  .model-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .model-head strong { font-size: 0.88rem; }
  .model-desc { font-size: 0.78rem; color: var(--muted); margin: 0.2rem 0 0; }
  .model-size { font-size: 0.68rem; color: var(--data); }
  .model-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: center;
  }
  .btn-sideload {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    padding: 0.3rem 0.6rem;
    border-radius: var(--rad-sm);
    background: var(--surface-3);
    border: 1px solid var(--line);
    color: var(--ink-2);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .btn-sideload:hover { background: var(--accent-soft); color: var(--accent); }
  .btn-purge {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    padding: 0.3rem 0.6rem;
    border-radius: var(--rad-sm);
    background: transparent;
    border: 1px solid var(--line);
    color: var(--muted);
    cursor: pointer;
  }
  .btn-purge:hover { color: var(--danger, #ef4444); border-color: var(--danger, #ef4444); }
  .badge-partial { font-size: 0.62rem; color: var(--warn, #f59e0b); background: color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn, #f59e0b) 30%, var(--line)); padding: 0.1rem 0.4rem; border-radius: 999px; }
  .badge-missing { font-size: 0.62rem; color: var(--muted); background: var(--surface-3); border: 1px solid var(--line); padding: 0.1rem 0.4rem; border-radius: 999px; }
  .badge-ws { font-size: 0.62rem; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); padding: 0.1rem 0.4rem; border-radius: 999px; }
  .badge-ws-partial { font-size: 0.62rem; color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid var(--line); padding: 0.1rem 0.4rem; border-radius: 999px; }
  .sideload-progress { font-size: 0.7rem; color: var(--accent); }
  .sideload-error { font-size: 0.78rem; color: var(--danger, #ef4444); margin-top: 0.5rem; }
  .model-help { margin-top: 0.75rem; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.75rem; }
  .model-help .hint { flex: 1; min-width: 200px; }
  .model-help a { color: var(--accent); }
  .btn-refresh {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    padding: 0.25rem 0.55rem;
    border-radius: var(--rad-sm);
    background: var(--surface-3);
    border: 1px solid var(--line);
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-refresh:hover { color: var(--accent); }

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
