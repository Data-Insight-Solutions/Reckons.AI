/**
 * Offscreen document — captures tab audio and transcribes it.
 *
 * Two modes:
 *  - 'deepgram': streams audio to Deepgram WebSocket for real-time transcription
 *  - 'whisper':  captures raw PCM, runs local Whisper WASM every ~8 seconds
 *
 * Receives streamId from the service worker and forwards transcript results back.
 */

let mediaStream: MediaStream | null = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;
let mode: 'deepgram' | 'whisper' = 'whisper';

// ── Deepgram state ──────────────────────────────────────────────────────────
let mediaRecorder: MediaRecorder | null = null;
let dgSocket: WebSocket | null = null;

// ── Whisper state ───────────────────────────────────────────────────────────
let audioContext: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let pcmChunks: Float32Array[] = [];
let whisperInterval: ReturnType<typeof setInterval> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whisperTranscriber: any = null;
let whisperProcessing = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.deepgramKey, msg.mode ?? 'whisper')
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse({ ok: true });
      break;
  }
});

async function startCapture(streamId: string, deepgramKey: string | undefined, captureMode: 'deepgram' | 'whisper') {
  mode = captureMode;

  // Get the tab's audio stream via the tabCapture streamId
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as any,
  });

  if (mode === 'deepgram' && deepgramKey) {
    await startDeepgramMode(deepgramKey);
  } else {
    await startWhisperMode();
  }

  // Keep service worker alive
  keepAlive = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});
  }, 20000);
}

// ── Deepgram mode ───────────────────────────────────────────────────────────

async function startDeepgramMode(deepgramKey: string) {
  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'en',
    smart_format: 'true',
    diarize: 'true',
    interim_results: 'true',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });

  dgSocket = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    ['token', deepgramKey]
  );

  dgSocket.onopen = () => {
    console.log('[offscreen] Deepgram WebSocket connected');
    startMediaRecorder();
  };

  dgSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
        const alt = data.channel.alternatives[0];
        const transcript = alt.transcript;
        if (!transcript) return;

        chrome.runtime.sendMessage({
          type: 'TRANSCRIPT_RESULT',
          text: transcript,
          isFinal: data.is_final === true,
          interim: data.is_final !== true,
          speaker: alt.words?.[0]?.speaker ?? null,
        }).catch(() => {});
      }
    } catch { /* ignore parse errors */ }
  };

  dgSocket.onerror = (err) => {
    console.error('[offscreen] Deepgram WebSocket error:', err);
    chrome.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: 'Deepgram connection error. Check your API key.',
    }).catch(() => {});
  };

  dgSocket.onclose = (event) => {
    console.log('[offscreen] Deepgram WebSocket closed:', event.code, event.reason);
    if (event.code !== 1000) {
      chrome.runtime.sendMessage({
        type: 'PIPELINE_ERROR',
        message: `Deepgram disconnected: ${event.reason || 'connection lost'}`,
      }).catch(() => {});
    }
  };
}

function startMediaRecorder() {
  if (!mediaStream || !dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: 'audio/webm;codecs=opus',
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && dgSocket?.readyState === WebSocket.OPEN) {
      dgSocket.send(event.data);
    }
  };

  mediaRecorder.start(250);
}

// ── Whisper mode ────────────────────────────────────────────────────────────

const WHISPER_CHUNK_INTERVAL_MS = 8000;
const WHISPER_MODEL = 'onnx-community/whisper-tiny';

async function startWhisperMode() {
  if (!mediaStream) throw new Error('No media stream');

  // Signal that model is loading
  chrome.runtime.sendMessage({
    type: 'TRANSCRIPT_RESULT', text: 'Loading speech model…', isFinal: false, interim: true,
  }).catch(() => {});

  // Load Whisper model (cached after first download)
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  whisperTranscriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
    dtype: 'q8',
  });

  chrome.runtime.sendMessage({
    type: 'TRANSCRIPT_RESULT', text: 'Listening…', isFinal: false, interim: true,
  }).catch(() => {});

  // Capture raw PCM via ScriptProcessorNode
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  scriptProcessor.onaudioprocess = (e) => {
    pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  // Process accumulated audio every ~8 seconds
  whisperInterval = setInterval(processWhisperChunk, WHISPER_CHUNK_INTERVAL_MS);
}

async function resampleTo16k(audio: Float32Array, fromRate: number): Promise<Float32Array> {
  if (fromRate === 16000) return audio;
  const targetLength = Math.ceil(audio.length * 16000 / fromRate);
  const offlineCtx = new OfflineAudioContext(1, targetLength, 16000);
  const buffer = offlineCtx.createBuffer(1, audio.length, fromRate);
  buffer.getChannelData(0).set(audio);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offlineCtx.destination);
  src.start();
  const resampled = await offlineCtx.startRendering();
  return resampled.getChannelData(0);
}

async function processWhisperChunk() {
  if (pcmChunks.length === 0 || !whisperTranscriber || whisperProcessing) return;
  whisperProcessing = true;

  // Drain accumulated chunks
  const chunks = pcmChunks.splice(0);
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);

  // Skip very short chunks (< 0.5s of audio)
  const sampleRate = audioContext?.sampleRate ?? 44100;
  if (totalLength / sampleRate < 0.5) {
    whisperProcessing = false;
    return;
  }

  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  try {
    const audio16k = await resampleTo16k(combined, sampleRate);

    const result = await whisperTranscriber(audio16k, {
      return_timestamps: true,
      language: 'en',
      chunk_length_s: 30,
    });

    const text = (result.text as string)?.trim() ?? '';
    if (text && text !== '[BLANK_AUDIO]') {
      // Split into sentences for the pipeline
      const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (s) {
          chrome.runtime.sendMessage({
            type: 'TRANSCRIPT_RESULT',
            text: s,
            isFinal: true,
            speaker: null,
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('[offscreen] Whisper transcription error:', e);
    chrome.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: `Whisper error: ${e instanceof Error ? e.message : String(e)}`,
    }).catch(() => {});
  } finally {
    whisperProcessing = false;
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function stopCapture() {
  // Deepgram cleanup
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (dgSocket) {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    dgSocket.close();
    dgSocket = null;
  }

  // Whisper cleanup
  if (whisperInterval) { clearInterval(whisperInterval); whisperInterval = null; }
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  pcmChunks = [];
  whisperProcessing = false;

  // Shared cleanup
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}
