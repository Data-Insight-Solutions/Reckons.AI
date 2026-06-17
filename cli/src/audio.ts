/**
 * Audio I/O — STT and TTS using system tools or APIs.
 *
 * Detects available tools at startup and picks the best option.
 * Designed for both desktop terminals and smart glasses over bluetooth.
 *
 * Recording:  sox > arecord > ffmpeg
 * STT:        whisper (local binary) > OpenAI Whisper API
 * TTS:        piper > say (macOS) > espeak-ng > espeak
 */

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Capability detection ─────────────────────────────────────────────────────

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

export interface AudioCaps {
  recorder: 'sox' | 'arecord' | 'ffmpeg' | null;
  stt: 'whisper-local' | 'whisper-api' | null;
  tts: 'piper' | 'say' | 'espeak-ng' | 'espeak' | null;
}

export function detectAudioCaps(apiKey?: string): AudioCaps {
  const recorder =
    which('sox')     ? 'sox' as const :
    which('arecord') ? 'arecord' as const :
    which('ffmpeg')  ? 'ffmpeg' as const :
    null;

  const stt =
    which('whisper')     ? 'whisper-local' as const :
    which('whisper-cpp') ? 'whisper-local' as const :
    apiKey               ? 'whisper-api' as const :
    null;

  const tts =
    which('piper')      ? 'piper' as const :
    which('say')        ? 'say' as const :
    which('espeak-ng')  ? 'espeak-ng' as const :
    which('espeak')     ? 'espeak' as const :
    null;

  return { recorder, stt, tts };
}

export function printAudioCaps(caps: AudioCaps): string {
  const lines = [
    `  recorder: ${caps.recorder ?? 'none (install sox)'}`,
    `  stt:      ${caps.stt ?? 'none (install whisper or set OPENAI_API_KEY)'}`,
    `  tts:      ${caps.tts ?? 'none (install piper, espeak-ng, or say)'}`,
  ];
  return lines.join('\n');
}

// ── Temp directory ───────────────────────────────────────────────────────────

let _tmpDir: string | null = null;
function getTmpDir(): string {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'reckons-'));
  return _tmpDir;
}

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * Record from the default microphone until silence is detected.
 * Returns the path to a 16kHz mono WAV file.
 */
export function record(caps: AudioCaps, maxSeconds = 30): string | null {
  const wavPath = join(getTmpDir(), `input-${Date.now()}.wav`);

  if (caps.recorder === 'sox') {
    // sox: record until 1.5s of silence, max duration, 16kHz mono
    const result = spawnSync('sox', [
      '-d',                          // default input device
      '-t', 'wav',                   // output format
      '-r', '16000',                 // 16kHz
      '-c', '1',                     // mono
      '-b', '16',                    // 16-bit
      wavPath,
      'silence', '1', '0.1', '3%',  // start on voice
      '1', '1.5', '3%',             // stop on 1.5s silence
      'trim', '0', String(maxSeconds),
    ], { stdio: ['inherit', 'pipe', 'pipe'], timeout: (maxSeconds + 5) * 1000 });

    if (result.status !== 0 && !existsSync(wavPath)) return null;
    return existsSync(wavPath) ? wavPath : null;
  }

  if (caps.recorder === 'arecord') {
    // arecord: fixed duration (no built-in silence detection)
    const result = spawnSync('arecord', [
      '-f', 'S16_LE', '-r', '16000', '-c', '1',
      '-d', String(Math.min(maxSeconds, 10)),
      wavPath,
    ], { stdio: ['inherit', 'pipe', 'pipe'], timeout: (maxSeconds + 5) * 1000 });

    if (result.status !== 0) return null;
    return existsSync(wavPath) ? wavPath : null;
  }

  if (caps.recorder === 'ffmpeg') {
    // ffmpeg: capture from default pulse/alsa device
    const input = process.platform === 'darwin' ? 'avfoundation' : 'pulse';
    const device = process.platform === 'darwin' ? ':0' : 'default';
    const result = spawnSync('ffmpeg', [
      '-y', '-f', input, '-i', device,
      '-ar', '16000', '-ac', '1', '-t', String(maxSeconds),
      wavPath,
    ], { stdio: ['inherit', 'pipe', 'pipe'], timeout: (maxSeconds + 5) * 1000 });

    if (result.status !== 0) return null;
    return existsSync(wavPath) ? wavPath : null;
  }

  return null;
}

