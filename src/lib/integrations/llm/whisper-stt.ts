/**
 * Local speech-to-text using Whisper via @huggingface/transformers.
 *
 * Runs entirely in the browser — no API keys, no network after model download.
 * Uses whisper-tiny (~40MB quantized) by default for fast loading. Users can
 * switch to whisper-base or whisper-small in settings for better accuracy.
 *
 * The model is loaded lazily on first use and cached in the browser Cache API.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null;
let loadedModel = '';

type ProgressCallback = (status: string, progress?: number) => void;

const progressCallbacks = new Set<ProgressCallback>();

export function onWhisperProgress(cb: ProgressCallback): () => void {
  progressCallbacks.add(cb);
  return () => progressCallbacks.delete(cb);
}

const DEFAULT_MODEL = 'onnx-community/whisper-tiny';

/**
 * Download consent gate — same pattern as wasm.ts.
 * Whisper tiny is ~42MB; larger models are bigger.
 */
let consentHandler: ((model: string, approxMB: number) => Promise<boolean>) | null = null;
const consentGranted = new Set<string>();

export function setWhisperConsentHandler(
  handler: ((model: string, approxMB: number) => Promise<boolean>) | null
) {
  consentHandler = handler;
}

async function isWhisperCached(model: string): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    const url = `https://huggingface.co/${model}/resolve/main/onnx/encoder_model_quantized.onnx`;
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

export async function ensureWhisper(model = DEFAULT_MODEL): Promise<void> {
  if (transcriber && loadedModel === model) return;

  // Ask user before downloading if not cached
  if (consentHandler && !consentGranted.has(model)) {
    const cached = await isWhisperCached(model);
    if (!cached) {
      const approxMB = model.includes('whisper-tiny') ? 42
        : model.includes('whisper-base') ? 75
        : model.includes('whisper-small') ? 240
        : 50;
      const ok = await consentHandler(model, approxMB);
      if (!ok) throw new Error('Whisper download declined by user.');
      consentGranted.add(model);
    }
  }

  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  for (const cb of progressCallbacks) cb('loading', 0);

  transcriber = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    progress_callback: (p: { status: string; progress?: number }) => {
      for (const cb of progressCallbacks) cb(p.status, p.progress);
    }
  });
  loadedModel = model;

  for (const cb of progressCallbacks) cb('ready', 100);
}

export interface TranscriptionResult {
  text: string;
  chunks?: Array<{ text: string; timestamp: [number, number] }>;
}

/**
 * Transcribe an audio source.
 *
 * @param audio - Float32Array of audio samples at 16kHz, or a Blob/File of audio
 * @param model - HuggingFace model ID (default: whisper-tiny)
 * @param language - Optional language code (e.g. "en", "es")
 */
export async function transcribe(
  audio: Float32Array | Blob | File,
  model = DEFAULT_MODEL,
  language?: string
): Promise<TranscriptionResult> {
  await ensureWhisper(model);

  let input: Float32Array;
  if (audio instanceof Float32Array) {
    input = audio;
  } else {
    input = await audioToFloat32(audio);
  }

  const result = await transcriber(input, {
    return_timestamps: true,
    language,
    chunk_length_s: 30,
  });

  return {
    text: result.text?.trim() ?? '',
    chunks: result.chunks,
  };
}

/**
 * Convert a Blob/File of audio to Float32Array at 16kHz.
 * Uses the Web Audio API's OfflineAudioContext for resampling.
 */
async function audioToFloat32(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new OfflineAudioContext(1, 1, 16000);
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);

  // Resample to 16kHz mono
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();

  const resampled = await offlineCtx.startRendering();
  return resampled.getChannelData(0);
}

/**
 * Record from the microphone, returning a Float32Array of 16kHz audio.
 * Returns a controller object to stop recording.
 */
export function startMicRecording(): {
  stop: () => Promise<Float32Array>;
  cancel: () => void;
} {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let resolveAudio: ((audio: Float32Array) => void) | null = null;
  let rejectAudio: ((err: Error) => void) | null = null;

  const audioPromise = new Promise<Float32Array>((resolve, reject) => {
    resolveAudio = resolve;
    rejectAudio = reject;
  });

  // Start recording immediately
  navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
    stream = s;
    recorder = new MediaRecorder(s, { mimeType: getMimeType() });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream?.getTracks().forEach(t => t.stop());
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: recorder?.mimeType ?? 'audio/webm' });
        try {
          const audio = await audioToFloat32(blob);
          resolveAudio?.(audio);
        } catch (e) {
          rejectAudio?.(e instanceof Error ? e : new Error(String(e)));
        }
      } else {
        rejectAudio?.(new Error('No audio recorded'));
      }
    };
    recorder.start();
  }).catch(e => {
    rejectAudio?.(e instanceof Error ? e : new Error(String(e)));
  });

  return {
    stop: async () => {
      recorder?.stop();
      return audioPromise;
    },
    cancel: () => {
      recorder?.stop();
      stream?.getTracks().forEach(t => t.stop());
      chunks = [];
      rejectAudio?.(new Error('Recording cancelled'));
    }
  };
}

function getMimeType(): string {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return 'audio/webm';
}
