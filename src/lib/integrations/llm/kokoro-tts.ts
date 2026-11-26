/**
 * Kokoro TTS — high-quality neural text-to-speech via ONNX in-browser.
 *
 * Lazy-loads the ~87MB model on first use, cached in IndexedDB after that.
 * Import this module and call `warmup()` only after the user has explicitly
 * enabled voice. Merely loading the app or opening settings must not fetch the
 * runtime or model.
 *
 * Supports streaming via TextSplitterStream for responsive playback
 * during LLM chat responses.
 */

let instance: any = null;
let loading: Promise<any> | null = null;
let _status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let progress = 0;
/** Phase distinguishes download from WASM initialization */
let _phase: 'download' | 'init' = 'download';
let onStatus: ((s: typeof _status, pct: number, phase: typeof _phase) => void) | null = null;

import { DEFAULT_KOKORO_VOICE, KOKORO_VOICES } from './voice-catalog';

/** Subscribe to load status changes */
export function onKokoroStatus(cb: (status: typeof _status, pct: number, phase: typeof _phase) => void) {
  onStatus = cb;
  cb(_status, progress, _phase);
}

function notify() {
  onStatus?.(_status, progress, _phase);
}

export function kokoroStatus() { return _status; }
export function kokoroProgress() { return progress; }
export function kokoroPhase() { return _phase; }

/**
 * TEST SEAM (Matt, 2026-11-25: "audio output seems broken ... we obviously need audio tests improved"). A browser
 * test cannot download the ~87 MB voice model, so under the mock ingest build (only the Playwright config turns it
 * on) AND an explicit `reckons-test-voice` browser flag, a stand-in speaks each sentence as a short silent WAV. It
 * proves the narration WIRING (a step is spoken, a refused play() is shown and recovered from); it says nothing
 * about whether the real model loads or sounds right, which needs a person listening.
 */
function testVoiceOn(): boolean {
  if (import.meta.env.VITE_INGEST_BACKEND !== 'mock') return false;
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('reckons-test-voice') === '1'; }
  catch { return false; }
}

/** A short silent mono 16-bit WAV: the stand-in voice's every sentence. */
export function silentWav(ms = 120, rate = 24000): Blob {
  const samples = Math.round((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** The stand-in model: the same stream() shape kokoro-js has, one silent chunk per sentence. */
export function standInTts() {
  return {
    async *stream(text: string, opts: { split_pattern?: RegExp } = {}) {
      for (const sentence of text.split(opts.split_pattern ?? /(?<=[.!?;:])\s+/).filter(Boolean)) {
        yield { text: sentence, audio: { toBlob: () => silentWav() } };
      }
    },
    async generate() { return { toBlob: () => silentWav() }; },
    list_voices() { return [DEFAULT_KOKORO_VOICE]; },
  };
}

async function loadModel(): Promise<any> {
  if (testVoiceOn()) return standInTts();
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: any) => {
      if (p.status === 'progress' && p.total) {
        progress = Math.round((p.loaded / p.total) * 100);
        _phase = 'download';
        notify();
      }
      // 'done' signals downloads finished; WASM session init starts next
      if (p.status === 'done') {
        _phase = 'init';
        progress = 100;
        notify();
      }
      // 'initiate' with no prior progress means model is cached
      if (p.status === 'initiate') {
        _phase = 'init';
        notify();
      }
    },
  });
  return tts;
}

/**
 * Start downloading the model in the background.
 * Safe to call multiple times — only loads once.
 */
export function warmup(): void {
  if (instance || loading) return;
  _status = 'loading';
  progress = 0;
  notify();

  loading = loadModel()
    .then((tts) => {
      instance = tts;
      _status = 'ready';
      progress = 100;
      notify();
      return tts;
    })
    .catch((e) => {
      console.error('[kokoro-tts] Failed to load model:', e);
      _status = 'error';
      notify();
      loading = null;
      throw e;
    });
}

/** Get the loaded TTS instance, or null if not ready */
export function getInstance(): any | null {
  return instance;
}

/** Wait for the model to be ready */
export async function getReady(): Promise<any> {
  if (instance) return instance;
  if (!loading) warmup();
  return loading;
}

/** Default voice — af_heart is the top-rated calm female voice */
export const DEFAULT_VOICE = DEFAULT_KOKORO_VOICE;

/** All known Kokoro voices with metadata for the settings UI */
export const VOICES = KOKORO_VOICES;

