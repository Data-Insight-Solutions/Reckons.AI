#!/usr/bin/env node
/**
 * reckons — CLI for Reckons.AI knowledge bases.
 *
 * Two modes of operation:
 *   1. Shell:   reckons <command> [args]   — pipe-friendly, scriptable
 *   2. Glasses: reckons --listen           — audio I/O loop for smart glasses
 *
 * Both read the same .ttl knowledge base and talk to the same LLM backends.
 *
 * Usage:
 *   reckons                          interactive REPL
 *   reckons --listen                 audio REPL (mic in, speaker out)
 *   reckons ask "what do I know?"    one-shot question
 *   reckons search "contract"        BM25 search
 *   reckons entity "alice"           entity details
 *   reckons stats                    KB statistics
 *   reckons list                     list all entities
 *   echo "query" | reckons ask       pipe mode
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KBReader, search } from './kb.js';
import { chat, buildContext, type LLMConfig, type Provider } from './llm.js';
import { detectAudioCaps, printAudioCaps, record, transcribe, speak, chime, cleanup, type AudioCaps } from './audio.js';

// ── Config file (.reckonsrc) ─────────────────────────────────────────────────

interface RCConfig {
  kb?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  voice?: string;
}

function loadRC(): RCConfig {
  const paths = [
    join(process.cwd(), '.reckonsrc'),
    join(homedir(), '.reckonsrc'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')); } catch {}
    }
  }
  return {};
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

const rc = loadRC();

const { values: opts, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    kb:         { type: 'string',  short: 'k' },
    listen:     { type: 'boolean', short: 'l', default: false },
    provider:   { type: 'string',  short: 'p' },
    model:      { type: 'string',  short: 'm' },
    'api-key':  { type: 'string' },
    'base-url': { type: 'string' },
    voice:      { type: 'string',  short: 'v' },
    json:       { type: 'boolean', short: 'j', default: false },
    terse:      { type: 'boolean', short: 't', default: false },
    help:       { type: 'boolean', short: 'h', default: false },
    quiet:      { type: 'boolean', short: 'q', default: false },
    limit:      { type: 'string',  short: 'n' },
    caps:       { type: 'boolean', default: false },
  },
  allowPositionals: true,
  strict: false,
});

// ── Resolve config (flag > env > rc > default) ──────────────────────────────

// String option helper (parseArgs returns string|boolean for mixed option sets)
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

const kbPath = str(opts.kb) ?? process.env.RECKONS_KB_PATH ?? rc.kb ?? './knowledge.ttl';
const provider = (str(opts.provider) ?? process.env.RECKONS_PROVIDER ?? rc.provider ?? 'ollama') as Provider;
const model = str(opts.model) ?? rc.model;
const apiKey = str(opts['api-key'])
  ?? (provider === 'claude' ? process.env.ANTHROPIC_API_KEY : undefined)
  ?? (provider === 'openai' ? process.env.OPENAI_API_KEY : undefined)
  ?? rc.apiKey;
const baseUrl = str(opts['base-url']) ?? process.env.OLLAMA_BASE_URL ?? rc.baseUrl;
const voice = str(opts.voice) ?? rc.voice;
const limit = parseInt(str(opts.limit) ?? '10', 10);
const isTTY = process.stdin.isTTY;

const llmConfig: LLMConfig = { provider, model, apiKey, baseUrl };

// ── Help ─────────────────────────────────────────────────────────────────────

if (opts.help) {
  process.stdout.write(`
reckons — CLI for Reckons.AI knowledge bases

USAGE
  reckons                           interactive REPL
  reckons --listen                  audio REPL (smart glasses / bluetooth)
  reckons ask "question"            ask Shelly about your KB
  reckons search "query"            BM25 full-text search
  reckons entity "name"             get all facts about an entity
  reckons list                      list all entities
  reckons stats                     KB statistics
  reckons --caps                    show detected audio capabilities
  echo "q" | reckons ask            pipe mode (stdin)

OPTIONS
  -k, --kb <path>       path to .ttl file (default: ./knowledge.ttl)
  -p, --provider <name> LLM provider: ollama, claude, openai (default: ollama)
  -m, --model <name>    LLM model override
  --api-key <key>       API key (or use ANTHROPIC_API_KEY / OPENAI_API_KEY)
  --base-url <url>      Ollama base URL (default: http://localhost:11434)
  -l, --listen          audio mode — mic input, speaker output
  -v, --voice <name>    TTS voice name
  -n, --limit <n>       max results for search/list (default: 10)
  -j, --json            JSON output
  -t, --terse           minimal output (one line per result)
  -q, --quiet           suppress status messages
  --caps                show detected audio capabilities and exit
  -h, --help            show this help

CONFIG
  Place a .reckonsrc file in your home directory or project root:
  {
    "kb": "~/knowledge/my-kb.ttl",
    "provider": "ollama",
    "model": "llama3.2",
    "voice": "en"
  }

ENVIRONMENT
  RECKONS_KB_PATH       path to .ttl file
  RECKONS_PROVIDER      LLM provider
  ANTHROPIC_API_KEY     Claude API key
  OPENAI_API_KEY        OpenAI API key (also used for Whisper STT)
  OLLAMA_BASE_URL       Ollama URL
`);
  process.exit(0);
}

// ── Audio caps ───────────────────────────────────────────────────────────────

if (opts.caps) {
  const caps = detectAudioCaps(apiKey ?? process.env.OPENAI_API_KEY);
  process.stdout.write(`Audio capabilities:\n${printAudioCaps(caps)}\n`);
  process.exit(0);
}

// ── Load KB ──────────────────────────────────────────────────────────────────

let kb: KBReader | null = null;

function ensureKB(): KBReader {
  if (kb) { kb.reload(); return kb; }
  if (!existsSync(kbPath)) {
    process.stderr.write(`KB not found: ${kbPath}\nUse --kb <path> or set RECKONS_KB_PATH\n`);
    process.exit(1);
  }
  kb = new KBReader(kbPath);
  if (!opts.quiet) {
    const s = kb.stats();
    process.stderr.write(`[reckons] ${s.tripleCount} triples, ${s.entityCount} entities from ${kbPath}\n`);
  }
  return kb;
}

// ── Output helpers ───────────────────────────────────────────────────────────

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function shortIri(iri: string): string {
  return iri.split('/').pop() ?? iri;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdStats(): void {
  const s = ensureKB().stats();
  if (opts.json) {
    out(JSON.stringify(s));
  } else {
    out(`Triples:   ${s.tripleCount}`);
    out(`Entities:  ${s.entityCount}`);
    out(`Types:     ${s.typeCount}`);
    out(`Sources:   ${s.sourceCount}`);
    out(`Modified:  ${s.lastModified.toISOString()}`);
    out(`File:      ${kbPath}`);
  }
}

function cmdList(): void {
  const r = ensureKB();
  const iris = r.entityIRIs().slice(0, limit);
  if (opts.json) {
    out(JSON.stringify(iris.map(iri => ({ iri, label: r.label(iri) ?? shortIri(iri) }))));
    return;
  }
  for (const iri of iris) {
    const label = r.label(iri);
    if (opts.terse) {
      out(label ?? shortIri(iri));
    } else {
      out(`  ${label ?? shortIri(iri)}  <${iri}>`);
    }
  }
  const total = r.entityIRIs().length;
  if (total > limit) out(`  ... and ${total - limit} more (use -n to see more)`);
}

function cmdEntity(name: string): void {
  const r = ensureKB();
  let iri = name;
  if (!iri.startsWith('urn:') && !iri.startsWith('http')) {
    const resolved = r.resolveLabel(iri);
    if (!resolved) { out(`Entity not found: "${iri}"`); return; }
    iri = resolved;
  }

  const triples = r.triplesAbout(iri);
  if (triples.length === 0) { out(`No facts found for: ${iri}`); return; }

  if (opts.json) { out(JSON.stringify(triples)); return; }

  const label = r.label(iri) ?? shortIri(iri);
  out(`${label}  <${iri}>`);
  out('');

  const asSubject = triples.filter(t => t.subject === iri);
  const asObject = triples.filter(t => t.object === iri);

  if (asSubject.length > 0) {
    for (const t of asSubject) {
      const p = shortIri(t.predicate);
      const o = t.objectIsLiteral ? `"${t.object}"` : shortIri(t.object);
      out(opts.terse ? `  ${p} -> ${o}` : `  ${p}  -->  ${o}`);
    }
  }
  if (asObject.length > 0) {
    out('');
    out('Referenced by:');
    for (const t of asObject) {
      out(`  ${shortIri(t.subject)}  --${shortIri(t.predicate)}-->  *`);
    }
  }
}

function cmdSearch(query: string): void {
  const r = ensureKB();
  const results = search(r.allTriples(), query, limit);

  if (results.length === 0) { out(`No results for: "${query}"`); return; }

  if (opts.json) {
    out(JSON.stringify(results.map(r => ({ ...r.triple, score: r.score }))));
    return;
  }

  for (const { triple: t, score } of results) {
    const s = shortIri(t.subject), p = shortIri(t.predicate);
    const o = t.objectIsLiteral ? `"${t.object.slice(0, 60)}"` : shortIri(t.object);
    if (opts.terse) {
      out(`${s} ${p} ${o}`);
    } else {
      out(`  ${s}  --${p}-->  ${o}  (${score.toFixed(2)})`);
    }
  }
}

async function cmdAsk(question: string): Promise<void> {
  const r = ensureKB();
  const relevant = search(r.allTriples(), question, 15);
  const context = buildContext(relevant.map(r => r.triple));

  try {
    const response = await chat(llmConfig, [{ role: 'user', content: question }], context);
    out(response);
  } catch (e) {
    process.stderr.write(`LLM error: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}

// ── Text REPL ────────────────────────────────────────────────────────────────

async function textREPL(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // prompts to stderr so stdout stays clean for pipes
    prompt: 'reckons> ',
  });

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  process.stderr.write('Reckons.AI CLI — type a question, or use /help for commands\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands
    if (input === '/help' || input === '/h') {
      process.stderr.write(`
  /search <query>   search the KB
  /entity <name>    entity details
  /list             list entities
  /stats            KB statistics
  /clear            clear conversation
  /quit             exit
  (anything else)   ask Shelly

`);
      rl.prompt(); return;
    }
    if (input === '/quit' || input === '/q' || input === '/exit') { rl.close(); return; }
    if (input === '/clear') { messages.length = 0; process.stderr.write('Conversation cleared.\n'); rl.prompt(); return; }
    if (input === '/stats') { cmdStats(); rl.prompt(); return; }
    if (input === '/list') { cmdList(); rl.prompt(); return; }
    if (input.startsWith('/search ')) { cmdSearch(input.slice(8).trim()); rl.prompt(); return; }
    if (input.startsWith('/entity ')) { cmdEntity(input.slice(8).trim()); rl.prompt(); return; }
    if (input.startsWith('/e ')) { cmdEntity(input.slice(3).trim()); rl.prompt(); return; }
    if (input.startsWith('/s ')) { cmdSearch(input.slice(3).trim()); rl.prompt(); return; }

    // Chat message → Shelly
    const r = ensureKB();
    const relevant = search(r.allTriples(), input, 15);
    const context = buildContext(relevant.map(r => r.triple));

    messages.push({ role: 'user', content: input });
    // Keep last 10 messages for context
    if (messages.length > 10) messages.splice(0, messages.length - 10);

    try {
      const response = await chat(llmConfig, messages, context);
      messages.push({ role: 'assistant', content: response });
      out(response);
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : e}\n`);
    }
    rl.prompt();
  });

  rl.on('close', () => { process.stderr.write('\n'); process.exit(0); });
}

// ── Audio REPL (glasses mode) ────────────────────────────────────────────────

async function audioREPL(): Promise<void> {
  const whisperKey = process.env.OPENAI_API_KEY ?? apiKey;
  const caps = detectAudioCaps(whisperKey);

  process.stderr.write(`Audio mode\n${printAudioCaps(caps)}\n\n`);

  if (!caps.recorder) {
    process.stderr.write('No audio recorder found. Install sox: apt install sox / brew install sox\n');
    process.exit(1);
  }
  if (!caps.stt) {
    process.stderr.write('No STT engine found. Install whisper.cpp or set OPENAI_API_KEY.\n');
    process.exit(1);
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const r = ensureKB();

  // Greeting
  const greeting = 'Reckons ready. Speak now.';
  process.stderr.write(greeting + '\n');
  if (caps.tts) speak(greeting, caps, voice);

  // Main loop
  while (true) {
    // Visual cue
    process.stderr.write('\n  [listening...]\n');
    chime(caps);

    // Record
    const wavPath = record(caps);
    if (!wavPath) {
      process.stderr.write('  (no audio captured)\n');
      continue;
    }

    // Transcribe
    process.stderr.write('  [transcribing...]\n');
    const text = transcribe(wavPath, caps, whisperKey);
    if (!text) {
      process.stderr.write('  (could not transcribe)\n');
      continue;
    }

    process.stderr.write(`  you: ${text}\n`);

    // Check for exit commands
    const lower = text.toLowerCase().trim();
    if (lower === 'quit' || lower === 'exit' || lower === 'stop' || lower === 'goodbye') {
      const bye = 'Goodbye.';
      out(bye);
      if (caps.tts) speak(bye, caps, voice);
      break;
    }

    // Handle simple commands by voice
    if (lower.startsWith('search ') || lower.startsWith('find ')) {
      const query = text.slice(text.indexOf(' ') + 1);
      const results = search(r.allTriples(), query, 5);
      if (results.length === 0) {
        const msg = `No results for ${query}.`;
        out(msg);
        if (caps.tts) speak(msg, caps, voice);
      } else {
        const msg = results.map(r => {
          const s = shortIri(r.triple.subject), p = shortIri(r.triple.predicate);
          const o = r.triple.objectIsLiteral ? r.triple.object.slice(0, 40) : shortIri(r.triple.object);
          return `${s}, ${p}, ${o}`;
        }).join('. ');
        out(msg);
        if (caps.tts) speak(msg, caps, voice);
      }
      continue;
    }

    if (lower === 'stats' || lower === 'status') {
      const s = r.stats();
      const msg = `Your knowledge base has ${s.tripleCount} triples about ${s.entityCount} entities.`;
      out(msg);
      if (caps.tts) speak(msg, caps, voice);
      continue;
    }

    // Default: ask Shelly
    process.stderr.write('  [thinking...]\n');
    const relevant = search(r.allTriples(), text, 15);
    const context = buildContext(relevant.map(r => r.triple));

    messages.push({ role: 'user', content: text });
    if (messages.length > 10) messages.splice(0, messages.length - 10);

    try {
      const response = await chat(llmConfig, messages, context);
      messages.push({ role: 'assistant', content: response });

      out(response);
      process.stderr.write(`  shelly: ${response}\n`);
      if (caps.tts) speak(response, caps, voice);
    } catch (e) {
      const msg = `Sorry, I could not reach the language model.`;
      process.stderr.write(`  error: ${e instanceof Error ? e.message : e}\n`);
      if (caps.tts) speak(msg, caps, voice);
    }
  }

  cleanup();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = positionals[0];

  // Audio REPL
  if (opts.listen) {
    await audioREPL();
    return;
  }

  // One-shot commands
  switch (command) {
    case 'stats':
      cmdStats();
      return;

    case 'list':
    case 'ls':
      cmdList();
      return;

    case 'entity':
    case 'e': {
      const name = positionals.slice(1).join(' ');
      if (!name) { process.stderr.write('Usage: reckons entity <name>\n'); process.exit(1); }
      cmdEntity(name);
      return;
    }

    case 'search':
    case 's': {
      let query = positionals.slice(1).join(' ');
      // Read from stdin if no query given and not a TTY
      if (!query && !isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        query = Buffer.concat(chunks).toString().trim();
      }
      if (!query) { process.stderr.write('Usage: reckons search <query>\n'); process.exit(1); }
      cmdSearch(query);
      return;
    }

    case 'ask':
    case 'a': {
      let question = positionals.slice(1).join(' ');
      // Read from stdin if no question given and not a TTY
      if (!question && !isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        question = Buffer.concat(chunks).toString().trim();
      }
      if (!question) { process.stderr.write('Usage: reckons ask "question"\n'); process.exit(1); }
      await cmdAsk(question);
      return;
    }

    case undefined:
    case '':
      // No command → interactive REPL
      if (isTTY) {
        await textREPL();
      } else {
        // Pipe mode: read stdin as a question
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const question = Buffer.concat(chunks).toString().trim();
        if (question) await cmdAsk(question);
      }
      return;

    default:
      process.stderr.write(`Unknown command: ${command}\nRun reckons --help for usage.\n`);
      process.exit(1);
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
