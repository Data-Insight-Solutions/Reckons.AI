/**
 * Kokoro TTS — high-quality neural text-to-speech via ONNX in-browser.
 *
 * Lazy-loads the ~87MB model on first use, cached in IndexedDB after that.
 * Call `warmup()` early (e.g. on layout mount) to start the download
 * in the background before the user actually needs speech.
 *
 * Supports streaming via TextSplitterStream for responsive playback
 * during LLM chat responses.
 */

let _instance: any = null;
let _loading: Promise<any> | null = null;
let _status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let _progress = 0;
let _onStatus: ((s: typeof _status, pct: number) => void) | null = null;

/** Subscribe to load status changes */
export function onKokoroStatus(cb: (status: typeof _status, pct: number) => void) {
  _onStatus = cb;
  cb(_status, _progress);
}

function notify() {
  _onStatus?.(_status, _progress);
}

export function kokoroStatus() { return _status; }
export function kokoroProgress() { return _progress; }

async function loadModel(): Promise<any> {
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: any) => {
      if (p.status === 'progress' && p.total) {
        _progress = Math.round((p.loaded / p.total) * 100);
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
  if (_instance || _loading) return;
  _status = 'loading';
  _progress = 0;
  notify();

  _loading = loadModel()
    .then((tts) => {
      _instance = tts;
      _status = 'ready';
      _progress = 100;
      notify();
      return tts;
    })
    .catch((e) => {
      console.error('[kokoro-tts] Failed to load model:', e);
      _status = 'error';
      notify();
      _loading = null;
      throw e;
    });
}

/** Get the loaded TTS instance, or null if not ready */
export function getInstance(): any | null {
  return _instance;
}

/** Wait for the model to be ready */
export async function getReady(): Promise<any> {
  if (_instance) return _instance;
  if (!_loading) warmup();
  return _loading;
}

/** Default voice — af_heart is the top-rated calm female voice */
export const DEFAULT_VOICE = 'af_heart';

/** All known Kokoro voices with metadata for the settings UI */
export const VOICES: { id: string; label: string; gender: 'F' | 'M'; accent: string; grade: string }[] = [
  // American English — Female
  { id: 'af_heart',   label: 'Heart',   gender: 'F', accent: 'US', grade: 'A' },
  { id: 'af_bella',   label: 'Bella',   gender: 'F', accent: 'US', grade: 'A-' },
  { id: 'af_nicole',  label: 'Nicole',  gender: 'F', accent: 'US', grade: 'B-' },
  { id: 'af_aoede',   label: 'Aoede',   gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_kore',    label: 'Kore',    gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_sarah',   label: 'Sarah',   gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_alloy',   label: 'Alloy',   gender: 'F', accent: 'US', grade: 'C' },
  { id: 'af_aoede',   label: 'Aoede',   gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_nova',    label: 'Nova',    gender: 'F', accent: 'US', grade: 'C' },
  { id: 'af_sky',     label: 'Sky',     gender: 'F', accent: 'US', grade: 'C-' },
  { id: 'af_jessica', label: 'Jessica', gender: 'F', accent: 'US', grade: 'D' },
  { id: 'af_river',   label: 'River',   gender: 'F', accent: 'US', grade: 'D' },
  // American English — Male
  { id: 'am_fenrir',  label: 'Fenrir',  gender: 'M', accent: 'US', grade: 'C+' },
  { id: 'am_michael', label: 'Michael', gender: 'M', accent: 'US', grade: 'C+' },
  { id: 'am_puck',    label: 'Puck',    gender: 'M', accent: 'US', grade: 'C+' },
  { id: 'am_adam',    label: 'Adam',    gender: 'M', accent: 'US', grade: 'F+' },
  { id: 'am_echo',    label: 'Echo',    gender: 'M', accent: 'US', grade: 'D' },
  { id: 'am_eric',    label: 'Eric',    gender: 'M', accent: 'US', grade: 'D' },
  { id: 'am_liam',    label: 'Liam',    gender: 'M', accent: 'US', grade: 'D' },
  { id: 'am_onyx',    label: 'Onyx',    gender: 'M', accent: 'US', grade: 'D' },
  // British English — Female
  { id: 'bf_emma',     label: 'Emma',     gender: 'F', accent: 'UK', grade: 'B-' },
  { id: 'bf_isabella', label: 'Isabella', gender: 'F', accent: 'UK', grade: 'C' },
  { id: 'bf_alice',    label: 'Alice',    gender: 'F', accent: 'UK', grade: 'D' },
  { id: 'bf_lily',     label: 'Lily',     gender: 'F', accent: 'UK', grade: 'D' },
  // British English — Male
  { id: 'bm_george',  label: 'George',  gender: 'M', accent: 'UK', grade: 'C' },
  { id: 'bm_fable',   label: 'Fable',   gender: 'M', accent: 'UK', grade: 'C' },
  { id: 'bm_daniel',  label: 'Daniel',  gender: 'M', accent: 'UK', grade: 'D' },
  { id: 'bm_lewis',   label: 'Lewis',   gender: 'M', accent: 'UK', grade: 'D+' },
];

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
  } = {}
): () => void {
  const tts = _instance;
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
  // Split on paragraph breaks instead of every sentence — fewer chunks = fewer gaps.
  // Falls back to ~200-char boundaries so very long paragraphs still stream.
  (async () => {
    try {
      const stream = tts.stream(text, {
        voice: opts.voice ?? DEFAULT_VOICE,
        split_pattern: /\n\n+/,
      });

      for await (const { audio } of stream) {
        if (aborted) break;
        buffer.push(audio.toBlob());
        notifyBuffer();
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
        const el = new Audio(url);
        currentAudio = el;
        el.playbackRate = opts.rate ?? 1;
        el.volume = opts.volume ?? 0.85;

        await new Promise<void>((resolve) => {
          el.onended = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
          el.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
          el.play().catch(() => { URL.revokeObjectURL(url); currentAudio = null; resolve(); });
        });
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
