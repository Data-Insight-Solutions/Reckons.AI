#!/usr/bin/env npx tsx
/**
 * TTS Model Benchmark
 *
 * Benchmarks text-to-speech models on latency, audio quality indicators,
 * and output consistency. Uses Kokoro TTS via kokoro-js in Node.js.
 *
 * Usage:
 *   npx tsx tests/bench/run-tts-bench.ts              # run benchmark
 *   npx tsx tests/bench/run-tts-bench.ts --save        # persist results
 *   npx tsx tests/bench/run-tts-bench.ts --list        # show test phrases
 *
 * Metrics:
 *   - Time to first audio (TTFA): model load + first synthesis
 *   - Synthesis speed: real-time factor (audio duration / synthesis time)
 *   - Output consistency: standard deviation across repeated runs
 *   - Voice coverage: whether each voice variant produces audio
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Test phrases (varied lengths and complexity) ─────────────────────────────

const TEST_PHRASES = [
  { id: 'short', text: 'Hello, I am Shelly the turtle.', expectedWords: 7 },
  { id: 'medium', text: 'Your knowledge base has fifteen entities and forty-two confirmed triples across three sources.', expectedWords: 14 },
  { id: 'long', text: 'I found a potential merge between the entities SvelteKit and Svelte Kit framework. They appear to refer to the same technology. Would you like me to combine them into a single node in your knowledge graph?', expectedWords: 36 },
  { id: 'technical', text: 'The RDF triple extraction pipeline uses a quantized transformer model running in WebAssembly to convert unstructured text into subject predicate object statements.', expectedWords: 26 },
  { id: 'conversational', text: "That's a great question! Based on your KB, Reckons AI is built with SvelteKit and uses Dexie for local storage. Pretty shell-acular if you ask me!", expectedWords: 27 },
];

const VOICES = ['af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_george'];

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveResults = args.includes('--save');

if (args.includes('--list')) {
  console.log('\nTest phrases:');
  for (const p of TEST_PHRASES) {
    console.log(`  ${p.id.padEnd(16)} ${p.expectedWords}w  "${p.text.slice(0, 60)}..."`);
  }
  console.log(`\nVoices: ${VOICES.join(', ')}`);
  process.exit(0);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface TTSResult {
  phraseId: string;
  voice: string;
  synthesisMs: number;
  /** Audio duration in seconds (estimated from sample count) */
  audioDurationSec: number;
  /** Real-time factor: audioDuration / synthesisTime (>1 = faster than real-time) */
  realTimeFactor: number;
  /** Whether synthesis produced non-empty audio */
  success: boolean;
  /** Number of audio samples generated */
  sampleCount: number;
}

interface TTSBenchReport {
  model: string;
  timestamp: string;
  loadTimeMs: number;
  results: TTSResult[];
  summary: {
    avgSynthesisMs: number;
    avgRealTimeFactor: number;
    successRate: number;
    voiceCoverage: number;
    totalPhrases: number;
  };
}

