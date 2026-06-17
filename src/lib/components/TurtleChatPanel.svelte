<script lang="ts">
  /**
   * TurtleChatPanel — slide-in panel next to the Turtle companion.
   *
   * Two tabs:
   *  • "learn" — guided tutorial on KB concepts and workflow
   *  • "chat"         — free-form Claude conversation that can propose KB changes
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { confirmedStatements, statements, sources, addStatements, addSource, updateStatement, setStatus } from '$lib/stores/kb.svelte';
  import { typeMap } from '$lib/stores/entity-types.svelte';
  import { ONBOARDING_TEMPLATES, BLANK_TEMPLATE } from '$lib/onboarding/templates';
  import { settings } from '$lib/stores/settings.svelte';
  import { RDF_TYPE } from '$lib/rdf/entity-types';
  import type { TurtleChatMessage, KBAction, KBContext } from '$lib/types/turtle-chat';
  import { turtleChat, resolveChatProvider as _resolveProvider, type TurtleChatProvider } from '$lib/integrations/llm/turtle-chat';
  import type { Statement, Source } from '$lib/rdf/types';
  import { v4 as uuid } from 'uuid';
  import { applyShellyViewAdjust, activeStoryId, stopStory, storyAutoPlayRequested, clearStoryAutoPlay } from '$lib/stores/shelly-bridge.svelte';
  import { extractStories, type Story, type StoryStep } from '$lib/rdf/story';
  import { wasmStatus, wasmPct, wasmStatusText } from '$lib/stores/wasm-status.svelte';
  import { turtleSettings, updateTurtleSettings } from '$lib/stores/turtle-settings.svelte';
  import SnapPanel from './SnapPanel.svelte';
  import ShellyVoice from './ShellyVoice.svelte';
  import { Tabs } from 'bits-ui';

  let { onclose = () => {}, initialMessage = null, exploreMode = false, storyId = null } = $props<{
    onclose?: () => void;
    initialMessage?: string | null;
    exploreMode?: boolean;
    storyId?: string | null;
  }>();

  type Tab = 'tutorial' | 'chat' | 'explore';
  let tab = $state<Tab>(storyId ? 'explore' : exploreMode ? 'explore' : 'tutorial');

  function resolveChatProvider() {
    return _resolveProvider(settings());
  }

  function handleChatError(e: unknown, provider: TurtleChatProvider) {
    const raw = e instanceof Error ? e.message : String(e);
    if (provider === 'wasm') {
      // Simplify verbose HuggingFace/ONNX errors for the user
      const short = raw.includes('registerBackend') || raw.includes('ONNX runtime') ? 'ONNX unsupported in this browser'
        : raw.includes('Unauthorized') ? 'model download blocked'
        : raw.includes('timed out') ? 'model download timed out'
        : raw.includes('Failed to fetch') || raw.includes('NetworkError') ? 'network error'
        : raw.length > 80 ? raw.slice(0, 70) + '…' : raw;
      errorMsg = `No AI backend available (local: ${short}). Add an API key or install Ollama.`;
      errorLink = { label: 'Settings', href: '/settings#s-backends' };
    } else if (provider === 'ollama') {
      // Pass through the CORS-aware message from chatOllama
      errorMsg = raw;
      errorLink = { label: 'Ollama setup', href: '/settings#s-ollama' };
    } else {
      errorMsg = raw;
      errorLink = null;
    }
  }

  const isWasmProvider = $derived.by(() => {
    return resolveChatProvider().provider === 'wasm';
  });

  // Auto-send initialMessage when provided (e.g. from search bar forwarding)
  $effect(() => {
    if (initialMessage) {
      tab = 'chat';
      input = initialMessage;
      // Micro-delay so the chat tab renders before sending
      setTimeout(() => sendMessage(), 50);
    }
  });

  // Switch to explore tab once when explore mode is first activated
  // (e.g. explore chip clicked while panel already open).
  // Does NOT continuously force the tab — user can navigate freely after.
  let exploreModeHandled = $state(false);
  $effect(() => {
    if (exploreMode && !exploreModeHandled) {
      exploreModeHandled = true;
      tab = 'explore';
      if (!exploreStarted) {
        exploreStarted = true;
        sendExploreMessage(null);
      }
    }
  });

  // ── Tutorial ───────────────────────────────────────────────────────────────

  const STEPS = [
    {
      title: "Hi, I'm Shelly",
      body: `Welcome to **Reckons.AI** — your personal knowledge base.\n\nI'm your guide. I'll walk you through the main ideas, then you can ask me anything or load a starter scenario to jump straight in.\n\nReckons.AI stores knowledge as a **KB** (knowledge base) — a living graph of facts about your world, with every fact traced back to the source document it came from.`
    },
    {
      title: 'your knowledge base',
      body: `Your KB is stored in the **Turtle** (\`.ttl\`) format — a W3C standard for expressing knowledge as a graph.\n\nEverything Reckons.AI knows lives in your KB:\n\n• **Entities** — people, places, events, concepts\n• **Relationships** — how they connect\n• **Source documents** — visible in the graph as 📄 nodes, linked to everything they contributed\n• **Trust** — how reliable each source has proven to be\n\nYou own the data. Nothing leaves your device unless you share it.`
    },
    {
      title: 'one fact = one triple',
      body: `Every fact in your KB is a **triple**: three parts.\n\n\`subject · predicate · object\`\n\nExample in plain language:\n**Alice** · **organized** · **Meramec Float Trip**\n\nIn Turtle syntax:\n\`\`\`\n<urn:kbase:person/alice>\n  <urn:kbase:predicate/organized>\n  <urn:kbase:event/float-trip> .\n\`\`\`\n\nEvery node in the graph is a subject or object. Every edge is a predicate. Source documents also appear as nodes — click one to see which entities it contributed.`
    },
    {
      title: 'adding knowledge',
      body: `Go to **Ingest** (＋) to add new knowledge to your KB.\n\nYou can ingest:\n• A **note** you type\n• A **URL** (web page, news article)\n• A **document** (PDF, markdown)\n• A **shared KB** (.ttl) from someone else\n• Your **calendar** events\n\nThe AI reads your source, consolidates overlapping facts, and extracts triples. You review and confirm them — only what you approve enters your KB.\n\nEach ingested source becomes a 📄 document node in the graph, connected to every entity it contributed.`
    },
    {
      title: 'review & confirm',
      body: `After ingestion, triples start as **pending** — waiting for your approval.\n\nIn the **Review** tab:\n• ✓ **Confirm** triples that are accurate\n• ✕ **Reject** ones that are wrong\n• Merge duplicate entities (e.g. "Alice Smith" and "Alice" are the same person)\n\nOnly confirmed triples appear in the graph and are used by Reckonings. This keeps your KB trustworthy.`
    },
    {
      title: 'explore the graph',
      body: `Your knowledge comes alive in the **graph view**.\n\nUse the layout chips to organize your view:\n• **force** — free-form physics layout\n• **source** — clusters around each source document\n• **type** — groups by entity type (Person, Concept, etc.)\n• **hub** — highlights your most connected entities\n• **order** — numbered grid you can drag to reorder\n• **focus** — centers on the selected node\n\nFilters let you highlight **hubs**, **islands**, **leaps**, or entities missing types or sources.`
    },
    {
      title: 'run a reckoning',
      body: `Once your KB has facts, try a **Reckoning** (the ⟁ tab).\n\n1. Describe your **situation** — what context matters?\n2. State your **target** — what outcome do you want?\n3. Reckons.AI proposes options grounded only in what your KB already knows\n\nThe proposal cites which facts and sources back each option. You can accept the AI's suggested updates to mark the decision as part of your KB's history.`
    },
    {
      title: 'sharing & CLI',
      body: `Your KB exports as a portable \`.ttl\` file.\n\n**Share it:** Go to **KB** to download your knowledge base. Others import it as a trusted source in their own Reckons.AI.\n\n**Use the CLI:** The \`reckons\` command-line tool reads your KB from the terminal:\n\`\`\`\nreckons search "contract"\nreckons ask "what do I know about Alice?"\nreckons --listen\n\`\`\`\n\nThe \`--listen\` flag enables audio mode — speak to your KB through smart glasses or bluetooth headphones. Mic in, speaker out.`
    },
    {
      title: 'the Turtle format (technical)',
      body: `For the curious: Turtle is a W3C standard for **RDF** (Resource Description Framework) — the file format behind your KB.\n\nEach entity has a unique **IRI** (like a URL for a concept):\n\`\`\`\n@prefix kb: <urn:kbase:> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n\nkb:person/alice\n  a kb:type/Person ;\n  rdfs:label "Alice" ;\n  kb:predicate/organized kb:event/float-trip .\n\`\`\`\n\nSemicolons stack predicates for the same subject. \`a\` is shorthand for \`rdf:type\`. The dot ends the statement.\n\nYou never need to write raw Turtle — the app handles it. But you can always inspect or edit the \`.ttl\` file directly.`
    },
    {
      title: "you're ready",
      body: `That's the core of Reckons.AI:\n\n✓ **Ingest** (＋) sources to add facts\n✓ **Review** (◐) to confirm what's accurate\n✓ **Explore** the graph with layout modes and filters\n✓ **Reckon** (⟁) when you need a decision\n✓ **Share** your KB (.ttl) or use the Reckons CLI\n✓ **KB** (△) to manage and export your knowledge base\n\nSwitch to the **chat** tab to ask me anything about your KB. Or close this panel and start exploring.`
    }
  ];

  let tutorialStep = $state(0);
  const currentStep = $derived(STEPS[tutorialStep]);
  const isLastStep = $derived(tutorialStep === STEPS.length - 1);

  // ── Starter template loading (shown when KB is empty) ──────────────────────
  const isEmptyKB = $derived(confirmedStatements().length === 0 && statements().length === 0);
  let loadingStarter = $state<string | null>(null);

  async function loadStarterTemplate(id: string) {
    if (id === 'blank') { goto('/ingest'); return; }
    const tmpl = ONBOARDING_TEMPLATES.find(t => t.id === id);
    if (!tmpl) return;
    loadingStarter = id;
    try {
      const { source, statements: stmts } = tmpl.buildData();
      await addSource(source);
      await addStatements(stmts);
      // Suggest a first action via Shelly chat
      messages = [{
        role: 'assistant',
        content: `Your **${tmpl.label}** graph is loaded!\n\n${tmpl.hint}`
      }];
      tab = 'chat';
      goto('/');
    } finally {
      loadingStarter = null;
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  let messages = $state<TurtleChatMessage[]>([]);
  let input = $state('');
  let loading = $state(false);
  let errorMsg = $state('');
  let errorLink = $state<{ label: string; href: string } | null>(null);
  let msgListRef: HTMLDivElement | undefined;

  // ── Session source ──────────────────────────────────────────────────────────
  // One Source record is created per chat session, so all accepted suggestions
  // share provenance: "Shelly — {model} · {time}" (like re-analyze sources).
  let sessionSourceId = $state<string | null>(null);
  let sessionProvider = $state<TurtleChatProvider>('claude');
  let sessionModel = $state<string>('');

  async function ensureSessionSource(): Promise<string> {
    if (sessionSourceId) return sessionSourceId;
    const { provider, model } = resolveChatProvider();
    const now = Date.now();
    const id = `shelly-${now}`;
    const src: Source = {
      id,
      title: `Shelly — ${model} · ${new Date(now).toLocaleTimeString()}`,
      uri: `urn:kbase:source/${id}`,
      ingestedAt: now,
      kind: 'analysis',
      analysisModel: model,
      analysisProvider: provider,
      analysisTrigger: 'manual'
    };
    await addSource(src);
    sessionSourceId = id;
    sessionProvider = provider;
    sessionModel = model ?? '';
    return id;
  }

  // Auto-scroll on new messages
  $effect(() => {
    if (messages.length && msgListRef) {
      setTimeout(() => msgListRef!.scrollTo({ top: msgListRef!.scrollHeight, behavior: 'smooth' }), 30);
    }
  });

  /** Build Shelly's personality preamble from TurtleSettings. */
  function buildShellyPrompt(): string | undefined {
    const ts = turtleSettings();
    const parts: string[] = [];
    if (ts.systemPrompt.trim()) parts.push(ts.systemPrompt.trim());
    if (ts.name && ts.name !== 'Shelly') parts.push(`Your name is ${ts.name} (not Shelly).`);
    if (ts.responseStyle === 'detailed') parts.push('Give thorough, detailed answers.');
    else if (ts.responseStyle === 'conversational') parts.push('Be conversational and warm — write as if chatting with a friend.');
    if (ts.maxResponseWords > 0) parts.push(`Keep responses under ${ts.maxResponseWords} words.`);
    if (ts.personality === 'witty') parts.push('Be clever, playful, and occasionally use wordplay.');
    else if (ts.personality === 'laid-back') parts.push('Be relaxed and casual — no rush, no pressure.');
    else if (ts.personality === 'sarcastic') parts.push('Be sarcastic and dry-witted, but still helpful underneath.');
    if (ts.greeting.trim()) parts.push(`When first greeting the user, say: "${ts.greeting.trim()}"`);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  function buildKBContext(): KBContext {
    const stmts = confirmedStatements();
    const allStmts = statements();
    const tm = typeMap();

    // Group by subject, find types
    const bySubject = new Map<string, Statement[]>();
    const typedIris = new Set<string>();
    const typeDefIris = new Set<string>(); // objects of rdf:type — type IRIs, not entities
    const objectOnlyIris = new Set<string>(); // IRIs appearing only as objects (no subject statements)
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
    // Remove type definition IRIs and any that turned out to also be subjects
    for (const iri of typeDefIris) objectOnlyIris.delete(iri);
    for (const iri of bySubject.keys()) objectOnlyIris.delete(iri);

    const untypedEntityCount =
      [...bySubject.keys()].filter(iri => !typedIris.has(iri)).length +
      objectOnlyIris.size;
    const manualStatementCount = allStmts.filter(s =>
      (s.status === 'confirmed' || s.status === 'refined') && s.sourceId === 'manual'
    ).length;

    const typesPresent = new Set<string>();
    const sampleEntities: KBContext['sampleEntities'] = [];

    // Sort: untyped entities first (so Shelly sees them in the sample)
    const sorted = [...bySubject.entries()]
      .sort(([iriA, a], [iriB, b]) => {
        const aUntyped = !typedIris.has(iriA) ? -1 : 0;
        const bUntyped = !typedIris.has(iriB) ? -1 : 0;
        return aUntyped - bUntyped || b.length - a.length;
      })
      .slice(0, 20);

    for (const [iri, sts] of sorted) {
      const typeStmt = sts.find((s) => s.p.value === RDF_TYPE);
      const typeIri = typeStmt?.o.value ?? null;
      const typeDef = typeIri ? tm.get(typeIri) : null;
      if (typeDef) typesPresent.add(typeDef.label);

      const labelStmt = sts.find((s) => s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label');
      const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;

      sampleEntities.push({
        iri,
        label,
        type: typeDef?.label ?? null,
        predicates: sts
          .filter((s) => s.p.value !== RDF_TYPE)
          .slice(0, 4)
          .map((s) => `${s.p.value.split('/').pop()} → ${s.o.value.slice(0, 40)}`)
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

  // ── KB query (for query_kb action) ────────────────────────────────────────

  function runKBQuery(filter: 'no-type' | 'no-source' | 'pending' | 'islands'): string {
    const stmts = statements();
    const confirmed = stmts.filter(s => s.status === 'confirmed' || s.status === 'refined');

    if (filter === 'no-type') {
      const bySubject = new Map<string, Statement[]>();
      const typedIris = new Set<string>();
      const typeDefIris = new Set<string>();
      // Build reverse map: IRI → statements where it appears as object (for object-only entities)
      const asObject = new Map<string, Statement[]>();
      for (const st of confirmed) {
        if (st.s.kind === 'iri') {
          if (!bySubject.has(st.s.value)) bySubject.set(st.s.value, []);
          bySubject.get(st.s.value)!.push(st);
          if (st.p.value === RDF_TYPE) typedIris.add(st.s.value);
        }
        if (st.o.kind === 'iri') {
          if (st.p.value === RDF_TYPE) typeDefIris.add(st.o.value);
          else {
            if (!asObject.has(st.o.value)) asObject.set(st.o.value, []);
            asObject.get(st.o.value)!.push(st);
          }
        }
      }
      // Untyped subject-entities
      const untypedSubjects = [...bySubject.entries()].filter(([iri]) => !typedIris.has(iri));
      // Object-only entities: appear as objects but never as subjects, and are not type IRIs
      const objectOnlyUntyped: [string, Statement[]][] = [];
      for (const [iri, sts] of asObject) {
        if (!bySubject.has(iri) && !typeDefIris.has(iri)) objectOnlyUntyped.push([iri, sts]);
      }
      const untyped = [...untypedSubjects, ...objectOnlyUntyped];
      const lines = untyped.slice(0, 40).map(([iri, sts]) => {
        const label = sts.find(s => s.p.value.includes('label'))?.o.value ?? iri.split('/').pop() ?? iri;
        const preds = sts.slice(0, 3).map(s => s.p.value.split('/').pop()).join(', ');
        return `• ${label} <${iri}> — predicates: ${preds || '(object-only, no outgoing)'}`;
      });
      const total = untyped.length;
      return `[KB Query: entities without a type]\nFound ${total} untyped entities${total > 40 ? ' (showing first 40)' : ''}:\n${lines.join('\n')}`;
    }

    if (filter === 'no-source') {
      const manual = confirmed.filter(s => s.sourceId === 'manual');
      const lines = manual.slice(0, 30).map(s => {
        const subj = s.s.kind === 'iri' ? s.s.value.split('/').pop() : s.s.value;
        const pred = s.p.value.split('/').pop();
        const obj = s.o.kind === 'iri' ? s.o.value.split('/').pop() : s.o.value.slice(0, 50);
        return `• ${subj} · ${pred} · ${obj}`;
      });
      return `[KB Query: manually added statements]\nFound ${manual.length} manual statements${manual.length > 30 ? ' (showing first 30)' : ''}:\n${lines.join('\n')}`;
    }

    if (filter === 'pending') {
      const pending = stmts.filter(s => s.status === 'pending');
      const lines = pending.slice(0, 30).map(s => {
        const subj = s.s.kind === 'iri' ? s.s.value.split('/').pop() : s.s.value;
        const pred = s.p.value.split('/').pop();
        const obj = s.o.kind === 'iri' ? s.o.value.split('/').pop() : s.o.value.slice(0, 50);
        return `• ${subj} · ${pred} · ${obj}`;
      });
      return `[KB Query: pending statements]\nFound ${pending.length} pending statements${pending.length > 30 ? ' (showing first 30)' : ''}:\n${lines.join('\n')}`;
    }

    return `[KB Query: ${filter}]\n(unsupported filter)`;
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const { provider, apiKey, model } = resolveChatProvider();
    const s = settings();

    input = '';
    errorMsg = '';
    errorLink = null;
    messages = [...messages, { role: 'user', content: text }];
    loading = true;

    try {
      const data = await turtleChat({
        provider,
        apiKey,
        model,
        ollamaBaseUrl: s.ollamaBaseUrl,
        reckonsBaseUrl: s.reckonsBaseUrl,
        messages: messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        kbContext: buildKBContext(),
        customPrompt: buildShellyPrompt()
      });
      messages = [...messages, { role: 'assistant', content: data.message, actions: data.actions ?? [] }];
    } catch (e) {
      handleChatError(e, provider);
    } finally {
      loading = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── Explore tab ────────────────────────────────────────────────────────────

  type ExploreMsg = { role: 'shelly' | 'user'; content: string };
  let exploreMessages = $state<ExploreMsg[]>([]);
  let exploreInput = $state('');
  let exploreLoading = $state(false);
  let exploreErrorMsg = $state('');
  let exploreListRef: HTMLDivElement | undefined;
  let exploreStarted = $state(false);

  $effect(() => {
    if (exploreMessages.length && exploreListRef) {
      setTimeout(() => exploreListRef!.scrollTo({ top: exploreListRef!.scrollHeight, behavior: 'smooth' }), 30);
    }
  });

  // Auto-start tour on mount if in explore mode; also triggered by tab click below
  onMount(() => {
    if (tab === 'explore' && !exploreStarted) {
      exploreStarted = true;
      sendExploreMessage(null);
    }
  });

  async function sendExploreMessage(userText: string | null) {
    if (exploreLoading) return;
    exploreLoading = true;
    exploreErrorMsg = '';

    if (userText !== null) {
      exploreMessages = [...exploreMessages, { role: 'user', content: userText }];
    }

    const llmMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
      exploreMessages.length === 0
        ? [{ role: 'user', content: 'START_TOUR' }]
        : exploreMessages.map(m => ({
            role: m.role === 'shelly' ? ('assistant' as const) : ('user' as const),
            content: m.content
          }));

    const { provider, apiKey, model } = resolveChatProvider();
    const s = settings();

    try {
      const resp = await turtleChat({
        provider, apiKey, model,
        ollamaBaseUrl: s.ollamaBaseUrl,
        reckonsBaseUrl: s.reckonsBaseUrl,
        messages: llmMessages,
        kbContext: buildKBContext(),
        exploreMode: true,
        customPrompt: buildShellyPrompt()
      });

      for (const action of resp.actions) {
        if (action.type === 'adjust_view') {
          applyShellyViewAdjust({
            selectEntity: action.selectEntity,
            layout: action.layout,
            filters: action.filters
          });
        }
      }

      exploreMessages = [...exploreMessages, { role: 'shelly', content: resp.message }];
    } catch (e) {
      handleChatError(e, provider);
      exploreErrorMsg = errorMsg;
    } finally {
      exploreLoading = false;
    }
  }

  function sendExploreInput() {
    const msg = exploreInput.trim();
    if (!msg || exploreLoading) return;
    exploreInput = '';
    sendExploreMessage(msg);
  }

  function onExploreKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendExploreInput(); }
  }

  // ── Story tab ─────────────────────────────────────────────────────────────

  const kbStories = $derived((() => {
    const rdfStories = extractStories(statements());
    const s = settings();
    if (s.kbStory && s.kbStory.length > 0) {
      const userStory: Story = {
        id: 'urn:reckons:story/KbGuide',
        label: s.kbTitle ? `${s.kbTitle} Guide` : 'KB Guide',
        description: s.kbDescription ?? 'A guided tour of this knowledge base.',
        autoplay: false,
        pace: 8,
        steps: s.kbStory.map((step, i) => ({
          id: `urn:reckons:story/KbGuide/step${i + 1}`,
          order: i + 1,
          title: step.title,
          content: step.content,
          highlights: step.highlights ?? [],
        })),
      };
      // Put the user story first, skip if an RDF story with same ID exists
      if (!rdfStories.some(s => s.id === userStory.id)) {
        return [userStory, ...rdfStories];
      }
    }
    return rdfStories;
  })());
  let currentStory = $state<Story | null>(null);
  let storyStepIdx = $state(0);
  let storyAutoPlaying = $state(false);
  let storyAutoTimer: ReturnType<typeof setInterval> | null = null;
  let storyCountdown = $state(0);       // seconds remaining before next step
  let storyCountdownTimer: ReturnType<typeof setInterval> | null = null;
  let storySpeaking = $state(false);     // TTS currently speaking
  let showVolumeSlider = $state(false);  // toggle volume slider visibility
  type StoryMsg = { role: 'shelly' | 'user'; content: string; isStep?: boolean; stepIdx?: number };
  let storyMessages = $state<StoryMsg[]>([]);
  let storyInput = $state('');
  let storyLoading = $state(false);
  let storyErrorMsg = $state('');
  let storyListRef: HTMLDivElement | undefined;
  let storyDetoured = $state(false);

  $effect(() => {
    if (storyMessages.length && storyListRef) {
      setTimeout(() => storyListRef!.scrollTo({ top: storyListRef!.scrollHeight, behavior: 'smooth' }), 30);
    }
  });

  // Open story when storyId prop is set
  $effect(() => {
    if (storyId && tab !== 'explore') {
      tab = 'explore';
    }
    if (storyId && (!currentStory || currentStory.id !== storyId)) {
      const found = kbStories.find(s => s.id === storyId);
      if (found) {
        openStory(found);
        // Auto-play if requested (e.g. from "Getting started" button)
        if (storyAutoPlayRequested()) {
          clearStoryAutoPlay();
          setTimeout(() => toggleAutoPlay(), 100);
        }
      }
    }
  });

  function openStory(story: Story) {
    currentStory = story;
    storyStepIdx = 0;
    storyMessages = [];
    storyDetoured = false;
    storyAutoPlaying = false;
    clearCountdown();
    stopSpeaking();
    if (storyAutoTimer) { clearInterval(storyAutoTimer); storyAutoTimer = null; }
    // Play step 0 — voice plays only if user has explicitly enabled it
    playStoryStep(story, 0);
    tab = 'explore';
  }

  function playStoryStep(story: Story, idx: number) {
    if (idx >= story.steps.length) {
      storyMessages = [...storyMessages, {
        role: 'shelly',
        content: `That's the end of **${story.label}**! Switch to the **chat** tab to ask me anything, or pick another story.`
      }];
      stopAutoPlay();
      return;
    }
    const step = story.steps[idx];
    storyStepIdx = idx;
    storyDetoured = false;

    let msg = `### ${step.title}\n\n${step.content}`;
    if (step.question) msg += `\n\n> ${step.question}`;

    storyMessages = [...storyMessages, { role: 'shelly', content: msg, isStep: true, stepIdx: idx }];

    // Highlight entities — use focus layout when spotlighting a specific node
    if (step.highlights.length > 0) {
      applyShellyViewAdjust({
        selectEntity: step.highlights[0],
        spotlight: step.highlights,
        layout: step.highlights.length <= 2 ? 'focus' : undefined
      });
    }

    // Speak step via browser TTS when voice is enabled
    const ts = turtleSettings();
    if (ts.voiceEnabled) {
      speakText(`${step.title}. ${step.content}`);
    }
  }

  function storyNext() {
    if (!currentStory) return;
    stopSpeaking();
    const nextIdx = storyStepIdx + 1;
    playStoryStep(currentStory, nextIdx);
    if (storyAutoPlaying && nextIdx < currentStory.steps.length) startCountdown();
  }

  function storyPrev() {
    if (!currentStory || storyStepIdx <= 0) return;
    stopSpeaking();
    playStoryStep(currentStory, storyStepIdx - 1);
    if (storyAutoPlaying) startCountdown();
  }

  // ── TTS Engine (Kokoro streaming) ─────────────────────────────────────────
  import * as kokoro from '$lib/integrations/llm/kokoro-tts';

  let ttsBroken = $state(false);
  let stopCurrentSpeech: (() => void) | null = null;

  // Track Kokoro load status reactively
  let kokoroReady = $state(false);
  let kokoroLoadPct = $state(0);
  let kokoroPhase = $state<'download' | 'init'>('download');
  kokoro.onKokoroStatus((status, pct, phase) => {
    kokoroReady = status === 'ready';
    kokoroLoadPct = pct;
    kokoroPhase = phase;
  });

  // Start loading Kokoro when panel opens with voice enabled (lazy — no load on page mount)
  $effect(() => {
    if (turtleSettings().voiceEnabled && !kokoroReady) {
      kokoro.warmup();
    }
  });

  // ── Markdown → clean spoken text ────────────────────────────────────────
  function cleanForSpeech(raw: string): string {
    return raw
      .replace(/#{1,6}\s*(.*)/g, '$1.')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^>\s*/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/--/g, ', ')
      .replace(/^[-•*]\s+/gm, '')
      .replace(/^\d+[.)]\s+/gm, '')
      // Convert newlines to sentence breaks so TTS pauses naturally at paragraphs
      .replace(/\n{2,}/g, '.\n')
      .replace(/\n/g, '. ')
      .replace(/\.\s*\./g, '.')
      .trim();
  }

  // ── Main speak entry point (streaming) ──────────────────────────────────
  // Track pending speech request so stopSpeaking() can cancel a queued load
  let pendingSpeechId = 0;
  let speechQueued = $state(false); // true while waiting for Kokoro model to load

  function speakText(text: string): void {
    if (ttsBroken) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;

    stopSpeaking();

    if (!kokoroReady) {
      // Model still loading — freeze countdown until speech actually starts
      speechQueued = true;
      const myId = ++pendingSpeechId;
      kokoro.getReady()
        .then(() => { speechQueued = false; if (pendingSpeechId !== myId) return; startStreaming(clean); })
        .catch(() => { speechQueued = false; ttsBroken = true; });
      return;
    }

    startStreaming(clean);
  }

  function startStreaming(text: string): void {
    const ts = turtleSettings();
    const voice = ts.kokoroVoice || kokoro.DEFAULT_VOICE;

    stopCurrentSpeech = kokoro.speakStreaming(text, {
      voice,
      rate: ts.speechRate ?? 0.75,
      volume: Math.min((ts.volume ?? 75) / 100, 0.9),
      onStart: () => { storySpeaking = true; },
      onEnd: () => { storySpeaking = false; stopCurrentSpeech = null; },
      onError: (e) => {
        console.warn('[kokoro-tts] streaming failed:', e);
        ttsBroken = true;
        storySpeaking = false;
        stopCurrentSpeech = null;
      },
    });
  }

  function stopSpeaking() {
    if (stopCurrentSpeech) {
      stopCurrentSpeech();
      stopCurrentSpeech = null;
    }
    storySpeaking = false;
    speechQueued = false;
    pendingSpeechId++; // invalidate any queued getReady() callback
  }

  // ── Auto-play with countdown ───────────────────────────────────────────
  function startCountdown() {
    clearCountdown();
    const paceSec = currentStory?.pace ?? 40;
    storyCountdown = paceSec;
    storyCountdownTimer = setInterval(() => {
      if (storyDetoured || storyLoading || storySpeaking || speechQueued) return; // freeze during Q&A, TTS, or model loading
      storyCountdown--;
      if (storyCountdown <= 0) {
        clearCountdown();
        if (!currentStory || storyStepIdx >= currentStory.steps.length - 1) {
          stopAutoPlay();
          return;
        }
        storyNext();
        // Restart countdown for the next step
        if (storyAutoPlaying) startCountdown();
      }
    }, 1000);
  }

  function clearCountdown() {
    if (storyCountdownTimer) { clearInterval(storyCountdownTimer); storyCountdownTimer = null; }
    storyCountdown = 0;
  }

  let voiceConfirmPending = $state(false);

  function toggleAutoPlay() {
    if (storyAutoPlaying) {
      stopAutoPlay();
    } else {
      // If voice isn't enabled, ask before starting TTS (downloads ~87MB model)
      const ts = turtleSettings();
      if (!ts.voiceEnabled) {
        voiceConfirmPending = true;
        return;
      }
      startAutoPlay();
    }
  }

  function confirmVoice(enable: boolean) {
    voiceConfirmPending = false;
    if (enable) {
      updateTurtleSettings({ voiceEnabled: true, voiceType: 'tts' });
    }
    startAutoPlay();
  }

  function startAutoPlay() {
    storyAutoPlaying = true;
    if (!storySpeaking && turtleSettings().voiceEnabled) {
      const step = currentStory?.steps[storyStepIdx];
      if (step) {
        speakText(`${step.title}. ${step.content}`);
      }
    }
    startCountdown();
  }

  function stopAutoPlay() {
    storyAutoPlaying = false;
    clearCountdown();
    stopSpeaking();
    if (storyAutoTimer) { clearInterval(storyAutoTimer); storyAutoTimer = null; }
  }

  /** User asks a question during a story — Shelly answers in context, then resumes */
  async function sendStoryQuestion() {
    const text = storyInput.trim();
    if (!text || storyLoading || !currentStory) return;
    storyInput = '';
    storyDetoured = true;
    storyMessages = [...storyMessages, { role: 'user', content: text }];
    storyLoading = true;
    storyErrorMsg = '';

    const step = currentStory.steps[storyStepIdx];
    const contextPrefix = `The user is on step ${storyStepIdx + 1} of "${currentStory.label}": "${step?.title}". Step content: "${step?.content}". ${step?.prompt ? `Elaboration prompt: ${step.prompt}` : ''}\n\nAnswer the user's question in the context of this step and the KB. Be helpful but concise. After answering, remind them they can click "continue" to resume the story.`;

    const { provider, apiKey, model } = resolveChatProvider();
    const s = settings();

    try {
      const resp = await turtleChat({
        provider, apiKey, model,
        ollamaBaseUrl: s.ollamaBaseUrl,
        reckonsBaseUrl: s.reckonsBaseUrl,
        messages: [
          { role: 'user', content: contextPrefix },
          { role: 'user', content: text }
        ],
        kbContext: buildKBContext(),
        customPrompt: buildShellyPrompt()
      });
      storyMessages = [...storyMessages, { role: 'shelly', content: resp.message }];
    } catch (e) {
      handleChatError(e, provider);
      storyErrorMsg = errorMsg;
    } finally {
      storyLoading = false;
    }
  }

  function onStoryKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendStoryQuestion(); }
  }

  function resumeStory() {
    storyDetoured = false;
  }

  // ── Action acceptance ──────────────────────────────────────────────────────

  let dismissedActions = $state<Set<string>>(new Set());

  function actionKey(msgIdx: number, actionIdx: number) {
    return `${msgIdx}-${actionIdx}`;
  }

  async function acceptAction(action: KBAction, key: string) {
    const now = Date.now();
    try {
      // query_kb: run the query, inject results as next user message, send to Shelly
      if (action.type === 'query_kb') {
        dismissedActions = new Set([...dismissedActions, key]);
        const result = runKBQuery(action.filter);
        input = result;
        await sendMessage();
        return;
      }

      // scrape_url: trigger the ingestion pipeline for a URL
      if (action.type === 'scrape_url') {
        dismissedActions = new Set([...dismissedActions, key]);
        const { ingest } = await import('$lib/stores/ingest.svelte');
        try {
          const result = await ingest({ kind: 'url', url: action.url });
          const count = result.statements.length;
          input = `I scraped "${action.url}" and extracted ${count} triples. They've been added as pending statements for review.`;
          await sendMessage();
        } catch (e) {
          errorMsg = e instanceof Error ? e.message : String(e);
        }
        return;
      }

      // adjust_view and confirm_source don't create KB records — handle first
      if (action.type === 'adjust_view') {
        applyShellyViewAdjust({
          selectEntity: action.selectEntity,
          layout: action.layout,
          filters: action.filters
        });
        dismissedActions = new Set([...dismissedActions, key]);
        return;
      }

      if (action.type === 'confirm_source') {
        // Direct operation — mark source as trusted
        const { setSourceTrust } = await import('$lib/stores/kb.svelte');
        await setSourceTrust(action.sourceId, 'trusted');
        dismissedActions = new Set([...dismissedActions, key]);
        return;
      }

      // All other actions create KB records attributed to the Shelly session source
      const srcId = await ensureSessionSource();
      const g = { kind: 'iri' as const, value: `urn:kbase:source/${srcId}` };

      if (action.type === 'add_triple') {
        // User explicitly accepted in chat → write directly as confirmed
        const newStmt: Statement = {
          id: uuid(),
          s: { kind: 'iri', value: action.s },
          p: { kind: 'iri', value: action.p },
          o: action.o.startsWith('http') || action.o.startsWith('urn')
            ? { kind: 'iri', value: action.o }
            : { kind: 'literal', value: action.o },
          g,
          sourceId: srcId,
          confidence: 1.0,
          status: 'confirmed',
          gloss: action.label,
          createdAt: now,
          updatedAt: now
        };
        await addStatements([newStmt]);

      } else if (action.type === 'remove_triple') {
        // User explicitly accepted deletion → reject directly
        const match = statements().find(
          (s) =>
            s.s.kind === 'iri' && s.s.value === action.s &&
            s.p.value === action.p &&
            s.o.value === action.o &&
            s.status !== 'rejected' && s.status !== 'superseded'
        );
        if (match) await setStatus(match.id, 'rejected');

      } else if (action.type === 'set_type') {
        // User explicitly accepted type assignment → apply directly as confirmed
        const oldType = statements().find(
          (s) => s.s.value === action.entityIri && s.p.value === RDF_TYPE
          && s.status !== 'rejected' && s.status !== 'superseded'
        );
        if (oldType) await setStatus(oldType.id, 'rejected');

        const typeStmt: Statement = {
          id: uuid(),
          s: { kind: 'iri', value: action.entityIri },
          p: { kind: 'iri', value: RDF_TYPE },
          o: { kind: 'iri', value: action.typeIri },
          g,
          sourceId: srcId,
          confidence: 1.0,
          status: 'confirmed',
          gloss: `Set type to ${action.typeLabel}`,
          createdAt: now,
          updatedAt: now
        };
        await addStatements([typeStmt]);

      } else if (action.type === 'merge_entities') {
        // Merge queued in Review page because it requires redirecting all triples —
        // a multi-step operation the user must confirm with full context there.
        const mergeStmt: Statement = {
          id: uuid(),
          s: { kind: 'iri', value: action.keepEntityIri },
          p: { kind: 'iri', value: 'urn:kbase:meta/suggests-merge' },
          o: { kind: 'iri', value: action.dropEntityIri },
          g,
          sourceId: srcId,
          confidence: 1.0,
          status: 'pending',
          gloss: `Merge "${action.dropEntityLabel}" into "${action.keepEntityLabel}"`,
          createdAt: now,
          updatedAt: now
        };
        await addStatements([mergeStmt]);
      }

      dismissedActions = new Set([...dismissedActions, key]);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  function dismissAction(key: string) {
    dismissedActions = new Set([...dismissedActions, key]);
  }

  // ── Voice ──────────────────────────────────────────────────────────────────
  let showVoice = $state(false);
  const hasHume = $derived(!!settings().humeAiApiKey);
  let voiceVolume = $state(0);          // 0-1 mic volume from AnalyserNode
  let interimText = $state('');         // live interim transcript (clears on turn end)

  // ── Whisper local STT ────────────────────────────────────────────────────
  let whisperRecording = $state(false);
  let whisperTranscribing = $state(false);
  let whisperController: ReturnType<typeof import('$lib/integrations/llm/whisper-stt').startMicRecording> | null = null;

  async function toggleWhisperMic() {
    if (whisperRecording) {
      // Stop recording and transcribe
      if (!whisperController) return;
      whisperRecording = false;
      whisperTranscribing = true;
      try {
        const audio = await whisperController.stop();
        const { transcribe } = await import('$lib/integrations/llm/whisper-stt');
        const whisperModel = turtleSettings().whisperModel || 'onnx-community/whisper-tiny';
        const result = await transcribe(audio, whisperModel);
        if (result.text) {
          input = (input ? input + ' ' : '') + result.text;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== 'Recording cancelled') {
          errorMsg = `Whisper: ${msg}`;
        }
      } finally {
        whisperTranscribing = false;
        whisperController = null;
      }
    } else {
      // Start recording
      const { startMicRecording } = await import('$lib/integrations/llm/whisper-stt');
      const { registerWhisperConsent } = await import('$lib/stores/download-consent.svelte');
      await registerWhisperConsent();
      whisperController = startMicRecording();
      whisperRecording = true;
    }
  }

  function handleVoiceMessage(role: 'user' | 'assistant', content: string, actions?: import('$lib/types/turtle-chat').KBAction[]) {
    messages = [...messages, { role, content, actions: actions ?? [] }];
    tick().then(() => { if (msgListRef) msgListRef.scrollTop = msgListRef.scrollHeight; });
  }

  // ── Markdown-lite renderer ─────────────────────────────────────────────────
  function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMarkdown(text: string): string {
    // 1. Extract fenced code blocks with their content properly escaped
    const blocks: string[] = [];
    text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
      const idx = blocks.push(`<pre><code>${escHtml(code.trimEnd())}</code></pre>`) - 1;
      return `\x00CODE${idx}\x00`;
    });

    // 2. HTML-escape the remaining text so LLM output can't inject markup
    text = escHtml(text);

    // 3. Apply safe inline markdown on already-escaped text
    text = text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/✓ /g, '<span class="check">✓ </span>')
      .replace(/\n/g, '<br>');

    // 4. Restore code blocks
    return text.replace(/\x00CODE(\d+)\x00/g, (_, i) => blocks[+i]);
  }

</script>

<Tabs.Root
  value={tab}
  onValueChange={(v) => {
    // Auto-pause story when navigating away from explore tab
    if (tab === 'explore' && v !== 'explore' && currentStory && storyAutoPlaying) {
      stopAutoPlay();
    }
    tab = v as Tab;
    if (v === 'explore' && !exploreStarted) {
      exploreStarted = true;
      sendExploreMessage(null);
    }
  }}
>
<SnapPanel corner="bottom-left" width={360} minWidth={240} maxWidth={800} zIndex={350}
  extraStyle={voiceVolume > 0.05 ? `box-shadow: 0 0 ${8 + voiceVolume * 28}px ${2 + voiceVolume * 10}px color-mix(in srgb, #4caf50 ${Math.round(voiceVolume * 55)}%, transparent)` : ''}
>
  {#snippet header()}
    <div class="panel-header">
      <img src="/svg/head1.svg" alt="" class="turtle-icon" />
      <Tabs.List class="tcp-tab-list">
        <Tabs.Trigger value="tutorial" class="tcp-tab">learn</Tabs.Trigger>
        <Tabs.Trigger value="chat" class="tcp-tab">chat</Tabs.Trigger>
        <Tabs.Trigger value="explore" class="tcp-tab">explore</Tabs.Trigger>
      </Tabs.List>
      <button class="close" onclick={onclose} aria-label="close">✕</button>
    </div>
  {/snippet}

  <!-- ── Tutorial tab ── -->
  <Tabs.Content value="tutorial" class="tcp-tab-content">
    <div class="tutorial">
      {#if isEmptyKB}
        <div class="starter-section">
          <p class="starter-heading mono">pick a starter graph</p>
          <div class="starter-grid">
            {#each ONBOARDING_TEMPLATES as tmpl}
              <button
                class="starter-card"
                class:loading={loadingStarter === tmpl.id}
                onclick={() => loadStarterTemplate(tmpl.id)}
                disabled={loadingStarter !== null}
                title={tmpl.description}
              >
                <span class="starter-icon">{tmpl.icon}</span>
                <span class="starter-label">{tmpl.label}</span>
                {#if loadingStarter === tmpl.id}
                  <span class="starter-loading mono">…</span>
                {/if}
              </button>
            {/each}
            <button
              class="starter-card starter-blank"
              onclick={() => loadStarterTemplate('blank')}
              disabled={loadingStarter !== null}
              title={BLANK_TEMPLATE.description}
            >
              <span class="starter-icon">{BLANK_TEMPLATE.icon}</span>
              <span class="starter-label">import own</span>
            </button>
          </div>
          <div class="starter-divider"></div>
        </div>
      {/if}

      <div class="step-body">
        <h3 class="step-title">{currentStep.title}</h3>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        <div class="step-content">{@html renderMarkdown(currentStep.body)}</div>
      </div>

      <div class="step-nav">
        <div class="step-dots">
          {#each STEPS as _, i}
            <button
              class="dot"
              class:active={i === tutorialStep}
              onclick={() => (tutorialStep = i)}
              aria-label={`step ${i + 1}`}
            ></button>
          {/each}
        </div>
        <div class="step-buttons">
          {#if tutorialStep > 0}
            <button onclick={() => (tutorialStep -= 1)}>← back</button>
          {/if}
          {#if !isLastStep}
            <button class="primary" onclick={() => (tutorialStep += 1)}>next →</button>
          {:else}
            <button class="primary" onclick={() => (tab = 'chat')}>start chatting →</button>
          {/if}
        </div>
      </div>
    </div>
  </Tabs.Content>

  <!-- ── Chat tab ── -->
  <Tabs.Content value="chat" class="tcp-tab-content">
    <div class="chat">
      <div class="msg-list" bind:this={msgListRef}>
        {#if messages.length === 0}
          <div class="intro">
            {#if isEmptyKB}
              <p>Hi! I'm Shelly <img src="/svg/head1.svg" alt="" class="msg-icon" style="display:inline;vertical-align:middle" /></p>
              <p>Your knowledge base is empty. Load a starter graph to explore, or import your own content:</p>
              <div class="starter-grid">
                {#each ONBOARDING_TEMPLATES as tmpl}
                  <button
                    class="starter-card"
                    class:loading={loadingStarter === tmpl.id}
                    onclick={() => loadStarterTemplate(tmpl.id)}
                    disabled={loadingStarter !== null}
                    title={tmpl.description}
                  >
                    <span class="starter-icon">{tmpl.icon}</span>
                    <span class="starter-label">{tmpl.label}</span>
                    {#if loadingStarter === tmpl.id}<span class="starter-loading mono">…</span>{/if}
                  </button>
                {/each}
                <button class="starter-card starter-blank" onclick={() => loadStarterTemplate('blank')} disabled={loadingStarter !== null}>
                  <span class="starter-icon">{BLANK_TEMPLATE.icon}</span>
                  <span class="starter-label">import own</span>
                </button>
              </div>
              <p class="intro-or mono">— or ask me anything —</p>
            {:else}
              <p>Hi! I'm Shelly <img src="/svg/head1.svg" alt="" class="msg-icon" style="display:inline;vertical-align:middle" /></p>
              <p>Ask me anything about your KB, or say things like:</p>
              <ul>
                <li>"What types of entities do I have?"</li>
                <li>"Add a relation between coffee and caffeine"</li>
                <li>"What is the Turtle format?"</li>
              </ul>
            {/if}
          </div>
        {/if}

        {#each messages as msg, msgIdx}
          <div class="msg" class:user={msg.role === 'user'} class:assistant={msg.role === 'assistant'} class:voice-msg={'_voice' in msg && msg._voice}>
            {#if msg.role === 'assistant'}
              <img src="/svg/head1.svg" alt="" class="msg-icon" />
            {/if}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="msg-body">{@html renderMarkdown(msg.content)}</div>

            {#if msg.actions && msg.actions.length > 0}
              <div class="actions">
                {#each msg.actions as action, aIdx}
                  {@const key = actionKey(msgIdx, aIdx)}
                  {#if !dismissedActions.has(key)}
                    <div class="action-card"
                      class:action-danger={action.type === 'remove_triple'}
                      class:action-merge={action.type === 'merge_entities'}
                    >
                      {#if action.type === 'add_triple'}
                        <span class="action-badge">add triple</span>
                        <span class="action-desc">{action.label}</span>
                      {:else if action.type === 'remove_triple'}
                        <span class="action-badge badge-danger">remove triple</span>
                        <span class="action-desc">{action.label}</span>
                      {:else if action.type === 'set_type'}
                        <span class="action-badge">set type</span>
                        <span class="action-desc">{action.entityLabel} → {action.typeLabel}</span>
                      {:else if action.type === 'merge_entities'}
                        <span class="action-badge badge-merge">merge entities</span>
                        <span class="action-desc merge-desc">
                          <span class="drop-entity">{action.dropEntityLabel}</span>
                          <span class="merge-arrow">→</span>
                          <span class="keep-entity">{action.keepEntityLabel}</span>
                        </span>
                        <span class="action-hint">all triples from "{action.dropEntityLabel}" will move to "{action.keepEntityLabel}"</span>
                      {:else if action.type === 'confirm_source'}
                        <span class="action-badge">confirm source</span>
                        <span class="action-desc">{action.sourceTitle}</span>
                      {:else if action.type === 'adjust_view'}
                        <span class="action-badge badge-nav">navigate</span>
                        <span class="action-desc">{action.label}</span>
                        {#if action.layout || action.filters?.length}
                          <span class="action-hint">
                            {[action.layout ? `layout: ${action.layout}` : '', action.filters?.length ? `filters: ${action.filters.join(', ')}` : ''].filter(Boolean).join(' · ')}
                          </span>
                        {/if}
                      {:else if action.type === 'query_kb'}
                        <span class="action-badge badge-query">query KB</span>
                        <span class="action-desc">{action.label}</span>
                        <span class="action-hint">runs filter and returns results so I can help with next steps</span>
                      {:else if action.type === 'scrape_url'}
                        <span class="action-badge badge-scrape">scrape URL</span>
                        <span class="action-desc">{action.label}</span>
                        <span class="action-hint">{action.url}</span>
                      {/if}
                      <div class="action-btns">
                        <button class="primary sm" onclick={() => acceptAction(action, key)}>
                          {action.type === 'query_kb' ? 'run' : action.type === 'scrape_url' ? 'scrape' : 'accept'}
                        </button>
                        <button class="sm" onclick={() => dismissAction(key)}>dismiss</button>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}

        {#if loading}
          <div class="msg assistant">
            <img src="/svg/head1.svg" alt="" class="msg-icon" />
            <div class="msg-body thinking">
              <span></span><span></span><span></span>
            </div>
          </div>
        {/if}

        {#if interimText}
          <div class="msg user interim-msg">
            <div class="msg-body interim-body">{interimText}<span class="interim-cursor">|</span></div>
          </div>
        {/if}
      </div>

      {#if errorMsg}
        <p class="error">
          {errorMsg}
          {#if errorLink}
            <a href={errorLink.href} class="error-link">{errorLink.label}</a>
          {/if}
        </p>
      {/if}

      {#if isWasmProvider && wasmStatus() !== 'ready'}
        <div class="wasm-status" class:wasm-error={wasmStatus() === 'error'}>
          {#if wasmStatus() === 'error'}
            <span class="wasm-label">model error: {wasmStatusText()}</span>
          {:else}
            <span class="wasm-label">
              {wasmStatus() === 'idle' ? 'wasm model not loaded' : wasmStatusText() || 'loading model…'}
            </span>
            <div class="wasm-bar-track">
              {#if wasmPct() > 0}
                <div class="wasm-bar-fill" style="width: {wasmPct()}%"></div>
              {:else if wasmStatus() === 'loading'}
                <div class="wasm-bar-fill wasm-bar-pulse"></div>
              {/if}
            </div>
            {#if wasmPct() > 0}
              <span class="wasm-pct">{wasmPct()}%</span>
            {/if}
          {/if}
        </div>
      {/if}

      <div class="input-row">
        <textarea
          bind:value={input}
          onkeydown={onKeydown}
          placeholder="ask shelly…"
          rows="2"
          disabled={loading || (isWasmProvider && wasmStatus() === 'loading')}
        ></textarea>
        <button class="send primary" onclick={sendMessage} disabled={loading || !input.trim() || (isWasmProvider && wasmStatus() === 'loading')}>
          ↑
        </button>
        {#if hasHume}
          <ShellyVoice
            onclose={() => {}}
            onmessage={handleVoiceMessage}
            oninterim={(t) => { interimText = t; tick().then(() => { if (msgListRef) msgListRef.scrollTop = msgListRef.scrollHeight; }); }}
            onvolume={(v) => { voiceVolume = v; }}
          />
        {:else}
          <button
            class="mic-btn"
            class:recording={whisperRecording}
            class:transcribing={whisperTranscribing}
            onclick={toggleWhisperMic}
            disabled={whisperTranscribing || loading}
            title={whisperRecording ? 'Stop recording' : whisperTranscribing ? 'Transcribing...' : 'Voice input (Whisper)'}
          >
            {whisperTranscribing ? '...' : whisperRecording ? '■' : '🎤'}
          </button>
        {/if}
      </div>
    </div>
  </Tabs.Content>

  <!-- ── Explore tab (stories + LLM tour) ── -->
  <Tabs.Content value="explore" class="tcp-tab-content">
    {#if currentStory}
      <!-- Story playback -->
      <div class="chat">
        <div class="msg-list" bind:this={storyListRef}>
          {#each storyMessages as msg, i (i)}
            {#if msg.role === 'shelly'}
              <div class="msg assistant" class:step-msg={msg.isStep}>
                <img src="/svg/head1.svg" alt="" class="msg-icon" />
                <div class="msg-body">{@html renderMarkdown(msg.content)}</div>
              </div>
            {:else}
              <div class="msg user">
                <div class="msg-body">{@html renderMarkdown(msg.content)}</div>
              </div>
            {/if}
          {/each}

          {#if storyLoading}
            <div class="msg assistant">
              <img src="/svg/head1.svg" alt="" class="msg-icon" />
              <div class="msg-body thinking"><span></span><span></span><span></span></div>
            </div>
          {/if}

          {#if storyErrorMsg}
            <p class="error">
              {storyErrorMsg}
              {#if errorLink}
                <a href={errorLink.href} class="error-link">{errorLink.label}</a>
              {/if}
            </p>
          {/if}
        </div>

        <div class="story-footer">
          <!-- Progress bar -->
          <div class="story-progress">
            <div class="story-progress-bar" style="width: {(() => {
              const total = currentStory.steps.length;
              if (total === 0) return 0;
              const basePct = (storyStepIdx / total) * 100;
              const stepFrac = (1 / total) * 100;
              const withinStep = storyAutoPlaying && storyCountdown > 0 && currentStory.pace > 0
                ? (1 - storyCountdown / currentStory.pace) * stepFrac
                : stepFrac;
              return basePct + withinStep;
            })()}%"></div>
          </div>
          {#if voiceConfirmPending}
            <div class="voice-confirm">
              <span class="voice-confirm-text">Enable voice narration? Downloads ~87 MB on first use.</span>
              <div class="voice-confirm-btns">
                <button class="primary sm" onclick={() => confirmVoice(true)}>Enable voice</button>
                <button class="sm" onclick={() => confirmVoice(false)}>No, just auto-advance</button>
              </div>
            </div>
          {/if}
          <div class="story-controls">
            <span class="story-step-label mono">{storyStepIdx + 1} / {currentStory.steps.length}</span>
            <div class="story-nav">
              <button class="story-btn" onclick={storyPrev} disabled={storyStepIdx <= 0 || storyLoading} title="Previous step">←</button>
              <button class="story-btn" class:active={storyAutoPlaying} onclick={toggleAutoPlay} disabled={storyLoading} title={storyAutoPlaying ? 'Pause' : 'Auto-play'}>
                {storyAutoPlaying ? '⏸' : '▶'}
              </button>
              <button class="story-btn" onclick={storyNext} disabled={storyStepIdx >= currentStory.steps.length - 1 || storyLoading} title="Next step">→</button>
            </div>
            <div class="story-audio">
              {#if ttsBroken}
                <a href="/settings/turtle" class="tts-broken-hint mono">try Hume.AI voice</a>
              {:else if turtleSettings().voiceEnabled && !kokoroReady}
                <span class="tts-loading mono" title="Downloading Kokoro voice model — first time only">{kokoroPhase === 'init' ? 'starting voice…' : kokoroLoadPct > 0 ? `voice ${kokoroLoadPct}%` : 'loading voice…'}</span>
              {:else}
                <button
                  class="story-btn story-voice-toggle"
                  class:muted={!turtleSettings().voiceEnabled}
                  onclick={() => {
                    const ts = turtleSettings();
                    if (!ts.voiceEnabled) {
                      ttsBroken = false;
                      updateTurtleSettings({ voiceEnabled: true, voiceType: 'tts' });
                    } else {
                      updateTurtleSettings({ voiceEnabled: false });
                      stopSpeaking();
                    }
                  }}
                  title={turtleSettings().voiceEnabled ? 'Mute voice' : 'Enable voice'}
                >
                  ♪
                </button>
                <button class="story-btn story-vol-toggle" onclick={() => showVolumeSlider = !showVolumeSlider} title={kokoroReady ? 'Volume · Kokoro' : kokoroPhase === 'init' ? 'Volume · starting voice…' : 'Volume · loading voice model...'}>
                  {turtleSettings().voiceEnabled ? '🔊' : '🔇'}
                </button>
              {/if}
            </div>
            {#if storyAutoPlaying && storyCountdown > 0}
              <span class="story-timer mono" class:speaking={storySpeaking}>
                {storyCountdown}s
              </span>
            {/if}
            <button class="story-btn story-exit" onclick={() => { stopAutoPlay(); stopStory(); currentStory = null; }} title="Exit story">✕</button>
          </div>
          {#if showVolumeSlider}
            <div class="story-volume-row">
              <span class="vol-label mono">vol</span>
              <input
                type="range"
                min="0"
                max="100"
                value={turtleSettings().volume ?? 75}
                oninput={(e) => updateTurtleSettings({ volume: +(e.target as HTMLInputElement).value })}
                class="vol-slider"
              />
              <span class="vol-val mono">{turtleSettings().volume ?? 75}</span>
            </div>
          {/if}

          <!-- Q&A input -->
          <div class="input-row">
            <textarea
              bind:value={storyInput}
              onkeydown={onStoryKeydown}
              placeholder="ask about this step…"
              rows="2"
              disabled={storyLoading}
            ></textarea>
            <button class="send primary" onclick={sendStoryQuestion} disabled={storyLoading || !storyInput.trim()}>
              ↑
            </button>
          </div>
          {#if storyDetoured}
            <button class="story-resume" onclick={resumeStory}>
              continue story →
            </button>
          {/if}
        </div>
      </div>
    {:else}
      <!-- Story picker + LLM explore -->
      <div class="chat">
        {#if kbStories.length > 0}
          <div class="explore-stories">
            <p class="explore-stories-label mono">stories</p>
            <div class="explore-story-chips">
              {#each kbStories as story (story.id)}
                <button class="explore-story-chip" onclick={() => openStory(story)}>
                  <span class="chip-title">{story.label}</span>
                  <span class="chip-meta mono">{story.steps.length} steps</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="msg-list" bind:this={exploreListRef}>
          {#if exploreMessages.length === 0 && exploreLoading}
            <div class="msg assistant">
              <img src="/svg/head1.svg" alt="" class="msg-icon" />
              <div class="msg-body thinking"><span></span><span></span><span></span></div>
            </div>
          {/if}

          {#each exploreMessages as msg, i (i)}
            {#if msg.role === 'shelly'}
              <div class="msg assistant">
                <img src="/svg/head1.svg" alt="" class="msg-icon" />
                <div class="msg-body">{@html renderMarkdown(msg.content)}</div>
              </div>
            {:else}
              <div class="msg user">
                <div class="msg-body">{@html renderMarkdown(msg.content)}</div>
              </div>
            {/if}
          {/each}

          {#if exploreLoading && exploreMessages.length > 0}
            <div class="msg assistant">
              <img src="/svg/head1.svg" alt="" class="msg-icon" />
              <div class="msg-body thinking"><span></span><span></span><span></span></div>
            </div>
          {/if}

          {#if exploreErrorMsg}
            <p class="error">
              {exploreErrorMsg}
              {#if errorLink}
                <a href={errorLink.href} class="error-link">{errorLink.label}</a>
              {/if}
            </p>
          {/if}
        </div>

        <div class="explore-footer">
          <div class="input-row">
            <textarea
              bind:value={exploreInput}
              onkeydown={onExploreKeydown}
              placeholder="answer or ask Shelly…"
              rows="2"
              disabled={exploreLoading}
            ></textarea>
            <button class="send primary" onclick={sendExploreInput} disabled={exploreLoading || !exploreInput.trim()}>
              ↑
            </button>
          </div>
          <button class="next-stop" onclick={() => sendExploreMessage('Continue to the next stop.')} disabled={exploreLoading}>
            next stop →
          </button>
        </div>
      </div>
    {/if}
  </Tabs.Content>
</SnapPanel>
</Tabs.Root>


<style>
  /* ── Header ── */
  .panel-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--line);
    background: rgba(26, 155, 142, 0.08);
    cursor: grab; /* drag handle for SnapPanel */
    user-select: none;
  }
  .turtle-icon { height: 1.1rem; width: auto; }
  :global(.tcp-tab-list) {
    display: flex;
    gap: 0.2rem;
    flex: 1;
  }
  :global(.tcp-tab) {
    padding: 0.25rem 0.65rem;
    font-size: 0.7rem;
    font-family: var(--font-mono);
    text-transform: lowercase;
    border-radius: 999px;
    border: 1px solid transparent;
    color: var(--muted);
    background: none;
    cursor: pointer;
    transition: all 0.15s;
  }
  :global(.tcp-tab[data-state="active"]) {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  :global(.tcp-tab-content) {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  :global(.tcp-tab-content[hidden]) {
    display: none;
  }
  .close {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.2rem 0.4rem;
    border-radius: var(--rad-sm);
    transition: color 0.15s;
  }
  .close:hover { color: var(--ink); }

  /* ── Interim transcript bubble ── */
  .interim-msg { opacity: 0.65; }
  .interim-body { font-style: italic; }
  .interim-cursor {
    display: inline-block;
    width: 1px;
    height: 0.9em;
    background: currentColor;
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }

  /* ── Tutorial ── */
  .tutorial {
    display: flex;
    flex-direction: column;
    min-height: 380px;
    max-height: 65vh;
  }

  /* ── Starter templates (shown when KB is empty) ── */
  .starter-section {
    padding: 0.75rem 1rem 0;
  }
  .starter-heading {
    font-size: 0.65rem;
    color: var(--accent);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0 0 0.5rem;
  }
  .starter-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
  }
  .starter-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    padding: 0.45rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm, 6px);
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s, background 0.12s;
    min-width: 58px;
  }
  .starter-card:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .starter-card:disabled { opacity: 0.5; cursor: default; }
  .starter-card.starter-blank { border-style: dashed; opacity: 0.7; }
  .starter-card.starter-blank:hover:not(:disabled) { opacity: 1; border-style: solid; }
  .starter-icon { font-size: 1.2rem; line-height: 1; }
  .starter-label {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    color: var(--muted);
    text-align: center;
    letter-spacing: 0.03em;
  }
  .starter-loading {
    font-size: 0.6rem;
    color: var(--accent);
  }
  .starter-divider {
    height: 1px;
    background: var(--line);
    margin: 0.75rem 0 0;
  }
  .intro-or {
    font-size: 0.65rem;
    color: var(--muted);
    text-align: center;
    margin: 0.6rem 0 0.2rem;
  }
  .step-body {
    flex: 1;
    padding: 1rem 1.1rem 0.5rem;
    overflow-y: auto;
  }
  .step-title {
    font-size: 0.95rem;
    color: var(--accent);
    margin: 0 0 0.6rem;
    font-family: var(--font-display);
  }
  .step-content {
    font-size: 0.82rem;
    line-height: 1.55;
    color: var(--ink-2);
  }
  :global(.step-content code) {
    font-family: var(--font-mono);
    font-size: 0.74rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.15rem 0.35rem;
    color: var(--data);
    display: block;
    margin: 0.4rem 0;
    white-space: pre-wrap;
  }
  :global(.step-content strong) { color: var(--ink); }
  :global(.step-content .check) { color: var(--ok); }

  .step-nav {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .step-dots { display: flex; gap: 0.3rem; }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    border: none;
    background: var(--line);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s;
  }
  .dot.active { background: var(--accent); }
  .step-buttons { display: flex; gap: 0.4rem; }
  .step-buttons button { font-size: 0.78rem; padding: 0.35rem 0.8rem; }

  /* ── Chat ── */
  .chat {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  .msg-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-height: 0;
  }
  .intro {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.5rem;
  }
  .intro p { margin: 0 0 0.4rem; }
  .intro ul { margin: 0; padding-left: 1.2rem; }
  .intro li { margin: 0.15rem 0; }

  .msg {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .msg.user { align-items: flex-end; }
  .msg.assistant { align-items: flex-start; }
  .msg-icon { height: 0.9rem; width: auto; flex-shrink: 0; }

  .msg-body {
    max-width: 88%;
    font-size: 0.8rem;
    line-height: 1.45;
    padding: 0.5rem 0.75rem;
    border-radius: var(--rad-sm);
    border-radius: 12px;
  }
  .msg.user .msg-body {
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--ink);
    border-radius: 12px 12px 2px 12px;
  }
  .msg.assistant .msg-body {
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--ink-2);
    border-radius: 2px 12px 12px 12px;
  }
  :global(.step-content pre),
  :global(.msg-body pre) {
    background: var(--surface-3, var(--surface-2));
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.6rem 0.75rem;
    margin: 0.5rem 0;
    overflow-x: auto;
    white-space: pre;
  }
  :global(.step-content pre code),
  :global(.msg-body pre code) {
    background: none;
    border: none;
    padding: 0;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--data);
    display: block;
    white-space: pre;
  }
  :global(.msg-body code) {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    background: var(--surface-3);
    border-radius: 3px;
    padding: 0.1rem 0.3rem;
    color: var(--data);
  }
  :global(.msg-body strong) { color: var(--ink); }

  /* Typing indicator */
  .thinking {
    display: flex;
    gap: 4px;
    align-items: center;
    height: 1.2rem;
  }
  .thinking span {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: bounce 1.1s infinite;
  }
  .thinking span:nth-child(2) { animation-delay: 0.18s; }
  .thinking span:nth-child(3) { animation-delay: 0.36s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
    40% { transform: translateY(-5px); opacity: 1; }
  }

  /* Action cards */
  .actions { display: flex; flex-direction: column; gap: 0.35rem; width: 100%; }
  .action-card {
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .action-badge {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
  }
  .badge-danger { color: var(--danger); }
  .badge-merge { color: var(--data); }
  .badge-nav { color: var(--accent); }
  .badge-query { color: var(--ok, #4caf50); }
  .badge-scrape { color: #63b3ed; }

  .action-danger {
    border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
    background: color-mix(in srgb, var(--danger) 6%, var(--surface));
  }
  .action-merge {
    border-color: color-mix(in srgb, var(--data) 40%, var(--line));
    background: color-mix(in srgb, var(--data) 6%, var(--surface));
  }

  .action-desc { font-size: 0.78rem; color: var(--ink-2); }
  .merge-desc { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
  .drop-entity { color: var(--danger); font-weight: 600; }
  .keep-entity { color: var(--data); font-weight: 600; }
  .merge-arrow { color: var(--muted); }
  .action-hint { font-size: 0.66rem; color: var(--muted); font-style: italic; }
  .action-btns { display: flex; gap: 0.35rem; margin-top: 0.1rem; }
  button.sm { padding: 0.25rem 0.6rem; font-size: 0.72rem; }

  /* Input area */
  .error {
    font-size: 0.74rem;
    color: var(--danger);
    padding: 0 0.75rem;
    margin: 0;
  }
  .error-link {
    display: inline-block;
    margin-left: 0.25rem;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .wasm-status {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--line);
    background: rgba(26, 155, 142, 0.06);
  }
  .wasm-status.wasm-error { background: rgba(239, 68, 68, 0.06); }
  .wasm-label {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--muted);
  }
  .wasm-error .wasm-label { color: var(--danger); }
  .wasm-bar-track {
    height: 3px;
    background: var(--surface-3);
    border-radius: 999px;
    overflow: hidden;
  }
  .wasm-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.4s ease-out;
  }
  .wasm-bar-pulse {
    width: 40%;
    animation: wasm-pulse 1.4s ease-in-out infinite;
  }
  @keyframes wasm-pulse {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }
  .wasm-pct {
    font-size: 0.65rem;
    font-family: var(--font-mono);
    color: var(--accent);
    text-align: right;
  }
  .input-row {
    padding: 0.6rem 0.75rem;
    border-top: 1px solid var(--line);
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }
  .input-row textarea {
    flex: 1;
    resize: none;
    font-size: 0.82rem;
    line-height: 1.4;
    padding: 0.45rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    font-family: var(--font-body);
    transition: border-color 0.15s;
  }
  .input-row textarea:focus { outline: none; border-color: var(--accent); }
  .send {
    padding: 0.45rem 0.75rem;
    font-size: 1rem;
    line-height: 1;
    border-radius: var(--rad-sm);
    align-self: flex-end;
  }

  .mic-btn {
    padding: 0.45rem 0.55rem;
    font-size: 0.85rem;
    line-height: 1;
    border-radius: var(--rad-sm);
    align-self: flex-end;
    background: var(--surface-2);
    border: 1px solid var(--line);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .mic-btn:hover { background: var(--surface-3); }
  .mic-btn.recording {
    background: color-mix(in srgb, var(--danger, #ef4444) 15%, var(--surface));
    border-color: var(--danger, #ef4444);
    color: var(--danger, #ef4444);
    animation: mic-pulse 1s infinite;
  }
  .mic-btn.transcribing {
    opacity: 0.6;
    cursor: wait;
  }
  @keyframes mic-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  /* ── Explore tab ── */
  .explore-footer {
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .explore-footer .input-row {
    border-top: none;
  }
  .next-stop {
    margin: 0 0.75rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    color: var(--accent);
    padding: 0.35rem 0.6rem;
    font-size: 0.7rem;
    font-family: var(--font-mono);
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: background 0.12s;
  }
  .next-stop:not(:disabled):hover { background: var(--accent-soft); }
  .next-stop:disabled { opacity: 0.35; cursor: not-allowed; }

  /* ── Story tab ── */
  /* ── Explore story chips ── */
  .explore-stories {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  .explore-stories-label {
    font-size: 0.58rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.35rem;
  }
  .explore-story-chips {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .explore-story-chip {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.55rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .explore-story-chip:hover {
    border-color: var(--data);
    background: var(--data-soft);
  }
  .chip-title {
    font-size: 0.72rem;
    color: var(--ink-2);
  }
  .chip-meta {
    font-size: 0.55rem;
    color: var(--muted);
  }

  .step-msg .msg-body {
    border-left: 2px solid var(--data);
    padding-left: 0.5rem;
  }

  .story-footer {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0 0;
    border-top: 1px solid var(--line);
  }
  .story-progress {
    height: 3px;
    background: var(--surface-3);
    border-radius: 2px;
    overflow: hidden;
  }
  .story-progress-bar {
    height: 100%;
    background: var(--data);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .voice-confirm {
    background: var(--surface-2);
    border: 1px solid var(--accent-soft);
    border-radius: var(--rad);
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.5rem;
    text-align: center;
  }
  .voice-confirm-text {
    font-size: 0.74rem;
    color: var(--muted);
    display: block;
    margin-bottom: 0.4rem;
  }
  .voice-confirm-btns {
    display: flex;
    gap: 0.4rem;
    justify-content: center;
  }
  .story-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .story-step-label {
    font-size: 0.62rem;
    color: var(--muted);
    letter-spacing: 0.05em;
  }
  .story-nav {
    display: flex;
    gap: 0.2rem;
  }
  .story-btn {
    padding: 0.25rem 0.5rem;
    font-size: 0.72rem;
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
  }
  .story-btn:not(:disabled):hover {
    color: var(--ink);
    border-color: var(--data);
  }
  .story-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .story-btn.active {
    background: var(--data-soft);
    border-color: var(--data);
    color: var(--data);
  }
  .story-timer {
    font-size: 0.6rem;
    color: var(--muted);
    min-width: 2.2rem;
    text-align: center;
  }
  .story-timer.speaking {
    color: var(--data);
  }
  .story-exit {
    margin-left: auto;
    font-size: 0.65rem;
    color: var(--muted);
  }
  .story-resume {
    padding: 0.35rem 0.75rem;
    background: var(--data-soft);
    border: 1px solid var(--data);
    border-radius: var(--rad-sm);
    color: var(--data);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 0.12s;
  }
  .story-resume:hover {
    background: color-mix(in srgb, var(--data) 20%, var(--surface));
  }
  .story-audio {
    display: flex;
    gap: 0.15rem;
    align-items: center;
  }
  .story-btn.muted {
    opacity: 0.5;
  }
  .tts-broken-hint {
    font-size: 0.65rem;
    color: var(--accent);
    padding: 0.15rem 0.4rem;
    text-decoration: none;
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    opacity: 0.8;
    transition: opacity 0.15s;
  }
  .tts-broken-hint:hover { opacity: 1; }
  .tts-loading {
    font-size: 0.6rem;
    color: var(--data);
    padding: 0.1rem 0.35rem;
    opacity: 0.8;
    animation: tts-pulse 1.5s ease-in-out infinite;
  }
  @keyframes tts-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
  .story-vol-toggle {
    font-size: 0.65rem;
  }
  .story-volume-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.5rem;
  }
  .vol-label {
    font-size: 0.58rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .vol-slider {
    flex: 1;
    height: 3px;
    accent-color: var(--data);
    cursor: pointer;
  }
  .vol-val {
    font-size: 0.6rem;
    color: var(--muted);
    min-width: 1.6rem;
    text-align: right;
  }
</style>