/**
 * Streaming TTS — feeds text through TextSplitterStream for
 * immediate audio playback as chunks are synthesized.
 *
 * Uses a producer/consumer buffer: synthesis runs ahead of playback
 * so the next chunk is already ready when the current one finishes,
 * eliminating inter-sentence gaps.
 *
 * Returns an abort function. Call it to stop playback.
 */
export function speakStreaming(
  text: string,
  opts: {
    voice?: string;
    rate?: number;
    volume?: number;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (e: unknown) => void;
    /**
     * The browser refused to play sound (NotAllowedError): no click or key press on the page yet, which is what a
     * link that autoplays a story meets, and what any reload leaves behind. Speaking stops; the caller offers a
     * button, whose click is the gesture that lets the next try play. Before 2026-11-25 this was swallowed: every
     * sentence "played" instantly into silence and narration reported success.
     */
    onBlocked?: () => void;
  } = {},
  /** For tests: the model and the audio element. The app always uses the loaded model and new Audio(). */
  deps: { tts?: any; makeAudio?: (url: string) => HTMLAudioElement } = {}
): () => void {
  const tts = deps.tts ?? instance;
  const makeAudio = deps.makeAudio ?? ((url: string) => new Audio(url));
  if (!tts) {
    opts.onError?.(new Error('Kokoro model not loaded'));
    return () => {};
  }

  let aborted = false;
  let currentAudio: HTMLAudioElement | null = null;

  // Pre-buffer queue: producer pushes blobs, consumer plays them
  const buffer: Blob[] = [];
  let producerDone = false;
  let bufferResolve: (() => void) | null = null;

  function notifyBuffer() {
    if (bufferResolve) { bufferResolve(); bufferResolve = null; }
  }

  // Wait until buffer has an item or producer is done
  function waitForBuffer(): Promise<void> {
    if (buffer.length > 0 || producerDone) return Promise.resolve();
    return new Promise<void>((r) => { bufferResolve = r; });
  }

  // ── Producer: synthesize chunks into buffer ──
  // Split on sentence boundaries so each WASM inference is short (~1-3s)
  // and the browser can paint between chunks.
  (async () => {
    try {
      const stream = tts.stream(text, {
        voice: opts.voice ?? DEFAULT_VOICE,
        split_pattern: /(?<=[.!?;:])\s+/,
      });

      for await (const { audio } of stream) {
        if (aborted) break;
        buffer.push(audio.toBlob());
        notifyBuffer();
        // Yield to browser so UI stays responsive between synthesis calls
        await new Promise(r => setTimeout(r, 0));
      }
    } catch (e) {
      if (!aborted) opts.onError?.(e);
    } finally {
      producerDone = true;
      notifyBuffer();
    }
  })();

  // ── Consumer: play from buffer with no gaps ──
  (async () => {
    try {
      // Wait for first chunk before firing onStart
      await waitForBuffer();
      if (aborted || (buffer.length === 0 && producerDone)) {
        if (!aborted) opts.onEnd?.();
        return;
      }

      opts.onStart?.();

      while (!aborted) {
        await waitForBuffer();
        const blob = buffer.shift();
        if (!blob) { if (producerDone) break; continue; }

        const url = URL.createObjectURL(blob);
        const el = makeAudio(url);
        currentAudio = el;
        el.playbackRate = opts.rate ?? 1;
        el.volume = opts.volume ?? 0.85;

        let blocked = false;
        await new Promise<void>((resolve) => {
          el.onended = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
          el.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
          el.play().catch((e: unknown) => {
            blocked = (e as { name?: string } | null)?.name === 'NotAllowedError';
            URL.revokeObjectURL(url); currentAudio = null; resolve();
          });
        });
        if (blocked) {
          aborted = true; // the producer stops too: nothing more can play until the reader acts
          opts.onBlocked?.();
          return;
        }
        // Brief inter-chunk silence for natural sentence rhythm
        if (!aborted && buffer.length > 0) {
          await new Promise(r => setTimeout(r, 180));
        }
      }

      if (!aborted) opts.onEnd?.();
    } catch (e) {
      if (!aborted) opts.onError?.(e);
    }
  })();

  return () => {
    aborted = true;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
  };
}

/** List available voices from the loaded model */
export async function listVoices(): Promise<string[]> {
  const tts = await getReady();
  return tts.list_voices();
}
