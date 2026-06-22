<script lang="ts">
  import '$lib/styles/global.css';
  import { onMount } from 'svelte';

  import NavBar from '$lib/components/NavBar.svelte';
  import TurtleChatPanel from '$lib/components/TurtleChatPanel.svelte';
  import ManualLLMModal from '$lib/components/ManualLLMModal.svelte';
  import { loadAll, loaded } from '$lib/stores/kb.svelte';
  import { loadSettings, settingsLoaded } from '$lib/stores/settings.svelte';
  import { loadTurtleSettings } from '$lib/stores/turtle-settings.svelte';
  import { startScheduler } from '$lib/stores/auto-analyze.svelte';
  import { initExtensionBridge } from '$lib/extension-bridge';
  import { shellyChatOpen, setShellyChatOpen, shellyOpenMessage, clearShellyOpen, exploreOpen, stopExplore, activeStoryId, stopStory } from '$lib/stores/shelly-bridge.svelte';
  import { officialKbActive, deactivateOfficialKb } from '$lib/stores/official-kb.svelte';
  import { warmWasm } from '$lib/stores/wasm-status.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { loadGlbOverrides } from '$lib/stores/glb-overrides.svelte';
  import { loadGifOverrides } from '$lib/stores/gif-overrides.svelte';
  import { loadIcon2dOverrides } from '$lib/stores/icon2d-overrides.svelte';
  import { loadWorkspace, drainWorkspacePending, workspaceState, supportsWorkspace } from '$lib/stores/workspace.svelte';
  import { pushNotification } from '$lib/stores/notifications.svelte';
  import { addStatements, addSource, confirmedStatements } from '$lib/stores/kb.svelte';
  import { updateSettings } from '$lib/stores/settings.svelte';
  import { getCurrentKbId, registerStableId, getRegistry, createKb } from '$lib/storage/kb-registry';
  import { getOrCreateStableId } from '$lib/storage/kb-fingerprint';
  import { Tooltip } from 'bits-ui';
  import NotificationStack from '$lib/components/NotificationStack.svelte';
  import DownloadConsentDialog from '$lib/components/DownloadConsentDialog.svelte';
  import { initDownloadConsent } from '$lib/stores/download-consent.svelte';

  let { children } = $props();
  let error = $state<string | null>(null);
  let forceShow = $state(false);

  // Apply UI scale as root font-size whenever it changes
  const UI_SCALE_PX: Record<string, string> = { sm: '14px', md: '16px', lg: '18px' };
  $effect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.style.fontSize = UI_SCALE_PX[settings().uiScale ?? 'md'];
    }
  });

  onMount(async () => {
    // Register download consent handlers before any model loading can occur
    initDownloadConsent();

    // Load in background; show UI immediately for testing
    Promise.all([loadAll(), loadSettings(), loadTurtleSettings(), loadGlbOverrides(), loadGifOverrides(), loadIcon2dOverrides()]).then(async () => {
      startScheduler();
      initExtensionBridge();
      // Auto-warm WASM model if it's the configured backend
      const s = settings();
      if (s.chatBackend === 'wasm' || (!s.chatBackend && s.preferredBackend === 'wasm')) {
        warmWasm(s.wasmModel || undefined);
      }
      // Kokoro TTS: only warm up eagerly if model is already cached (instant).
      // First-time download (~87MB) is deferred until TTS is actually needed.
      // Register current KB in the registry with its stable ID (for KB Leap navigation)
      {
        const dbName = getCurrentKbId();
        const s = settings();
        const stableId = await getOrCreateStableId(
          s.kbStableId,
          (newId) => updateSettings({ kbStableId: newId })
        );
        // Ensure the KB entry exists in the registry
        const reg = getRegistry();
        if (!reg.find(k => k.id === dbName)) {
          createKb(s.kbTitle || 'My KB');
        }
        registerStableId(dbName, stableId, confirmedStatements().length);
      }

      // Reconnect workspace and drain any pending triples written by the MCP server
      await loadWorkspace();
      const pending = await drainWorkspacePending();
      if (pending.length > 0) {
        const { v4: nanoid } = await import('uuid');
        const sourceId = `mcp-pending-${Date.now()}`;
        const now = Date.now();
        await addSource({
          id: sourceId,
          title: `MCP — ${pending.length} queued note${pending.length > 1 ? 's' : ''}`,
          uri: `urn:mcp:pending:${sourceId}`,
          kind: 'analysis',
          trustLevel: 'review',
          ingestedAt: now,
        });
        const sts = pending.map(e => ({
          id: nanoid(),
          sourceId,
          status: 'pending' as const,
          confidence: 0.7,
          s: { kind: 'iri' as const, value: e.subject },
          p: { kind: 'iri' as const, value: e.predicate },
          o: { kind: 'literal' as const, value: e.object },
          g: { kind: 'iri' as const, value: `urn:mcp:pending:${sourceId}` },
          createdAt: e.addedAt ? new Date(e.addedAt).getTime() : now,
          updatedAt: now,
        }));
        await addStatements(sts, sourceId);
      }
      // Nudge: suggest linking a local folder once the user has some data
      if (supportsWorkspace() && workspaceState() === 'none' && confirmedStatements().length >= 10) {
        pushNotification({
          id: 'setup-local-folder',
          type: 'info',
          title: 'Protect your knowledge base',
          body: 'Link a local folder so your KBs are backed up to disk and survive browser cache clears.',
          action: { label: 'Set up folder', href: '/kb#local-folder-sync' },
          oneTime: true,
        });
      }

      // Handle ?indico= query param — save to settings on any page
      const indicoParam = new URL(window.location.href).searchParams.get('indico');
      if (indicoParam?.trim()) {
        await updateSettings({ indicoServerUrl: indicoParam.trim() });
      }

      // Auto-refresh sources on KB open (if enabled)
      {
        const { refreshOnOpen, startAutoRefreshScheduler } = await import('$lib/stores/source-refresh');
        refreshOnOpen().then(results => {
          const refreshed = results.filter(r => r.status === 'refreshed');
          if (refreshed.length > 0) {
            pushNotification({
              id: 'auto-refresh',
              type: 'info',
              title: `Refreshed ${refreshed.length} source${refreshed.length > 1 ? 's' : ''}`,
              body: refreshed.map(r => r.title).join(', '),
              action: { label: 'Review', href: '/review' },
            });
          }
        }).catch(e => console.warn('[auto-refresh] Failed:', e));
        startAutoRefreshScheduler();
      }
    }).catch(e => {
      error = e instanceof Error ? e.message : String(e);
      console.error('Store initialization error:', e);
    });
    // Force show after very short delay to allow perception of loading
    setTimeout(() => { forceShow = true; }, 100);
  });