// ── Speech to Text ───────────────────────────────────────────────────────────

/**
 * Transcribe a WAV file to text.
 */
export function transcribe(wavPath: string, caps: AudioCaps, apiKey?: string): string | null {
  if (caps.stt === 'whisper-local') {
    // Try whisper CLI (whisper.cpp or openai-whisper)
    const bin = which('whisper') ? 'whisper' : 'whisper-cpp';
    try {
      const result = execFileSync(bin, [
        wavPath,
        '--model', 'tiny',
        '--output_format', 'txt',
        '--output_dir', getTmpDir(),
        '--language', 'en',
      ], { timeout: 30_000, stdio: 'pipe' });

      // whisper outputs to <basename>.txt
      const txtPath = wavPath.replace(/\.wav$/, '.txt');
      if (existsSync(txtPath)) {
        const text = readFileSync(txtPath, 'utf8').trim();
        try { unlinkSync(txtPath); } catch {}
        return text || null;
      }
      // Some versions write to stdout
      return result.toString().trim() || null;
    } catch { return null; }
  }

  if (caps.stt === 'whisper-api' && apiKey) {
    // OpenAI Whisper API
    try {
      const wavData = readFileSync(wavPath);
      const boundary = '----ReckonsAudioBoundary' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        wavData,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`),
      ]);

      const result = execFileSync('curl', [
        '-s', '-X', 'POST',
        'https://api.openai.com/v1/audio/transcriptions',
        '-H', `Authorization: Bearer ${apiKey}`,
        '-H', `Content-Type: multipart/form-data; boundary=${boundary}`,
        '--data-binary', '@-',
      ], { input: body, timeout: 15_000 });

      const json = JSON.parse(result.toString());
      return json.text?.trim() || null;
    } catch { return null; }
  }

  return null;
}

// ── Text to Speech ───────────────────────────────────────────────────────────

/**
 * Speak text aloud using the best available TTS engine.
 * Blocks until speech completes.
 */
export function speak(text: string, caps: AudioCaps, voice?: string): void {
  // Clean text for speech: strip markdown formatting
  const clean = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .trim();

  if (!clean) return;

  if (caps.tts === 'piper') {
    try {
      const wavPath = join(getTmpDir(), `speak-${Date.now()}.wav`);
      execSync(`echo ${JSON.stringify(clean)} | piper --output_file ${wavPath}`, { timeout: 15_000, stdio: 'pipe' });
      if (existsSync(wavPath)) {
        // Play the WAV
        if (which('aplay')) execSync(`aplay ${wavPath}`, { stdio: 'pipe', timeout: 30_000 });
        else if (which('play')) execSync(`play ${wavPath}`, { stdio: 'pipe', timeout: 30_000 });
        else if (which('afplay')) execSync(`afplay ${wavPath}`, { stdio: 'pipe', timeout: 30_000 });
        try { unlinkSync(wavPath); } catch {}
      }
      return;
    } catch { /* fall through */ }
  }

  if (caps.tts === 'say') {
    try {
      const args = voice ? ['-v', voice, clean] : [clean];
      spawnSync('say', args, { stdio: 'pipe', timeout: 60_000 });
      return;
    } catch { /* fall through */ }
  }

  if (caps.tts === 'espeak-ng' || caps.tts === 'espeak') {
    try {
      const bin = caps.tts;
      const args = voice ? ['-v', voice, clean] : [clean];
      spawnSync(bin, args, { stdio: 'pipe', timeout: 60_000 });
      return;
    } catch { /* fall through */ }
  }
}

// ── Chime (non-verbal audio cue) ────────────────────────────────────────────

/** Play a short ready-chime so the user knows to start speaking. */
export function chime(caps: AudioCaps): void {
  if (caps.tts === 'say') {
    try { execSync('say -v "?" ""', { stdio: 'pipe', timeout: 2000 }); } catch {}
    return;
  }
  // Fallback: print a visual cue (handled by caller)
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function cleanup(): void {
  if (_tmpDir) {
    try { execSync(`rm -rf ${_tmpDir}`, { stdio: 'pipe' }); } catch {}
    _tmpDir = null;
  }
}
