<script lang="ts">
  /**
   * ShellyVoice — Hume.AI EVI voice interface for Shelly.
   *
   * Emits callbacks instead of owning UI, so TurtleChatPanel can:
   *   - Show messages inline in the chat list
   *   - Pulse the panel with mic volume
   *   - Display streaming interim transcripts
   *
   * Audio pipeline:
   *   Mic → AnalyserNode (volume) + MediaRecorder (chunks) → EVI (STT)
   *   EVI user_message (interim) → oninterim(text)
   *   EVI user_message (final)   → pauseAssistant → turtleChat → sendAssistantInput (TTS)
   *   onmessage('user', transcript) + onmessage('assistant', reply, actions)
   *   EVI audio_output → EVIWebAudioPlayer → speakers
   */
  import { onDestroy } from 'svelte';
  // hume SDK is lazy-loaded on first connect so it doesn't add to the initial bundle
  // for users who never use voice. The ~300KB chunk fetches only when connect() is called.
  import { settings } from '$lib/stores/settings.svelte';
  import { turtleSettings } from '$lib/stores/turtle-settings.svelte';
  import { turtleChat, resolveChatProvider, type TurtleChatProvider } from '$lib/integrations/llm/turtle-chat';
  import { confirmedStatements, statements, sources, addStatements, addSource, setStatus } from '$lib/stores/kb.svelte';
  import { typeMap } from '$lib/stores/entity-types.svelte';
  import { applyShellyViewAdjust } from '$lib/stores/shelly-bridge.svelte';
  import { RDF_TYPE } from '$lib/rdf/entity-types';
  import type { KBContext, KBAction } from '$lib/types/turtle-chat';
  import type { Statement, Source } from '$lib/rdf/types';
  import { v4 as uuid } from 'uuid';

  let {
    onclose = () => {},
    onmessage = undefined,
    oninterim = undefined,
    onvolume = undefined,
  } = $props<{
    onclose?: () => void;
    /** Completed turn: push into the chat message list. */
    onmessage?: (role: 'user' | 'assistant', content: string, actions?: KBAction[]) => void;
    /** Interim transcript — update a live preview bubble. */
    oninterim?: (text: string) => void;
    /** Mic volume 0–1, ~30 fps, drive panel pulsing. */
    onvolume?: (level: number) => void;
  }>();

  type VoiceState = 'setup' | 'idle' | 'requesting' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

  const isConfigured = $derived(!!(turtleSettings().humeApiKey || settings().humeAiApiKey));
  let voiceState = $state<VoiceState>(isConfigured ? 'idle' : 'setup');
  let errorMsg = $state('');

  $effect(() => {
    if (!isConfigured && voiceState === 'idle') voiceState = 'setup';
    if (isConfigured && voiceState === 'setup') voiceState = 'idle';
  });

  type VoiceMsg = { role: 'user' | 'assistant'; content: string };
  let history = $state<VoiceMsg[]>([]);

  // Non-reactive handles (typed as any — hume SDK is loaded lazily at connect time)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let socket: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let audioPlayer: any = null;
  let mediaRecorder: MediaRecorder | null = null;
  let micStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let volBuf: Uint8Array | null = null;
  let volRafId = 0;

  let sessionSourceId: string | null = null;

  async function ensureSessionSource(): Promise<string> {
    if (sessionSourceId) return sessionSourceId;
    const s = settings();
    const id = `shelly-voice-${Date.now()}`;
    const src: Source = {
      id,
      title: `Shelly Voice — ${new Date().toLocaleTimeString()}`,
      uri: `urn:kbase:source/${id}`,
      ingestedAt: Date.now(),
      kind: 'analysis',
      analysisModel: s.claudeModel ?? 'claude-haiku-4-5-20251001',
      analysisProvider: 'claude',
      analysisTrigger: 'manual'
    };
    await addSource(src);
    sessionSourceId = id;
    return id;
  }

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

    const sorted = [...bySubject.entries()]
      .sort(([iriA, a], [iriB, b]) => {
        const aU = !typedIris.has(iriA) ? -1 : 0;
        const bU = !typedIris.has(iriB) ? -1 : 0;
        return aU - bU || b.length - a.length;
      }).slice(0, 20);

    for (const [iri, sts] of sorted) {
      const typeStmt = sts.find(s => s.p.value === RDF_TYPE);
      const typeIri = typeStmt?.o.value ?? null;
      const typeDef = typeIri ? tm.get(typeIri) : null;
      if (typeDef) typesPresent.add(typeDef.label);
      const labelStmt = sts.find(s => s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label');
      const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;
      sampleEntities.push({
        iri, label,
        type: typeDef?.label ?? null,
        predicates: sts.filter(s => s.p.value !== RDF_TYPE).slice(0, 4)
          .map(s => `${s.p.value.split('/').pop()} → ${s.o.value.slice(0, 40)}`)
      });
    }
    return { statementCount: stmts.length, sourceCount: sources().length, typesPresent: [...typesPresent], untypedEntityCount, manualStatementCount, sampleEntities };
  }

  async function applyKBActions(actions: KBAction[]) {
    const srcId = await ensureSessionSource();
    for (const action of actions) {
      if (action.type === 'adjust_view') { applyShellyViewAdjust(action); continue; }
      if (action.type === 'add_triple') {
        const stmt: Statement = {
          id: uuid(),
          s: { kind: 'iri', value: action.s },
          p: { kind: 'iri', value: action.p },
          o: action.o.startsWith('urn:') || action.o.startsWith('http')
            ? { kind: 'iri', value: action.o }
            : { kind: 'literal', value: action.o, datatype: 'xsd:string' },
          g: { kind: 'iri', value: `urn:kbase:source/${srcId}` },
          status: 'confirmed', sourceId: srcId, createdAt: Date.now(), updatedAt: Date.now(),
          confidence: 0.9,
        };
        await addStatements([stmt]);
      }
      if (action.type === 'remove_triple') {
        const match = statements().find(s => s.s.value === action.s && s.p.value === action.p && s.o.value === action.o);
        if (match) await setStatus(match.id, 'rejected');
      }
    }
  }

  async function handleUserTranscript(text: string) {
    if (!text.trim()) return;
    voiceState = 'thinking';
    oninterim?.('' ); // clear interim bubble
    onmessage?.('user', text);
    history = [...history, { role: 'user', content: text }];

    const s = settings();
    const { provider, apiKey, model } = resolveChatProvider(s);

    try {
      const result = await turtleChat({
        provider, apiKey, model, ollamaBaseUrl: s.ollamaBaseUrl, reckonsBaseUrl: s.reckonsBaseUrl,
        messages: history.slice(-10).map(m => ({ role: m.role, content: m.content })),
        kbContext: buildKBContext(), voiceMode: true, customPrompt: turtleSettings().systemPrompt || s.shellyCustomPrompt
      });

      history = [...history, { role: 'assistant', content: result.message }];
      onmessage?.('assistant', result.message, result.actions ?? []);

      // Auto-apply view actions; surface KB actions to chat as action cards
      const viewActions = result.actions?.filter(a => a.type === 'adjust_view') ?? [];
      await applyKBActions(viewActions);

      // Send response to Hume EVI for TTS using the voice config
      voiceState = 'speaking';
      socket?.sendAssistantInput({ text: result.message });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      voiceState = 'error';
    }
  }

  function startVolumePoller(stream: MediaStream) {
    try {
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      volBuf = new Uint8Array(analyser.frequencyBinCount);

      function poll() {
        if (!analyser || !volBuf || !onvolume) return;
        analyser.getByteFrequencyData(volBuf as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < volBuf.length; i++) sum += volBuf[i];
        onvolume(Math.min(sum / volBuf.length / 80, 1)); // normalise ~0-1
        volRafId = requestAnimationFrame(poll);
      }
      poll();
    } catch { /* non-fatal */ }
  }

  function stopVolumePoller() {
    cancelAnimationFrame(volRafId);
    try { audioCtx?.close(); } catch { /* ignore */ }
    audioCtx = null;
    analyser = null;
    volBuf = null;
    onvolume?.(0);
  }

  function startMicCapture(stream: MediaStream) {
    startVolumePoller(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size === 0 || !socket) return;
      const arrayBuffer = await e.data.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < uint8.byteLength; i++) binary += String.fromCharCode(uint8[i]);
      socket.sendAudioInput({ data: btoa(binary) });
    };

    mediaRecorder.start(100);
  }

  async function connect() {
    if (!isConfigured) { voiceState = 'setup'; return; }
    voiceState = 'requesting';
    errorMsg = '';

    // Lazy-load the hume SDK chunk — only fetched on first voice connect
    let HumeClient: any, EVIWebAudioPlayer: any, getAudioStream: any, fetchAccessToken: any;
    try {
      ({ HumeClient, EVIWebAudioPlayer, getAudioStream, fetchAccessToken } = await import('hume'));
    } catch (e) {
      errorMsg = 'Could not load voice SDK. Check your connection and try again.';
      voiceState = 'error';
      return;
    }

    try {
      micStream = await getAudioStream();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errorMsg = msg.includes('denied') || msg.includes('NotAllowed')
        ? 'Microphone access denied. Allow mic access in your browser.'
        : `Could not access microphone: ${msg}`;
      voiceState = 'error';
      return;
    }

    voiceState = 'connecting';

    try {
      const player = new EVIWebAudioPlayer();
      await player.init();
      audioPlayer = player;

      const s = settings();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let clientOpts: Record<string, any>;
      const ts = turtleSettings();
      const humeKey = ts.humeApiKey || s.humeAiApiKey;
      const humeSecret = ts.humeSecretKey || s.humeSecretKey;
      const humeConfig = ts.humeConfigId || s.humeConfigId;
      if (humeKey && humeSecret) {
        const accessToken = await fetchAccessToken({ apiKey: humeKey, secretKey: humeSecret });
        clientOpts = { accessToken };
      } else {
        clientOpts = { apiKey: humeKey };
      }

      const client = new HumeClient(clientOpts);
      const connectOpts: Record<string, unknown> = {};
      if (humeConfig?.trim()) connectOpts.configId = humeConfig.trim();

      socket = await client.empathicVoice.chat.connect(connectOpts);

      socket.on('open', () => {
        voiceState = 'listening';
        startMicCapture(micStream!);
      });

      socket.on('close', () => {
        if (voiceState !== 'error') voiceState = 'idle';
        stopMic();
      });

      socket.on('error', (err: unknown) => {
        errorMsg = err instanceof Error ? err.message : String(err);
        voiceState = 'error';
        stopMic();
      });

      socket.on('message', async (msg: Record<string, unknown>) => {
        const type = msg.type as string;

        if (type === 'user_message') {
          const content = (msg.message as Record<string, unknown>)?.content as string ?? '';
          // Pause EVI's own LLM immediately — we use turtleChat for responses
          try { socket?.pauseAssistant({}); } catch { /* ignore */ }

          if (content && msg.interim === true) {
            // Stream interim text to chat as a live preview
            oninterim?.(content);
          } else if (content) {
            // Final transcript — process through Shelly
            await handleUserTranscript(content);
          }
        }

        if (type === 'audio_output') {
          const audioData = msg.data as string;
          if (audioData && audioPlayer) {
            audioPlayer.enqueue({ audioData } as Parameters<typeof audioPlayer.enqueue>[0]);
          }
          if (voiceState === 'thinking') voiceState = 'speaking';
        }

        if (type === 'assistant_end') {
          voiceState = 'listening';
        }
      });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      voiceState = 'error';
      stopMic();
    }
  }

  function stopMic() {
    stopVolumePoller();
    try { mediaRecorder?.stop(); } catch { /* ignore */ }
    try { micStream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    mediaRecorder = null;
    micStream = null;
  }

  function disconnect() {
    stopMic();
    try { socket?.close?.(); } catch { /* ignore */ }
    try { (audioPlayer as { dispose?: () => void })?.dispose?.(); } catch { /* ignore */ }
    socket = null;
    audioPlayer = null;
    sessionSourceId = null;
    history = [];
    oninterim?.('');
    if (voiceState !== 'error') voiceState = isConfigured ? 'idle' : 'setup';
  }

  onDestroy(disconnect);

  export function isActive() {
    return voiceState === 'requesting' || voiceState === 'connecting' ||
      voiceState === 'listening' || voiceState === 'thinking' || voiceState === 'speaking';
  }

  export { voiceState, errorMsg, connect, disconnect };

  const stateColor: Record<VoiceState, string> = {
    setup: 'var(--muted)',
    idle: 'var(--muted)',
    requesting: 'var(--accent)',
    connecting: 'var(--accent)',
    listening: '#4caf50',
    thinking: 'var(--accent)',
    speaking: '#2196f3',
    error: '#f44'
  };

  const stateLabel: Record<VoiceState, string> = {
    setup: 'configure Hume.AI →',
    idle: 'tap to speak',
    requesting: 'allow microphone…',
    connecting: 'connecting…',
    listening: 'listening',
    thinking: 'thinking…',
    speaking: 'speaking',
    error: 'error — tap to retry'
  };
</script>

<!-- Compact inline orb — sits in the chat input row -->
<button
  class="voice-orb"
  class:active={voiceState === 'listening' || voiceState === 'speaking'}
  class:pulsing={voiceState === 'thinking' || voiceState === 'connecting' || voiceState === 'requesting'}
  class:error={voiceState === 'error'}
  style:--orb-color={stateColor[voiceState]}
  onclick={() => {
    if (voiceState === 'setup') { window.location.href = '/settings/turtle'; return; }
    if (isActive()) disconnect(); else connect();
  }}
  aria-label={isActive() ? 'Stop voice' : 'Start voice'}
  title={stateLabel[voiceState]}
>
  {#if voiceState === 'idle' || voiceState === 'setup'}
    🎙
  {:else if voiceState === 'listening'}
    👂
  {:else if voiceState === 'thinking'}
    <img src="/svg/head1.svg" alt="" style="height:1em;width:auto;vertical-align:middle" />
  {:else if voiceState === 'speaking'}
    💬
  {:else if voiceState === 'requesting' || voiceState === 'connecting'}
    …
  {:else}
    ⚠
  {/if}
</button>

{#if errorMsg}
  <span class="voice-error">{errorMsg}</span>
{/if}

<style>
  .voice-orb {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1.5px solid var(--orb-color);
    background: color-mix(in srgb, var(--orb-color) 10%, var(--surface));
    color: var(--orb-color);
    font-size: 1rem;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  .voice-orb:hover {
    background: color-mix(in srgb, var(--orb-color) 20%, var(--surface));
    transform: scale(1.08);
  }
  .voice-orb.active {
    box-shadow: 0 0 12px color-mix(in srgb, var(--orb-color) 55%, transparent);
  }
  .voice-orb.pulsing {
    animation: orb-pulse 1.1s ease-in-out infinite;
  }
  @keyframes orb-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.12); }
  }
  .voice-error {
    font-size: 0.68rem;
    color: #f44;
    line-height: 1.3;
    max-width: 160px;
  }
</style>