</script>

<Tooltip.Provider delayDuration={300}>

<a href="#main-content" class="skip-link">Skip to content</a>

<div class="bg"></div>

<main id="main-content" role="main">
  {#if loaded() && settingsLoaded() || forceShow}
    {@render children()}
    {#if error}
      <div style="position: fixed; bottom: 1rem; left: 1rem; right: 1rem; background: var(--surface); border: 1px solid var(--danger); padding: 1rem; border-radius: var(--rad); font-size: 0.75rem; color: var(--danger);">
        Store error: {error}
      </div>
    {/if}
  {:else}
    <div class="boot">
      <img src="/svg/logo-text.svg" alt="Reckons.AI" class="boot-logo" />
      <span class="mono">loading…</span>
      {#if error}
        <p class="mono" style="color: var(--danger); margin-top: 1rem; font-size: 0.75rem;">{error}</p>
      {/if}
    </div>
  {/if}
</main>

{#if officialKbActive()}
  <div class="official-kb-banner">
    <span class="official-kb-label">Viewing: <strong>Official Docs KB</strong> (read-only)</span>
    <button class="official-kb-back" onclick={() => deactivateOfficialKb()}>back to my KB</button>
  </div>
{/if}

<NavBar />

<ManualLLMModal />
<NotificationStack />
<DownloadConsentDialog />

{#if shellyChatOpen()}
  <TurtleChatPanel
    initialMessage={shellyOpenMessage()}
    exploreMode={exploreOpen()}
    storyId={activeStoryId()}
    onclose={() => { setShellyChatOpen(false); stopExplore(); stopStory(); clearShellyOpen(); }}
  />
{/if}

</Tooltip.Provider>

<style>
  .bg {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: var(--bg);
    overflow: hidden;
  }

  /* ── Soft rolling wave layers ──────────────────────────────────── */
  .bg::before,
  .bg::after {
    content: '';
    position: absolute;
    inset: -50%;
    width: 200%;
    height: 200%;
    pointer-events: none;
  }

  .bg::before {
    background:
      radial-gradient(ellipse 60% 40% at 20% 50%, rgba(26, 155, 142, 0.07) 0%, transparent 70%),
      radial-gradient(ellipse 50% 60% at 80% 30%, rgba(107, 67, 153, 0.05) 0%, transparent 70%),
      radial-gradient(ellipse 70% 35% at 50% 80%, rgba(26, 155, 142, 0.04) 0%, transparent 60%);
    animation: wave-drift 28s ease-in-out infinite alternate;
  }

  .bg::after {
    background:
      radial-gradient(ellipse 55% 45% at 70% 60%, rgba(26, 155, 142, 0.06) 0%, transparent 65%),
      radial-gradient(ellipse 45% 55% at 30% 40%, rgba(107, 67, 153, 0.04) 0%, transparent 65%),
      radial-gradient(ellipse 65% 30% at 60% 20%, rgba(26, 155, 142, 0.03) 0%, transparent 55%);
    animation: wave-drift-alt 34s ease-in-out infinite alternate;
  }

  @keyframes wave-drift {
    0%   { transform: translate(0%, 0%)     rotate(0deg)   scale(1); }
    25%  { transform: translate(3%, -2%)    rotate(0.5deg) scale(1.02); }
    50%  { transform: translate(-2%, 3%)    rotate(-0.3deg) scale(0.98); }
    75%  { transform: translate(1%, -1%)    rotate(0.2deg) scale(1.01); }
    100% { transform: translate(-3%, 2%)    rotate(-0.5deg) scale(1); }
  }

  @keyframes wave-drift-alt {
    0%   { transform: translate(0%, 0%)     rotate(0deg)    scale(1); }
    33%  { transform: translate(-4%, 2%)    rotate(-0.4deg) scale(1.03); }
    66%  { transform: translate(2%, -3%)    rotate(0.3deg)  scale(0.97); }
    100% { transform: translate(-1%, 1%)    rotate(-0.2deg) scale(1.01); }
  }

  /* Reduce motion for accessibility + save battery on mobile */
  @media (prefers-reduced-motion: reduce) {
    .bg::before, .bg::after { animation: none; }
  }
  main {
    position: relative;
    max-width: 720px;
    margin: 0 auto;
    padding: 2rem 1.1rem max(7rem, calc(5.5rem + env(safe-area-inset-bottom)));
    min-height: 100dvh;
  }
  @media (max-width: 500px) {
    main {
      padding: 1rem 0.6rem max(6rem, calc(4.5rem + env(safe-area-inset-bottom)));
    }
  }
  .boot {
    padding-top: 30vh;
    text-align: center;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }
  .boot-logo {
    width: clamp(180px, 50vw, 320px);
    height: auto;
  }
  .official-kb-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 450;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 0.4rem 1rem;
    background: rgba(26, 155, 142, 0.12);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--accent);
    font-size: 0.75rem;
    color: var(--accent);
  }
  .official-kb-label {
    font-family: var(--font-mono);
  }
  .official-kb-back {
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    cursor: pointer;
    transition: background 0.12s;
  }
  .official-kb-back:hover {
    background: var(--accent);
    color: #fff;
  }
</style>
