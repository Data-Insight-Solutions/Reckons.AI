<script lang="ts">
  /**
   * A Reckoning — STP workflow (Situation · Target · Proposal)
   *
   * The user briefly describes their situation and target goal.
   * Reckons.AI consults the full KB and produces a traceable proposal:
   * options with KB citations, source trust levels, and a recommendation.
   *
   * Two modes:
   *   form  — text areas, structured step-by-step (desktop/tablet)
   *   voice — minimal input, conversational refinement (mobile/voice-first)
   */

  import { settings } from '$lib/stores/settings.svelte';
  import { confirmedStatements, statements, sources } from '$lib/stores/kb.svelte';
  import { allTypes } from '$lib/stores/entity-types.svelte';
  import { turtleChat, type TurtleChatProvider } from '$lib/integrations/llm/turtle-chat';
  import type { KBContext } from '$lib/types/turtle-chat';
  import { RDF_TYPE } from '$lib/rdf/entity-types';
  import { fade } from 'svelte/transition';

  type Step = 'situation' | 'target' | 'confirm' | 'proposal' | 'done' | 'technical';
  type Mode = 'form' | 'voice';

  let mode = $state<Mode>('form');
  let step = $state<Step>('situation');

  let situation = $state('');
  let target = $state('');
  let proposal = $state('');
  let technicalDetail = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Conversational voice mode state
  type VoiceMsg = { role: 'user' | 'assistant'; text: string };
  let conversation = $state<VoiceMsg[]>([]);
  let voiceInput = $state('');
  let voiceStep = $state<'situation' | 'target' | 'proposal'>('situation');

  const RECKONING_SYSTEM_PROMPT = `You are Reckons.AI's decision advisor. Generate a Proposal from the user's Situation and Target using ONLY facts in their personal KB.

OUTPUT RULES:
- Start with an OVERVIEW in plain, everyday language — no jargon, no technical terms, no raw URIs or IRI strings.
- Use the entity LABEL (e.g. "Shared Notes", "Company Alpha") never the raw IRI (e.g. "urn:kbase:...") in the main proposal text.
- Each option must state a concrete next action the user can take, not just a KB citation.
- Do NOT include <kb-actions> blocks in this response.
- Cite only facts in the KB snapshot. Do not invent.
- Keep total response under 450 words. Plain text only — no markdown, no asterisks.
- End with a prompt inviting the user to ask for technical depth.

FORMAT (use these exact section labels):

OVERVIEW
[2-3 sentences. In plain language: what does your KB tell you about this situation and what is the bottom-line recommendation?]

Option A: [plain-language title]
Basis: [which KB knowledge supports this, described in plain language] — Source: [source name]
Action: [specific first step the user should take]
Consideration: [one practical risk or tradeoff]

Option B: [plain-language title]
Basis: [plain-language KB support] — Source: [source name]
Action: [specific first step]
Consideration: [practical tradeoff]

Recommendation: [2-3 sentences, direct and practical. If the KB doesn't cover relevant areas, note what additional sources could strengthen the analysis — but remember that absence of a fact in this KB doesn't mean it's untrue, just not yet captured.]

Confidence: [high / medium / low] — [brief reason, noting if confidence is limited by KB scope rather than contradictory evidence]

Ask for more: Reply "show technical details" to see the full KB entity references, predicate names, and IRI citations behind this proposal.`;

  const VOICE_RECKONING_PROMPT = `You are a concise AI decision advisor for Reckons.AI.

You are in VOICE MODE — conversational, brief, spoken language only.
No markdown, no bullet points, no asterisks. Short sentences.

Current conversation state will be provided. Your job:
1. If situation is not confirmed: ask "What's your situation in one sentence?"
2. If target is not confirmed: ask "What are you trying to achieve?"
3. When both are confirmed: generate a brief spoken proposal (under 120 words) citing KB facts.

After proposing, ask: "Does that work for you, or should I adjust?"`;

  function buildKBContext(): KBContext {
    const stmts = confirmedStatements();
    const allStmts = statements();
    const tm = allTypes();

    const bySubject = new Map<string, typeof stmts>();
    const typedIris = new Set<string>();
    const typeDefIris = new Set<string>();

    for (const st of stmts) {
      if (st.s.kind === 'iri') {
        if (!bySubject.has(st.s.value)) bySubject.set(st.s.value, []);
        bySubject.get(st.s.value)!.push(st);
        if (st.p.value === RDF_TYPE) typedIris.add(st.s.value);
      }
      if (st.o.kind === 'iri' && st.p.value === RDF_TYPE) typeDefIris.add(st.o.value);
    }

    const untypedEntityCount = [...bySubject.keys()].filter(iri => !typedIris.has(iri)).length;
    const manualStatementCount = allStmts.filter(s =>
      (s.status === 'confirmed' || s.status === 'refined') && s.sourceId === 'manual'
    ).length;

    const typesPresent = new Set<string>();
    const sampleEntities: KBContext['sampleEntities'] = [];

    const sorted = [...bySubject.entries()]
      .sort(([iriA, a], [iriB, b]) => {
        const aU = !typedIris.has(iriA) ? -1 : 0;
        const bU = !typedIris.has(iriB) ? -1 : 0;
        return aU - bU || b.length - a.length;
      })
      .slice(0, 30); // more context for reckoning

    for (const [iri, sts] of sorted) {
      const typeStmt = sts.find(s => s.p.value === RDF_TYPE);
      const typeIri = typeStmt?.o.value ?? null;
      const typeDef = typeIri ? tm.find(t => t.iri === typeIri) : null;
      if (typeDef) typesPresent.add(typeDef.label);

      const labelStmt = sts.find(s => s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label');
      const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;

      sampleEntities.push({
        iri,
        label,
        type: typeDef?.label ?? null,
        predicates: sts
          .filter(s => s.p.value !== RDF_TYPE)
          .slice(0, 5)
          .map(s => `${s.p.value.split('/').pop()} → ${s.o.value.slice(0, 60)}`)
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

  function getProvider(): { provider: TurtleChatProvider; apiKey: string; model?: string; ollamaBaseUrl?: string; reckonsBaseUrl?: string } {
    const s = settings();
    const backend = s.chatBackend ?? s.preferredBackend;
    if (backend === 'claude' && s.claudeApiKey)   return { provider: 'claude',  apiKey: s.claudeApiKey,  model: s.claudeModel };
    if (backend === 'openai' && s.openaiApiKey)   return { provider: 'openai',  apiKey: s.openaiApiKey,  model: s.openaiModel };
    if (backend === 'gemini' && s.geminiApiKey)   return { provider: 'gemini',  apiKey: s.geminiApiKey,  model: s.geminiModel };
    if (backend === 'ollama')                     return { provider: 'ollama',  apiKey: '',              model: s.ollamaModel, ollamaBaseUrl: s.ollamaBaseUrl };
    if (backend === 'reckons' && s.reckonsApiKey) return { provider: 'reckons', apiKey: s.reckonsApiKey, model: s.reckonsModel, reckonsBaseUrl: s.reckonsBaseUrl };
    // fallback
    if (s.claudeApiKey)   return { provider: 'claude',  apiKey: s.claudeApiKey,  model: s.claudeModel };
    if (s.openaiApiKey)   return { provider: 'openai',  apiKey: s.openaiApiKey,  model: s.openaiModel };
    if (s.geminiApiKey)   return { provider: 'gemini',  apiKey: s.geminiApiKey,  model: s.geminiModel };
    if (s.reckonsApiKey)  return { provider: 'reckons', apiKey: s.reckonsApiKey, model: s.reckonsModel, reckonsBaseUrl: s.reckonsBaseUrl };
    return { provider: 'wasm', apiKey: '' };
  }

  async function generateProposal() {
    busy = true;
    error = null;
    proposal = '';
    step = 'proposal';

    try {
      const prov = getProvider();
      const kbContext = buildKBContext();

      // Inject the reckoning prompt as a custom prompt override
      const result = await turtleChat({
        ...prov,
        messages: [{
          role: 'user',
          content: `SITUATION:\n${situation.trim()}\n\nTARGET:\n${target.trim()}\n\nPlease generate a structured proposal based on my KB.`
        }],
        kbContext,
        customPrompt: RECKONING_SYSTEM_PROMPT
      });

      proposal = result.message;
      step = 'done';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      step = 'confirm';
    } finally {
      busy = false;
    }
  }

  async function generateTechnicalDetail() {
    busy = true;
    error = null;
    step = 'technical';

    const TECHNICAL_PROMPT = `The user has asked for the technical details behind the proposal you just generated.

Provide a TECHNICAL ADDENDUM that lists, for each option and the recommendation:
- The exact entity IRIs referenced (e.g. <urn:kbase:person/shelly>)
- The predicate IRIs used (e.g. <urn:kbase:predicate/has-note>)
- The object values (IRI or literal)
- The source IRI or ID

Format each reference as:
  Entity: <iri> — Label: "label"
  Predicate: <iri>
  Object: <value>
  Source: <source name or id>

Keep it concise. This is a technical reference appendix to the plain-language proposal.
Do NOT include <kb-actions> blocks.`;

    try {
      const prov = getProvider();
      const kbContext = buildKBContext();
      const result = await turtleChat({
        ...prov,
        messages: [
          {
            role: 'user',
            content: `SITUATION:\n${situation.trim()}\n\nTARGET:\n${target.trim()}\n\nPlease generate a structured proposal based on my KB.`
          },
          { role: 'assistant', content: proposal },
          { role: 'user', content: 'show technical details' }
        ],
        kbContext,
        customPrompt: TECHNICAL_PROMPT
      });
      technicalDetail = result.message;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      step = 'done';
    } finally {
      busy = false;
    }
  }

  async function sendVoiceMessage() {
    const text = voiceInput.trim();
    if (!text) return;
    voiceInput = '';
    conversation = [...conversation, { role: 'user', text }];

    // Update S or T from conversation based on current step
    if (voiceStep === 'situation') situation = text;
    else if (voiceStep === 'target') target = text;

    busy = true;
    error = null;

    try {
      const prov = getProvider();
      const kbContext = buildKBContext();

      const msgs = conversation.map(m => ({ role: m.role, content: m.text }));
      // Append context about current S/T state
      msgs.push({
        role: 'user',
        content: `[Current state: situation="${situation}", target="${target}", step="${voiceStep}"]`
      });

      const result = await turtleChat({
        ...prov,
        messages: msgs,
        kbContext,
        customPrompt: VOICE_RECKONING_PROMPT,
        voiceMode: true
      });

      conversation = [...conversation, { role: 'assistant', text: result.message }];

      // Advance step based on content
      if (voiceStep === 'situation' && situation.length > 5) voiceStep = 'target';
      else if (voiceStep === 'target' && target.length > 5) voiceStep = 'proposal';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function reset() {
    situation = '';
    target = '';
    proposal = '';
    technicalDetail = '';
    conversation = [];
    voiceInput = '';
    voiceStep = 'situation';
    step = 'situation';
    error = null;
  }

  const kbSize = $derived(confirmedStatements().length);
  const hasKB = $derived(kbSize > 0);
</script>

<header class="head">
  <p class="kicker mono">STP framework</p>
  <h1>A Reckoning</h1>
  <p class="sub">Describe your situation and target. Reckons.AI consults your knowledge graph and proposes a traceable path forward.</p>

  <div class="mode-toggle">
    <button class="mode-btn" class:active={mode === 'form'}  onclick={() => { mode = 'form';  reset(); }}>form</button>
    <button class="mode-btn" class:active={mode === 'voice'} onclick={() => { mode = 'voice'; reset(); }}>voice / chat</button>
  </div>
</header>

{#if !hasKB}
  <div class="empty-kb">
    <span class="empty-icon">☷</span>
    <p>Your graph is empty.</p>
    <p class="hint">Ingest at least one source before running a Reckoning — the proposal draws only on facts you've verified.</p>
    <a href="/ingest" class="btn-ingest">Ingest a source →</a>
  </div>

{:else if mode === 'form'}
  <!-- FORM MODE: structured step-by-step -->

  <div class="steps-indicator">
    {#each [['situation','S','01'], ['target','T','02'], ['confirm','','03'], ['proposal','','→'], ['done','','✓']] as [s, abbr, num]}
      <div class="step-dot" class:active={step === s} class:done={['done'].includes(step) && s !== 'done' || step === 'proposal' && s === 'confirm'}></div>
    {/each}
  </div>

  {#if step === 'situation' || step === 'target' || step === 'confirm'}
    <section class="card">
      <div class="stp-header">
        <span class="stp-num mono">01</span>
        <div>
          <h3>Situation</h3>
          <p class="stp-desc">Where are you now? What's the context?</p>
        </div>
      </div>
      <textarea
        class="stp-input"
        bind:value={situation}
        placeholder="e.g. I'm evaluating two ML frameworks for a production recommendation system. Team has 3 engineers, deadline is 6 weeks."
        rows="4"
        disabled={step === 'confirm'}
      ></textarea>
      {#if step === 'situation'}
        <button class="btn-next" disabled={situation.trim().length < 10} onclick={() => step = 'target'}>
          Next: Target →
        </button>
      {/if}
    </section>
  {/if}

  {#if step === 'target' || step === 'confirm'}
    <section class="card" transition:fade={{ duration: 150 }}>
      <div class="stp-header">
        <span class="stp-num mono">02</span>
        <div>
          <h3>Target</h3>
          <p class="stp-desc">What outcome are you trying to reach?</p>
        </div>
      </div>
      <textarea
        class="stp-input"
        bind:value={target}
        placeholder="e.g. Choose the framework that minimises engineering risk while giving us the best long-term scalability for 10M+ users."
        rows="3"
        disabled={step === 'confirm'}
      ></textarea>
      {#if step === 'target'}
        <div class="btn-row">
          <button class="btn-back" onclick={() => step = 'situation'}>← Back</button>
          <button class="btn-next" disabled={target.trim().length < 10} onclick={() => step = 'confirm'}>
            Review →
          </button>
        </div>
      {/if}
    </section>
  {/if}

  {#if step === 'confirm'}
    <section class="card confirm-card" transition:fade={{ duration: 150 }}>
      <div class="stp-header">
        <span class="stp-num mono">03</span>
        <div>
          <h3>Confirm</h3>
          <p class="stp-desc">Review your inputs. The proposal draws only on your verified graph ({kbSize} facts).</p>
        </div>
      </div>

      <div class="confirm-preview">
        <div class="confirm-row">
          <span class="confirm-label mono">situation</span>
          <p>{situation}</p>
        </div>
        <div class="confirm-row">
          <span class="confirm-label mono">target</span>
          <p>{target}</p>
        </div>
        <div class="confirm-row">
          <span class="confirm-label mono">graph context</span>
          <p>{kbSize} confirmed facts · {sources().length} source{sources().length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <div class="btn-row">
        <button class="btn-back" onclick={() => step = 'target'}>← Edit</button>
        <button class="btn-reckon" disabled={busy} onclick={generateProposal}>
          {busy ? 'Consulting graph…' : 'Generate Proposal'}
        </button>
      </div>
    </section>
  {/if}

  {#if step === 'proposal'}
    <section class="card" transition:fade={{ duration: 200 }}>
      <div class="stp-header">
        <span class="stp-num accent mono">→</span>
        <div>
          <h3>Generating…</h3>
          <p class="stp-desc">Consulting your knowledge graph.</p>
        </div>
      </div>
      <div class="thinking-bars">
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </div>
    </section>
  {/if}

  {#if (step === 'done' || step === 'technical') && proposal}
    <section class="card proposal-card" transition:fade={{ duration: 200 }}>
      <div class="stp-header">
        <span class="stp-num ok mono">✓</span>
        <div>
          <h3>Proposal</h3>
          <p class="stp-desc">Based on {kbSize} verified statements.</p>
        </div>
      </div>

      <div class="proposal-body">
        {#each proposal.split('\n') as line}
          {#if line.trim()}
            {#if line.startsWith('OVERVIEW')}
              <p class="proposal-section">Overview</p>
            {:else if line.startsWith('Option') || line.startsWith('Recommendation') || line.startsWith('Confidence') || line.startsWith('Ask for more')}
              <p class="proposal-section">{line}</p>
            {:else if line.startsWith('Basis:') || line.startsWith('Consideration:') || line.startsWith('Action:')}
              <p class="proposal-detail mono">{line}</p>
            {:else}
              <p class="proposal-text">{line}</p>
            {/if}
          {/if}
        {/each}
      </div>

      {#if step === 'technical' && busy}
        <div class="thinking-bars" style="margin: 0.8rem 0">
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
        </div>
      {/if}

      {#if technicalDetail}
        <div class="technical-section">
          <p class="technical-label mono">Technical details</p>
          {#each technicalDetail.split('\n') as line}
            {#if line.trim()}
              <p class="technical-line mono">{line}</p>
            {/if}
          {/each}
        </div>
      {/if}

      <div class="btn-row">
        <button class="btn-back" onclick={reset}>New Reckoning</button>
        {#if !technicalDetail && !busy}
          <button class="btn-technical" onclick={generateTechnicalDetail}>Show technical details</button>
        {/if}
        <button class="btn-next" onclick={() => { step = 'confirm'; proposal = ''; technicalDetail = ''; }}>Refine inputs →</button>
      </div>
    </section>
  {/if}

{:else}
  <!-- VOICE / CHAT MODE -->
  <section class="card voice-card">
    <div class="voice-header">
      <span class="voice-step-label mono">
        {voiceStep === 'situation' ? '01 — situation' : voiceStep === 'target' ? '02 — target' : '03 — proposal'}
      </span>
      <button class="btn-reset-voice" onclick={reset}>reset</button>
    </div>

    <div class="conversation">
      {#if conversation.length === 0}
        <div class="conv-starter">
          <p class="conv-prompt">What's your situation?</p>
          <p class="conv-hint mono">Describe briefly — I'll ask follow-up questions and consult your graph.</p>
        </div>
      {/if}
      {#each conversation as msg}
        <div class="msg" class:user={msg.role === 'user'} class:assistant={msg.role === 'assistant'}>
          <span class="msg-label mono">{msg.role === 'user' ? 'you' : 'reckons'}</span>
          <p>{msg.text}</p>
        </div>
      {/each}
      {#if busy}
        <div class="msg assistant">
          <span class="msg-label mono">reckons</span>
          <p class="thinking-dots">···</p>
        </div>
      {/if}
    </div>

    {#if error}
      <p class="error-msg">{error}</p>
    {/if}

    <div class="voice-input-row">
      <textarea
        class="voice-textarea"
        bind:value={voiceInput}
        placeholder={voiceStep === 'situation' ? 'Describe your situation…' : voiceStep === 'target' ? 'What are you trying to achieve?' : 'Reply or ask for adjustments…'}
        rows="2"
        disabled={busy}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendVoiceMessage(); } }}
      ></textarea>
      <button class="btn-send" disabled={busy || !voiceInput.trim()} onclick={sendVoiceMessage}>
        {busy ? '…' : '→'}
      </button>
    </div>
    <p class="hint">Enter to send · Shift+Enter for new line</p>
  </section>
{/if}

<style>
  .head { margin-bottom: 2rem; }
  .kicker { font-size: 0.7rem; color: var(--accent); letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 0.3rem; font-family: var(--font-mono); }
  h1 { font-size: clamp(1.8rem, 5vw, 2.8rem); margin: 0 0 0.4rem; }
  .sub { font-size: 0.9rem; color: var(--muted); margin: 0 0 1.2rem; line-height: 1.55; max-width: 560px; }
  .hint { font-size: 0.75rem; color: var(--muted); margin: 0.4rem 0 0; }

  .mode-toggle { display: flex; border: 1px solid var(--line); border-radius: var(--rad-sm); overflow: hidden; width: fit-content; }
  .mode-btn {
    padding: 0.35rem 0.8rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--surface-2);
    color: var(--muted);
    border: none;
    border-right: 1px solid var(--line);
    cursor: pointer;
    transition: all 0.15s;
  }
  .mode-btn:last-child { border-right: none; }
  .mode-btn.active { background: var(--accent-soft); color: var(--accent); }

  /* Empty KB */
  .empty-kb {
    text-align: center;
    padding: 4rem 2rem;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }
  .empty-icon { font-size: 2.5rem; }
  .empty-kb p { margin: 0; font-size: 0.9rem; }
  .btn-ingest {
    margin-top: 0.5rem;
    background: var(--accent);
    color: #fff;
    padding: 0.55rem 1.2rem;
    border-radius: var(--rad);
    text-decoration: none;
    font-size: 0.88rem;
  }

  /* Steps indicator */
  .steps-indicator { display: flex; gap: 0.4rem; margin-bottom: 1.2rem; align-items: center; }
  .step-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--line);
    transition: background 0.3s;
  }
  .step-dot.active { background: var(--accent); }
  .step-dot.done  { background: var(--ok); }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.4rem;
    margin-bottom: 1rem;
  }

  .stp-header { display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 0.8rem; }
  .stp-num { font-size: 1.6rem; color: var(--muted); line-height: 1; flex-shrink: 0; }
  .stp-num.accent { color: var(--accent); }
  .stp-num.ok     { color: var(--ok); }
  h3 { font-size: 1rem; color: var(--ink); margin: 0 0 0.2rem; }
  .stp-desc { font-size: 0.82rem; color: var(--muted); margin: 0; }

  .stp-input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 0.92rem;
    padding: 0.8rem 1rem;
    line-height: 1.55;
    resize: vertical;
    box-sizing: border-box;
    margin-bottom: 0.8rem;
  }
  .stp-input:focus { outline: none; border-color: var(--accent); }
  .stp-input:disabled { opacity: 0.6; }

  .btn-row { display: flex; gap: 0.6rem; justify-content: flex-end; flex-wrap: wrap; }
  .btn-next {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.5rem 1.1rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn-next:disabled { opacity: 0.4; cursor: default; }
  .btn-back {
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .btn-back:hover { color: var(--ink-2); }

  /* Confirm card */
  .confirm-preview { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
  .confirm-row { display: flex; gap: 0.75rem; }
  .confirm-label { font-size: 0.68rem; color: var(--accent); letter-spacing: 0.08em; text-transform: uppercase; min-width: 70px; padding-top: 0.15rem; flex-shrink: 0; }
  .confirm-row p { font-size: 0.85rem; color: var(--ink-2); margin: 0; line-height: 1.5; }

  .btn-reckon {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.55rem 1.4rem;
    font-size: 0.9rem;
    font-family: var(--font-display);
    cursor: pointer;
    letter-spacing: -0.01em;
    transition: opacity 0.15s, transform 0.15s;
  }
  .btn-reckon:disabled { opacity: 0.5; cursor: default; }
  .btn-reckon:not(:disabled):hover { opacity: 0.85; transform: translateY(-1px); }

  /* Thinking bars */
  .thinking-bars { display: flex; gap: 6px; align-items: flex-end; height: 28px; margin-top: 0.5rem; }
  .bar {
    width: 6px;
    background: var(--accent);
    border-radius: 3px;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .bar:nth-child(2) { animation-delay: 0.2s; }
  .bar:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse {
    0%, 100% { height: 8px; opacity: 0.4; }
    50%       { height: 28px; opacity: 1; }
  }

  /* Proposal */
  .proposal-card { border-color: var(--accent); }
  .proposal-body { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 1.2rem; }
  .proposal-section { font-family: var(--font-display); font-size: 0.95rem; color: var(--ink); margin: 0.6rem 0 0.1rem; font-weight: 600; }
  .proposal-detail  { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); margin: 0; line-height: 1.5; }
  .proposal-text    { font-size: 0.88rem; color: var(--ink-2); margin: 0; line-height: 1.6; }

  .btn-technical {
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.5rem 1rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .btn-technical:hover { color: var(--accent); border-color: var(--accent); }

  .technical-section {
    border-top: 1px solid var(--line);
    margin-top: 1rem;
    padding-top: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .technical-label {
    font-size: 0.65rem;
    color: var(--accent);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0 0 0.4rem;
  }
  .technical-line {
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
    word-break: break-all;
  }

  /* Error */
  .error-msg { font-size: 0.8rem; color: var(--danger); margin: 0.5rem 0; }

  /* Voice / chat */
  .voice-card { display: flex; flex-direction: column; gap: 0.8rem; }
  .voice-header { display: flex; justify-content: space-between; align-items: center; }
  .voice-step-label { font-size: 0.68rem; color: var(--accent); letter-spacing: 0.1em; text-transform: uppercase; }
  .btn-reset-voice { font-family: var(--font-mono); font-size: 0.68rem; background: none; border: 1px solid var(--line); color: var(--muted); border-radius: var(--rad-sm); padding: 0.2rem 0.5rem; cursor: pointer; }

  .conversation { display: flex; flex-direction: column; gap: 0.75rem; min-height: 180px; max-height: 50vh; overflow-y: auto; padding: 0.5rem 0; }
  .conv-starter { text-align: center; padding: 2rem 1rem; }
  .conv-prompt { font-family: var(--font-display); font-size: 1.2rem; color: var(--ink-2); margin: 0 0 0.4rem; }
  .conv-hint { font-size: 0.75rem; color: var(--muted); margin: 0; }

  .msg { display: flex; flex-direction: column; gap: 0.2rem; max-width: 85%; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; }
  .msg-label { font-size: 0.62rem; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  .msg p { margin: 0; font-size: 0.88rem; line-height: 1.5; padding: 0.5rem 0.8rem; border-radius: var(--rad-sm); }
  .msg.user      p { background: var(--accent-soft); color: var(--ink-2); border: 1px solid var(--accent); }
  .msg.assistant p { background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); }
  .thinking-dots { animation: blink 1.2s infinite; }
  @keyframes blink { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

  .voice-input-row { display: flex; gap: 0.5rem; align-items: flex-end; }
  .voice-textarea {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 0.9rem;
    padding: 0.6rem 0.8rem;
    resize: none;
    line-height: 1.4;
  }
  .voice-textarea:focus { outline: none; border-color: var(--accent); }
  .btn-send {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.6rem 1rem;
    font-size: 1.1rem;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  .btn-send:disabled { opacity: 0.4; cursor: default; }
</style>
