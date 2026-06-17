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
 *   reckons kbs                      list available KBs in ~/.reckons/
 *   reckons use <name>               set default KB
 *   reckons ingest "note text"       quick-ingest via LLM extraction
 *   echo "query" | reckons ask       pipe mode
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KBReader, search } from './kb.js';
import { chat, extract, buildContext, type LLMConfig, type Provider } from './llm.js';
import { detectAudioCaps, printAudioCaps, record, transcribe, speak, chime, cleanup, type AudioCaps } from './audio.js';

// ── Config file (.reckonsrc) ─────────────────────────────────────────────────

interface RCConfig {
  kb?: string;
  /** Directory containing named .ttl KB files (default: ~/.reckons/) */
  kbDir?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  voice?: string;
}

function rcPath(): string | null {
  const paths = [
    join(process.cwd(), '.reckonsrc'),
    join(homedir(), '.reckonsrc'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadRC(): RCConfig {
  const p = rcPath();
  if (p) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch {}
  }
  return {};
}

function saveRC(config: RCConfig): void {
  const p = rcPath() ?? join(homedir(), '.reckonsrc');
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ── KB directory & name resolution ──────────────────────────────────────────

function getKbDir(rc: RCConfig): string {
  return rc.kbDir ?? join(homedir(), '.reckons');
}

type KBInfo = { name: string; path: string; tripleCount?: number };

function listLocalKBs(rc: RCConfig): KBInfo[] {
  const dir = getKbDir(rc);
  if (!existsSync(dir)) return [];
  const results: KBInfo[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ttl')) continue;
      const name = f.replace(/\.ttl$/, '');
      const fullPath = join(dir, f);
      let tripleCount: number | undefined;
      try {
        const reader = new KBReader(fullPath);
        tripleCount = reader.stats().tripleCount;
      } catch { /* skip count on parse error */ }
      results.push({ name, path: fullPath, tripleCount });
    }
  } catch { /* dir not readable */ }
  return results;
}

/**
 * Resolve a --kb value to a file path.
 * Accepts: a file path, a KB name (matched against kbDir), or a partial name.
 */
function resolveKbPath(nameOrPath: string, rc: RCConfig): string {
  // If it's already a path (contains / or \ or ends with .ttl), use as-is
  if (nameOrPath.includes('/') || nameOrPath.includes('\\') || nameOrPath.endsWith('.ttl')) {
    return nameOrPath;
  }
  // Try exact name match in kbDir
  const dir = getKbDir(rc);
  const exact = join(dir, `${nameOrPath}.ttl`);
  if (existsSync(exact)) return exact;
  // Try case-insensitive partial match
  const lower = nameOrPath.toLowerCase();
  const kbs = listLocalKBs(rc);
  const match = kbs.find(k => k.name.toLowerCase() === lower)
    ?? kbs.find(k => k.name.toLowerCase().includes(lower));
  if (match) return match.path;
  // Fall back to treating it as a path
  return nameOrPath;
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

const kbPathRaw = str(opts.kb) ?? process.env.RECKONS_KB_PATH ?? rc.kb ?? './knowledge.ttl';
const kbPath = resolveKbPath(kbPathRaw, rc);
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
  reckons kbs                       list available knowledge bases
  reckons use <name>                set default KB by name
  reckons ingest "note text"        quick-ingest a note via LLM extraction
  reckons --caps                    show detected audio capabilities
  echo "q" | reckons ask            pipe mode (stdin)

KB SELECTION
  Name your .ttl files and place them in ~/.reckons/:
    ~/.reckons/personal.ttl
    ~/.reckons/work.ttl
    ~/.reckons/research.ttl

  Then refer to them by name:
    reckons --kb work search "deadline"
    reckons --kb personal ingest "Met Alice at the conference"
    reckons use research

  In audio mode (smart glasses):
    "switch to work"         switch active KB
    "add met Alice today"    quick ingest to current KB
    "add to work: deadline Friday"  ingest to a named KB
    "list KBs"               hear available KBs

OPTIONS
  -k, --kb <name|path>  KB name or path to .ttl file (default: ./knowledge.ttl)
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
    "kb": "~/.reckons/personal.ttl",
    "kbDir": "~/.reckons",
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

function cmdKbs(): void {
  const kbs = listLocalKBs(rc);
  const dir = getKbDir(rc);

  if (kbs.length === 0) {
    out(`No KBs found in ${dir}`);
    out(`Place .ttl files in ${dir}/ to manage multiple knowledge bases.`);
    out(`Or set "kbDir" in .reckonsrc to point to your KB directory.`);
    return;
  }

  if (opts.json) {
    out(JSON.stringify(kbs));
    return;
  }

  out(`Knowledge bases in ${dir}/\n`);
  const currentName = kbs.find(k => k.path === kbPath)?.name;
  for (const k of kbs) {
    const active = k.path === kbPath ? ' (active)' : '';
    const count = k.tripleCount !== undefined ? `  ${k.tripleCount} triples` : '';
    if (opts.terse) {
      out(k.name);
    } else {
      out(`  ${k.name}${active}${count}`);
    }
  }
}

function cmdUse(name: string): void {
  const resolved = resolveKbPath(name, rc);
  if (!existsSync(resolved)) {
    process.stderr.write(`KB not found: "${name}"\nRun \`reckons kbs\` to see available knowledge bases.\n`);
    process.exit(1);
  }
  // Update .reckonsrc
  const updated = { ...rc, kb: resolved };
  saveRC(updated);
  const label = listLocalKBs(rc).find(k => k.path === resolved)?.name ?? name;
  out(`Default KB set to: ${label} (${resolved})`);
}

async function cmdIngest(noteText: string): Promise<void> {
  const r = ensureKB();

  if (!opts.quiet) process.stderr.write(`[reckons] extracting triples from note...\n`);

  try {
    let turtle = await extract(llmConfig, noteText);

    // Strip markdown code fences if the LLM wrapped them
    turtle = turtle.replace(/^```(?:turtle|ttl)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

    if (!turtle) {
      process.stderr.write('No triples extracted.\n');
      return;
    }

    // Add a source comment and append to the .ttl file
    const timestamp = new Date().toISOString();
    const block = `\n# Quick ingest — ${timestamp}\n# Note: ${noteText.replace(/\n/g, ' ').slice(0, 100)}\n${turtle}\n`;

    appendFileSync(kbPath, block, 'utf8');

    // Reload and show what was added
    r.reload();
    const s = r.stats();
    if (!opts.quiet) process.stderr.write(`[reckons] KB now has ${s.tripleCount} triples, ${s.entityCount} entities\n`);

    if (opts.json) {
      out(JSON.stringify({ note: noteText, turtle, file: kbPath }));
    } else {
      out(`Ingested into ${kbPath}:`);
      for (const line of turtle.split('\n').filter(l => l.trim() && !l.startsWith('@prefix'))) {
        out(`  ${line.trim()}`);
      }
    }
  } catch (e) {
    process.stderr.write(`Extraction error: ${e instanceof Error ? e.message : e}\n`);
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
  /kbs              list available KBs
  /use <name>       switch default KB
  /ingest <text>    quick ingest a note
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
    if (input === '/kbs') { cmdKbs(); rl.prompt(); return; }
    if (input.startsWith('/use ')) { cmdUse(input.slice(5).trim()); rl.prompt(); return; }
    if (input.startsWith('/ingest ')) { await cmdIngest(input.slice(8).trim()); rl.prompt(); return; }
    if (input.startsWith('/i ')) { await cmdIngest(input.slice(3).trim()); rl.prompt(); return; }
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
  let r = ensureKB();

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

    // Voice KB switching: "switch to <name>" / "use <name>"
    const switchMatch = lower.match(/^(?:switch to|use|open)\s+(.+?)(?:\s+kb)?$/);
    if (switchMatch) {
      const name = switchMatch[1];
      const resolved = resolveKbPath(name, rc);
      if (existsSync(resolved)) {
        kb = new KBReader(resolved);
        r = kb;
        const s = kb.stats();
        const label = listLocalKBs(rc).find(k => k.path === resolved)?.name ?? name;
        const msg = `Switched to ${label}. ${s.tripleCount} triples, ${s.entityCount} entities.`;
        out(msg);
        process.stderr.write(`  [switched to ${resolved}]\n`);
        if (caps.tts) speak(msg, caps, voice);
      } else {
        const kbs = listLocalKBs(rc);
        const msg = kbs.length > 0
          ? `KB "${name}" not found. Available: ${kbs.map(k => k.name).join(', ')}.`
          : `KB "${name}" not found. No KBs in ${getKbDir(rc)}.`;
        out(msg);
        if (caps.tts) speak(msg, caps, voice);
      }
      continue;
    }

    // Voice quick ingest: "add <text>" / "remember <text>" / "note <text>" / "add to <kb>: <text>"
    const addToMatch = lower.match(/^(?:add to|ingest to|note to)\s+(.+?):\s*(.+)$/);
    const addMatch = !addToMatch ? lower.match(/^(?:add|remember|note|ingest)\s+(.+)$/) : null;
    if (addToMatch || addMatch) {
      let targetPath = kbPath;
      let noteText: string;
      if (addToMatch) {
        const targetName = addToMatch[1];
        targetPath = resolveKbPath(targetName, rc);
        if (!existsSync(targetPath)) {
          const msg = `KB "${targetName}" not found.`;
          out(msg);
          if (caps.tts) speak(msg, caps, voice);
          continue;
        }
        noteText = addToMatch[2];
      } else {
        noteText = addMatch![1];
      }

      process.stderr.write('  [extracting...]\n');
      try {
        let turtle = await extract(llmConfig, noteText);
        turtle = turtle.replace(/^```(?:turtle|ttl)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
        if (turtle) {
          const timestamp = new Date().toISOString();
          const block = `\n# Quick ingest — ${timestamp}\n# Note: ${noteText.slice(0, 100)}\n${turtle}\n`;
          appendFileSync(targetPath, block, 'utf8');
          if (targetPath === kbPath) r.reload();
          const targetLabel = addToMatch
            ? (listLocalKBs(rc).find(k => k.path === targetPath)?.name ?? 'KB')
            : 'your KB';
          const msg = `Got it. Added to ${targetLabel}.`;
          out(msg);
          if (caps.tts) speak(msg, caps, voice);
        } else {
          const msg = `Couldn't extract facts from that.`;
          out(msg);
          if (caps.tts) speak(msg, caps, voice);
        }
      } catch (e) {
        const msg = `Sorry, extraction failed.`;
        process.stderr.write(`  error: ${e instanceof Error ? e.message : e}\n`);
        if (caps.tts) speak(msg, caps, voice);
      }
      continue;
    }

    // Voice list KBs: "list KBs" / "my KBs" / "which KBs"
    if (lower === 'list kbs' || lower === 'my kbs' || lower === 'which kbs' || lower === 'what kbs') {
      const kbs = listLocalKBs(rc);
      if (kbs.length === 0) {
        const msg = 'No knowledge bases found.';
        out(msg);
        if (caps.tts) speak(msg, caps, voice);
      } else {
        const msg = `You have ${kbs.length} knowledge base${kbs.length === 1 ? '' : 's'}: ${kbs.map(k => k.name).join(', ')}.`;
        out(msg);
        if (caps.tts) speak(msg, caps, voice);
      }
      continue;
    }

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
    case 'kbs':
      cmdKbs();
      return;

    case 'use': {
      const name = positionals.slice(1).join(' ');
      if (!name) { process.stderr.write('Usage: reckons use <kb-name>\n'); process.exit(1); }
      cmdUse(name);
      return;
    }

    case 'ingest':
    case 'i': {
      let text = positionals.slice(1).join(' ');
      if (!text && !isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        text = Buffer.concat(chunks).toString().trim();
      }
      if (!text) { process.stderr.write('Usage: reckons ingest "note text"\n'); process.exit(1); }
      await cmdIngest(text);
      return;
    }

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
