<script lang="ts">
  /**
   * ExplorePanel — Shelly-guided interactive tour of the knowledge graph.
   *
   * On mount, sends "START_TOUR" to the explore-mode LLM prompt and Shelly
   * begins a structured multi-stop tour, navigating the graph via adjust_view
   * actions and asking questions at each stop. The user can reply or ask
   * their own questions at any point.
   */
  import { onMount } from 'svelte';
  import { confirmedStatements, statements, sources } from '$lib/stores/kb.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { typeMap } from '$lib/stores/entity-types.svelte';
  import { RDF_TYPE } from '$lib/rdf/entity-types';
  import { applyShellyViewAdjust } from '$lib/stores/shelly-bridge.svelte';
  import { turtleChat, type TurtleChatProvider } from '$lib/integrations/llm/turtle-chat';
  import type { KBAction, KBContext } from '$lib/types/turtle-chat';
  import type { Statement } from '$lib/rdf/types';

  let { onclose } = $props<{ onclose: () => void }>();

  type Msg = { role: 'shelly' | 'user'; content: string; actions?: KBAction[] };

  let messages = $state<Msg[]>([]);
  let input = $state('');
  let loading = $state(false);
  let errorMsg = $state('');
  let listEl: HTMLDivElement | undefined;

  $effect(() => {
    if (messages.length && listEl) {
      setTimeout(() => listEl!.scrollTo({ top: listEl!.scrollHeight, behavior: 'smooth' }), 30);
    }
  });

  // ── KB context (adapted from TurtleChatPanel) ─────────────────────────────

  function buildKBContext(): KBContext {
    const stmts = confirmedStatements();
    const allStmts = statements();
    const tm = typeMap();

    const bySubject = new Map<string, Statement[]>();
    const typedIris = new Set<string>();
    const typeDefIris = new Set<string>();
    const objectOnlyIris = new Set<string>();

    for (const st of stmts) {
      if (st.s.kind === 'iri') {
        if (!bySubject.has(st.s.value)) bySubject.set(st.s.value, []);
        bySubject.get(st.s.value)!.push(st);
        if (st.p.value === RDF_TYPE) typedIris.add(st.s.value);
      }
      if (st.o.kind === 'iri') {
        if (st.p.value === RDF_TYPE) typeDefIris.add(st.o.value);
        else if (!bySubject.has(st.o.value)) objectOnlyIris.add(st.o.value);
      }
    }
    for (const iri of typeDefIris) objectOnlyIris.delete(iri);
    for (const iri of bySubject.keys()) objectOnlyIris.delete(iri);

    const untypedEntityCount =
      [...bySubject.keys()].filter(iri => !typedIris.has(iri)).length + objectOnlyIris.size;
    const manualStatementCount = allStmts.filter(s =>
      (s.status === 'confirmed' || s.status === 'refined') && s.sourceId === 'manual'
    ).length;

    const typesPresent = new Set<string>();
    const sampleEntities: KBContext['sampleEntities'] = [];

    // Compute degree (edge count) per entity to surface hubs at the top
    const degrees = new Map<string, number>();
    for (const st of stmts) {
      if (st.s.kind === 'iri') degrees.set(st.s.value, (degrees.get(st.s.value) ?? 0) + 1);
      if (st.o.kind === 'iri') degrees.set(st.o.value, (degrees.get(st.o.value) ?? 0) + 1);
    }

    // Sort: hubs first (high degree), then untyped, then by statement count
    const sorted = [...bySubject.entries()]
      .sort(([iriA, a], [iriB, b]) => {
        const degA = degrees.get(iriA) ?? 0;
        const degB = degrees.get(iriB) ?? 0;
        if (degB !== degA) return degB - degA;
        const aUntyped = !typedIris.has(iriA) ? -1 : 0;
        const bUntyped = !typedIris.has(iriB) ? -1 : 0;
        return aUntyped - bUntyped || b.length - a.length;
      })
      .slice(0, 20);

    for (const [iri, sts] of sorted) {
      const typeStmt = sts.find(s => s.p.value === RDF_TYPE);
      const typeIri = typeStmt?.o.value ?? null;
      const typeDef = typeIri ? tm.get(typeIri) : null;
      if (typeDef) typesPresent.add(typeDef.label);

      const labelStmt = sts.find(s => s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label');
      const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;
      const degree = degrees.get(iri) ?? 0;

      sampleEntities.push({
        iri,
        label,
        type: typeDef?.label ?? null,
        predicates: [
          `degree:${degree}`,
          ...sts
            .filter(s => s.p.value !== RDF_TYPE)
            .slice(0, 3)
            .map(s => `${s.p.value.split('/').pop()} → ${s.o.value.slice(0, 40)}`)
        ]
      });
    }

    return {
      statementCount: stmts.length,
      sourceCount: sources().length,
      typesPresent: [...typesPresent],
      untypedEntityCount,
      manualStatementCount,
      sampleEntities
    };
  }

  // ── Provider resolution ───────────────────────────────────────────────────

  function getProvider(): { provider: TurtleChatProvider; apiKey: string; model: string; ollamaBaseUrl?: string; reckonsBaseUrl?: string } {
    const s = settings();
    const backendPref = s.chatBackend ?? s.preferredBackend;
    const provider: TurtleChatProvider =
      backendPref === 'openai' ? 'openai'
      : backendPref === 'gemini' ? 'gemini'
      : backendPref === 'ollama' ? 'ollama'
      : backendPref === 'wasm' ? 'wasm'
      : backendPref === 'reckons' ? 'reckons'
      : 'claude';
    const apiKey =
      provider === 'openai' ? (s.openaiApiKey ?? '')
      : provider === 'gemini' ? (s.geminiApiKey ?? '')
      : provider === 'reckons' ? (s.reckonsApiKey ?? '')
      : (s.claudeApiKey ?? '');
    const model =
      provider === 'openai' ? (s.openaiModel ?? 'gpt-4o-mini')
      : provider === 'gemini' ? (s.geminiModel ?? 'gemini-2.0-flash')
      : provider === 'ollama' ? (s.ollamaModel ?? 'llama3.2')
      : provider === 'wasm' ? (s.wasmModel ?? '')
      : provider === 'reckons' ? (s.reckonsModel ?? '@cf/meta/llama-3.1-8b-instruct')
      : (s.claudeModel ?? 'claude-haiku-4-5-20251001');
    return { provider, apiKey, model, ollamaBaseUrl: s.ollamaBaseUrl, reckonsBaseUrl: s.reckonsBaseUrl };
  }

  // ── LLM call ─────────────────────────────────────────────────────────────

  async function sendToShelly(userText: string | null) {
    if (loading) return;
    loading = true;
    errorMsg = '';

    if (userText !== null) {
      messages = [...messages, { role: 'user', content: userText }];
    }

    // Build LLM message history; inject START_TOUR if this is the first call
    const llmMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
      messages.length === 0
        ? [{ role: 'user', content: 'START_TOUR' }]
        : messages.map(m => ({
            role: m.role === 'shelly' ? ('assistant' as const) : ('user' as const),
            content: m.content
          }));

    try {
      const { provider, apiKey, model, ollamaBaseUrl, reckonsBaseUrl } = getProvider();
      const resp = await turtleChat({
        provider, apiKey, model, ollamaBaseUrl, reckonsBaseUrl,
        messages: llmMessages,
        kbContext: buildKBContext(),
        exploreMode: true
      });

      // Apply every adjust_view action Shelly emits
      for (const action of resp.actions) {
        if (action.type === 'adjust_view') {
          applyShellyViewAdjust({
            selectEntity: action.selectEntity,
            layout: action.layout,
            filters: action.filters
          });
        }
      }

      messages = [...messages, { role: 'shelly', content: resp.message, actions: resp.actions }];
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    sendToShelly(null);
  });

  function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    input = '';
    sendToShelly(msg);
  }

  function next() {
    sendToShelly('Continue to the next stop.');
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="explore-panel">
  <div class="explore-header">
    <span class="explore-title mono">explore</span>
    <span class="explore-sub mono">guided tour with Shelly</span>
    <button class="close-btn mono" onclick={onclose} title="End tour">✕</button>
  </div>

  <div class="explore-msgs" bind:this={listEl}>
    {#if messages.length === 0 && loading}
      <div class="shelly-row">
        <img src="/svg/head1.svg" alt="" class="avatar" />
        <div class="bubble thinking-bubble">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    {/if}

    {#each messages as msg, i (i)}
      {#if msg.role === 'shelly'}
        <div class="shelly-row">
          <img src="/svg/head1.svg" alt="" class="avatar" />
          <div class="bubble shelly-bubble">
            <p class="msg-text">{msg.content}</p>
          </div>
        </div>
      {:else}
        <div class="user-row">
          <div class="bubble user-bubble">
            <p class="msg-text">{msg.content}</p>
          </div>
        </div>
      {/if}
    {/each}

    {#if loading && messages.length > 0}
      <div class="shelly-row">
        <img src="/svg/head1.svg" alt="" class="avatar" />
        <div class="bubble thinking-bubble">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    {/if}

    {#if errorMsg}
      <p class="error-text mono">{errorMsg}</p>
    {/if}
  </div>

  <div class="explore-footer">
    <div class="input-row">
      <input
        class="explore-input mono"
        type="text"
        bind:value={input}
        onkeydown={onKeydown}
        placeholder="answer or ask Shelly…"
        disabled={loading}
      />
      <button class="send-btn mono" onclick={send} disabled={loading || !input.trim()}>→</button>
    </div>
    <div class="action-row">
      <button class="next-btn mono" onclick={next} disabled={loading}>
        next stop →
      </button>
      <button class="end-btn mono" onclick={onclose}>
        end tour
      </button>
    </div>
  </div>
</div>

<style>
  .explore-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 320px;
    display: flex;
    flex-direction: column;
    background: rgba(14, 14, 18, 0.94);
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border-left: 1px solid var(--line);
    z-index: 15;
    box-shadow: -4px 0 24px rgba(0,0,0,0.4);
  }

  .explore-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  .explore-title {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .explore-sub {
    font-size: 0.6rem;
    color: var(--muted);
    letter-spacing: 0.05em;
    flex: 1;
  }
  .close-btn {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem 0.4rem;
    border-radius: var(--rad-sm);
    transition: color 0.12s, background 0.12s;
    line-height: 1;
  }
  .close-btn:hover { color: var(--ink); background: var(--surface-2); }

  .explore-msgs {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    scroll-behavior: smooth;
  }

  .shelly-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .user-row {
    display: flex;
    justify-content: flex-end;
  }
  .avatar {
    height: 1.1rem;
    width: auto;
    flex-shrink: 0;
    margin-top: 0.15rem;
  }

  .bubble {
    max-width: 88%;
    padding: 0.6rem 0.75rem;
    border-radius: var(--rad);
    font-size: 0.8rem;
    line-height: 1.6;
  }
  .shelly-bubble {
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--ink);
  }
  .user-bubble {
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--ink);
  }
  .msg-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Thinking animation */
  .thinking-bubble {
    background: var(--surface-2);
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.55rem 0.75rem;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--muted);
    animation: bounce 1.2s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
    40% { transform: translateY(-5px); opacity: 1; }
  }

  .error-text {
    font-size: 0.72rem;
    color: var(--danger);
    margin: 0;
    padding: 0.4rem 0.5rem;
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    border-radius: var(--rad-sm);
    border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  }

  .explore-footer {
    padding: 0.75rem 0.85rem;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .input-row {
    display: flex;
    gap: 0.4rem;
  }
  .explore-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.45rem 0.6rem;
    font-size: 0.75rem;
    color: var(--ink);
    font-family: var(--font-mono);
    outline: none;
    transition: border-color 0.12s;
  }
  .explore-input:focus { border-color: var(--accent); }
  .explore-input::placeholder { color: var(--muted); }
  .explore-input:disabled { opacity: 0.5; cursor: not-allowed; }

  .send-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.45rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: opacity 0.12s;
    font-family: var(--font-mono);
  }
  .send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .send-btn:not(:disabled):hover { opacity: 0.85; }

  .action-row {
    display: flex;
    gap: 0.4rem;
  }
  .next-btn {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    color: var(--accent);
    padding: 0.4rem 0.6rem;
    font-size: 0.68rem;
    font-family: var(--font-mono);
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .next-btn:not(:disabled):hover {
    background: var(--accent-soft);
  }
  .next-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .end-btn {
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--muted);
    padding: 0.4rem 0.6rem;
    font-size: 0.68rem;
    font-family: var(--font-mono);
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }
  .end-btn:hover { color: var(--danger); border-color: var(--danger); }

  @media (max-width: 600px) {
    .explore-panel {
      width: 100%;
      top: auto;
      height: 55vh;
      border-left: none;
      border-top: 1px solid var(--line);
    }
  }
</style>