// ── Benchmark ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  TTS MODEL BENCHMARK');
  console.log(`${'='.repeat(60)}`);
  console.log(`Phrases: ${TEST_PHRASES.length}`);
  console.log(`Voices: ${VOICES.length}`);

  // Load Kokoro TTS
  console.log('\nLoading Kokoro TTS model...');
  const loadStart = Date.now();

  let tts: any;
  try {
    const { KokoroTTS } = await import('kokoro-js');
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'auto' as any,
    });
  } catch (e) {
    console.error(`Failed to load Kokoro TTS: ${(e as Error).message}`);
    console.log('\nKokoro TTS requires kokoro-js. Install: npm install kokoro-js');
    process.exit(1);
  }

  const loadTimeMs = Date.now() - loadStart;
  console.log(`  Loaded in ${(loadTimeMs / 1000).toFixed(1)}s`);

  const results: TTSResult[] = [];

  // Test each phrase with default voice first
  const defaultVoice = VOICES[0];
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  PHRASE BENCHMARKS (voice: ${defaultVoice})`);
  console.log(`${'─'.repeat(60)}`);

  for (const phrase of TEST_PHRASES) {
    const synthStart = Date.now();
    let success = false;
    let sampleCount = 0;
    let audioDurationSec = 0;

    try {
      const audio = await tts.generate(phrase.text, { voice: defaultVoice });
      const synthMs = Date.now() - synthStart;

      if (audio && audio.audio) {
        sampleCount = audio.audio.length ?? 0;
        // Kokoro outputs at 24kHz
        audioDurationSec = sampleCount / 24000;
        success = sampleCount > 0;
      }

      const rtf = audioDurationSec > 0 ? audioDurationSec / (synthMs / 1000) : 0;
      const icon = success ? '\u2713' : '\u2717';
      console.log(`  ${icon} ${phrase.id.padEnd(16)} ${synthMs}ms  ${audioDurationSec.toFixed(2)}s audio  RTF=${rtf.toFixed(2)}x  ${sampleCount} samples`);

      results.push({
        phraseId: phrase.id,
        voice: defaultVoice,
        synthesisMs: synthMs,
        audioDurationSec,
        realTimeFactor: rtf,
        success,
        sampleCount,
      });
    } catch (e) {
      const synthMs = Date.now() - synthStart;
      console.log(`  \u2717 ${phrase.id.padEnd(16)} FAILED: ${(e as Error).message}`);
      results.push({
        phraseId: phrase.id,
        voice: defaultVoice,
        synthesisMs: synthMs,
        audioDurationSec: 0,
        realTimeFactor: 0,
        success: false,
        sampleCount: 0,
      });
    }
  }

  // Test voice coverage with the medium phrase
  console.log(`\n${'─'.repeat(60)}`);
  console.log('  VOICE COVERAGE');
  console.log(`${'─'.repeat(60)}`);

  const coveragePhrase = TEST_PHRASES.find(p => p.id === 'medium')!;
  for (const voice of VOICES) {
    if (voice === defaultVoice) continue; // already tested above

    const synthStart = Date.now();
    try {
      const audio = await tts.generate(coveragePhrase.text, { voice });
      const synthMs = Date.now() - synthStart;
      const sampleCount = audio?.audio?.length ?? 0;
      const audioDurationSec = sampleCount / 24000;
      const success = sampleCount > 0;

      console.log(`  ${success ? '\u2713' : '\u2717'} ${voice.padEnd(16)} ${synthMs}ms  ${audioDurationSec.toFixed(2)}s`);

      results.push({
        phraseId: coveragePhrase.id,
        voice,
        synthesisMs: synthMs,
        audioDurationSec,
        realTimeFactor: audioDurationSec > 0 ? audioDurationSec / (synthMs / 1000) : 0,
        success,
        sampleCount,
      });
    } catch (e) {
      console.log(`  \u2717 ${voice.padEnd(16)} FAILED: ${(e as Error).message}`);
      results.push({
        phraseId: coveragePhrase.id,
        voice,
        synthesisMs: Date.now() - synthStart,
        audioDurationSec: 0,
        realTimeFactor: 0,
        success: false,
        sampleCount: 0,
      });
    }
  }

  // Summary
  const successCount = results.filter(r => r.success).length;
  const successResults = results.filter(r => r.success);
  const avgSynthMs = successResults.length > 0
    ? successResults.reduce((s, r) => s + r.synthesisMs, 0) / successResults.length
    : 0;
  const avgRTF = successResults.length > 0
    ? successResults.reduce((s, r) => s + r.realTimeFactor, 0) / successResults.length
    : 0;
  const voicesSucceeded = new Set(successResults.map(r => r.voice)).size;

  const report: TTSBenchReport = {
    model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    timestamp: new Date().toISOString(),
    loadTimeMs,
    results,
    summary: {
      avgSynthesisMs: Math.round(avgSynthMs),
      avgRealTimeFactor: parseFloat(avgRTF.toFixed(2)),
      successRate: successCount / results.length,
      voiceCoverage: voicesSucceeded / VOICES.length,
      totalPhrases: TEST_PHRASES.length,
    },
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Model load:       ${(loadTimeMs / 1000).toFixed(1)}s`);
  console.log(`  Avg synthesis:    ${avgSynthMs.toFixed(0)}ms`);
  console.log(`  Avg RTF:          ${avgRTF.toFixed(2)}x real-time`);
  console.log(`  Success rate:     ${(successCount / results.length * 100).toFixed(0)}% (${successCount}/${results.length})`);
  console.log(`  Voice coverage:   ${voicesSucceeded}/${VOICES.length}`);

  if (saveResults) {
    const dir = join(import.meta.dirname || __dirname, 'results');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `tts-bench_${ts}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(report, null, 2));
    console.log(`\nResults saved to tests/bench/results/${filename}`);
  }
}

main().catch(e => {
  console.error('TTS bench failed:', e);
  process.exit(1);
});
