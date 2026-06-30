#!/usr/bin/env npx tsx
/**
 * Interactive KB workflow CLI — review + reckoning via local models.
 *
 * Usage:
 *   npx tsx tests/bench/run-kb-workflow.ts review          # Review roadmap items
 *   npx tsx tests/bench/run-kb-workflow.ts reckon           # Priority reckoning
 *   npx tsx tests/bench/run-kb-workflow.ts reckon --query "..." # Custom reckoning
 *   npx tsx tests/bench/run-kb-workflow.ts stats            # KB overview
 *   npx tsx tests/bench/run-kb-workflow.ts search <query>   # BM25 search
 *   npx tsx tests/bench/run-kb-workflow.ts entity <iri>     # Entity details
 *
 * Options:
 *   --model <name>     Ollama model (default: gemma3:4b)
 *   --url <base>       Ollama base URL (default: http://localhost:11434)
 *   --kb <name>        KB to query: roadmap | production | features (default: roadmap)
 *   --save             Save reckoning output to tests/bench/results/
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as readline from 'node:readline';

// ── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--')) ?? 'stats';
const flag = (name: string) => args.includes(`--${name}`);
const param = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const OLLAMA_URL = param('url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const OLLAMA_MODEL = param('model', process.env.OLLAMA_MODEL ?? 'gemma3:4b');
const SAVE = flag('save');
const KB_NAME = param('kb', 'roadmap');

const KB_FILES: Record<string, string> = {
  roadmap: 'static/reckons-roadmap.ttl',
  production: 'static/reckons-production.ttl',
  features: 'static/docs-features.ttl',
  architecture: 'static/docs-architecture.ttl',
  testing: 'static/docs-testing.ttl',
};

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const RESULTS_DIR = join(PROJECT_ROOT, 'tests/bench/results');

// ── Minimal N3 parser (reuse mcp-server logic without importing) ────────────

interface Triple {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral: boolean;
}

function parseTtl(text: string): Triple[] {
  // Simple line-based parser for prefixed Turtle — enough for our .ttl files
  const prefixes: Record<string, string> = {};
  const triples: Triple[] = [];

  // Resolve prefixed names
  const resolveIRI = (term: string): string => {
    term = term.trim();
    if (term.startsWith('<') && term.endsWith('>')) return term.slice(1, -1);
    const colon = term.indexOf(':');
    if (colon > 0) {
      const prefix = term.slice(0, colon);
      const local = term.slice(colon + 1);
      if (prefixes[prefix]) return prefixes[prefix] + local;
    }
    return term;
  };

  // Multi-line accumulator
  let currentSubject = '';
  let currentPredicate = '';
  let inBlock = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('##')) continue;

    // Prefix declarations
    const pfxMatch = line.match(/^@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\.$/);
    if (pfxMatch) {
      prefixes[pfxMatch[1]] = pfxMatch[2];
      continue;
    }

    // Skip KB identity lines and navigation
    if (line.startsWith('<urn:reckons:kb>')) continue;

    // Detect subject start: "prefix:local ..."
    const subjMatch = line.match(/^([a-zA-Z][\w-]*:[a-zA-Z][\w-]*)\s+(.+)$/);
    if (subjMatch && !inBlock) {
      currentSubject = resolveIRI(subjMatch[1]);
      const rest = subjMatch[2];
      parsePOList(rest, currentSubject, resolveIRI, prefixes, triples);
      if (rest.endsWith('.')) {
        inBlock = false;
      } else {
        inBlock = true;
      }
      continue;
    }

    // Continuation lines (predicate-object in a block)
    if (inBlock && (line.endsWith(';') || line.endsWith('.') || line.endsWith(','))) {
      parsePOList(line, currentSubject, resolveIRI, prefixes, triples);
      if (line.endsWith('.')) inBlock = false;
    }
  }

  return triples;
}

function parsePOList(
  text: string,
  subject: string,
  resolveIRI: (s: string) => string,
  prefixes: Record<string, string>,
  triples: Triple[]
): void {
  // Remove trailing punctuation
  let clean = text.replace(/\s*[;.,]\s*$/, '').trim();
  if (!clean) return;

  // Split predicate-object pairs (very simplified)
  // Match: predicate "literal" or predicate prefix:local
  const poPattern = /([a-zA-Z][\w-]*:[a-zA-Z][\w/.-]*)\s+("(?:[^"\\]|\\.)*"(?:\^\^[^\s;,.]+)?|[a-zA-Z][\w-]*:[a-zA-Z][\w/.-]*|<[^>]+>)/g;
  let match;
  while ((match = poPattern.exec(clean)) !== null) {
    const predicate = resolveIRI(match[1]);
    let obj = match[2].trim();
    let isLiteral = false;

    if (obj.startsWith('"')) {
      // Extract literal value
      const litMatch = obj.match(/^"((?:[^"\\]|\\.)*)"(?:\^\^(.+))?$/);
      if (litMatch) {
        obj = litMatch[1];
        isLiteral = true;
      }
    } else {
      obj = resolveIRI(obj);
    }

    triples.push({ subject, predicate, object: obj, objectIsLiteral: isLiteral });
  }
}

// ── BM25 Search ─────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s-_]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

function tripleText(t: Triple): string {
  const s = t.subject.split('/').pop() ?? t.subject;
  const p = t.predicate.split('/').pop() ?? t.predicate;
  return `${s} ${p} ${t.object}`;
}

function bm25Search(triples: Triple[], query: string, limit = 20): { triple: Triple; score: number }[] {
  const K1 = 1.5, B = 0.75;
  const queryTokens = tokenize(query);
  const docs = triples.map(t => tokenize(tripleText(t)));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N;

  // Document frequency
  const df = new Map<string, number>();
  for (const doc of docs) {
    const unique = new Set(doc);
    for (const t of unique) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const scores = docs.map((doc, i) => {
    let score = 0;
    const dl = doc.length;
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

    for (const qt of queryTokens) {
      const n = df.get(qt) ?? 0;
      const f = tf.get(qt) ?? 0;
      if (n === 0 || f === 0) continue;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl));
    }
    return { triple: triples[i], score };
  });

  return scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Entity extraction helpers ───────────────────────────────────────────────

function labelFromIRI(iri: string): string {
  const slug = iri.split('/').pop() ?? iri;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface Entity {
  iri: string;
  label: string;
  type?: string;
  status?: string;
  featureId?: string;
  description?: string;
  dependsOn: string[];
  allTriples: Triple[];
}

function extractEntities(triples: Triple[]): Entity[] {
  const map = new Map<string, Entity>();

  for (const t of triples) {
    if (!map.has(t.subject)) {
      map.set(t.subject, {
        iri: t.subject,
        label: labelFromIRI(t.subject),
        dependsOn: [],
        allTriples: [],
      });
    }
    const e = map.get(t.subject)!;
    e.allTriples.push(t);

    const pred = t.predicate.split('/').pop() ?? t.predicate;
    if (pred === 'label') e.label = t.object;
    else if (pred === 'type' && t.object.includes('type/')) e.type = t.object.split('/').pop();
    else if (pred === 'has-status') e.status = t.object;
    else if (pred === 'feature-id') e.featureId = t.object;
    else if (pred === 'description') e.description = t.object;
    else if (pred === 'depends-on') e.dependsOn.push(labelFromIRI(t.object));
  }

  return Array.from(map.values());
}

// ── Ollama chat ─────────────────────────────────────────────────────────────

async function chat(system: string, user: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content;
}

// ── Interactive prompt ──────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(l => prefix + l).join('\n');
}

// ── Commands ────────────────────────────────────────────────────────────────

function loadKB(): Triple[] {
  const file = KB_FILES[KB_NAME];
  if (!file) {
    console.error(`Unknown KB: ${KB_NAME}. Options: ${Object.keys(KB_FILES).join(', ')}`);
    process.exit(1);
  }
  const path = join(PROJECT_ROOT, file);
  if (!existsSync(path)) {
    console.error(`KB file not found: ${path}`);
    process.exit(1);
  }
  const text = readFileSync(path, 'utf8');
  return parseTtl(text);
}

async function cmdStats() {
  const triples = loadKB();
  const entities = extractEntities(triples);

  const byStatus = new Map<string, number>();
  for (const e of entities) {
    if (e.status) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  }

  console.log(`\n  KB: ${KB_NAME} (${KB_FILES[KB_NAME]})`);
  console.log(`  Triples: ${triples.length}`);
  console.log(`  Entities: ${entities.length}`);
  console.log(`\n  Status breakdown:`);
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status.padEnd(15)} ${count}`);
  }

  const features = entities.filter(e => e.featureId);
  if (features.length > 0) {
    console.log(`\n  Features (${features.length}):`);
    for (const f of features.sort((a, b) => (a.featureId ?? '').localeCompare(b.featureId ?? ''))) {
      const status = f.status ?? '?';
      const icon = status === 'production' ? '✓' : status === 'functional' ? '~' : '○';
      console.log(`    ${icon} ${(f.featureId ?? '').padEnd(5)} ${f.label.padEnd(35)} ${status}`);
    }
  }
  console.log();
}

async function cmdSearch() {
  const query = args.filter(a => !a.startsWith('--')).slice(1).join(' ');
  if (!query) {
    console.error('Usage: search <query>');
    process.exit(1);
  }

  const triples = loadKB();
  const results = bm25Search(triples, query, 15);

  console.log(`\n  Search: "${query}" in ${KB_NAME} (${results.length} results)\n`);
  for (const r of results) {
    const s = labelFromIRI(r.triple.subject);
    const p = r.triple.predicate.split('/').pop();
    const o = r.triple.objectIsLiteral ? `"${r.triple.object.slice(0, 80)}"` : labelFromIRI(r.triple.object);
    console.log(`  [${r.score.toFixed(2)}] ${s} → ${p} → ${o}`);
  }
  console.log();
}

async function cmdEntity() {
  const query = args.filter(a => !a.startsWith('--')).slice(1).join(' ');
  if (!query) {
    console.error('Usage: entity <partial-iri-or-label>');
    process.exit(1);
  }

  const triples = loadKB();
  const entities = extractEntities(triples);

  const match = entities.find(e =>
    e.iri.toLowerCase().includes(query.toLowerCase()) ||
    e.label.toLowerCase().includes(query.toLowerCase())
  );

  if (!match) {
    console.error(`No entity matching "${query}"`);
    process.exit(1);
  }

  console.log(`\n  Entity: ${match.label}`);
  console.log(`  IRI:    ${match.iri}`);
  if (match.type) console.log(`  Type:   ${match.type}`);
  if (match.status) console.log(`  Status: ${match.status}`);
  if (match.featureId) console.log(`  ID:     ${match.featureId}`);
  if (match.description) console.log(`  Desc:   ${match.description.slice(0, 200)}`);
  if (match.dependsOn.length) console.log(`  Deps:   ${match.dependsOn.join(', ')}`);
  console.log(`\n  All triples (${match.allTriples.length}):`);
  for (const t of match.allTriples) {
    const p = t.predicate.split('/').pop();
    const o = t.objectIsLiteral ? `"${t.object.slice(0, 100)}"` : labelFromIRI(t.object);
    console.log(`    ${p} → ${o}`);
  }
  console.log();
}

async function cmdReview() {
  const triples = loadKB();
  const entities = extractEntities(triples);

  // Find items that might need review — planned features, recent additions
  const reviewable = entities.filter(e =>
    e.status === 'planned' || e.status === 'scaffolded'
  ).sort((a, b) => (a.featureId ?? 'Z').localeCompare(b.featureId ?? 'Z'));

  console.log(`\n  Review: ${reviewable.length} items with status "planned" or "scaffolded" in ${KB_NAME}`);
  console.log(`  Model: ${OLLAMA_MODEL}`);
  console.log(`  Mode: interactive (item-by-item)\n`);

  // Also include production items for context
  const production = entities.filter(e => e.status === 'production' || e.status === 'functional');
  const productionContext = production.map(e =>
    `- ${e.featureId ?? '?'} ${e.label} (${e.status})`
  ).join('\n');

  const decisions: { entity: Entity; decision: string; llmAdvice: string; userNote: string }[] = [];

  const systemPrompt = `You are a product advisor for Reckons.AI, a local-first personal knowledge graph app.
You are reviewing ONE planned feature at a time. The user will decide — you advise.
Give a concise recommendation (ADVANCE / HOLD / DROP) with 2-3 sentence rationale.
Consider: user value, dependency readiness, technical risk, and local-first alignment.
Be direct and opinionated. Do not hedge.`;

  // Item-by-item interactive review
  for (let i = 0; i < reviewable.length; i++) {
    const e = reviewable[i];
    const deps = e.dependsOn.length > 0 ? `\n  Deps:   ${e.dependsOn.join(', ')}` : '';
    const desc = e.description ? `\n  Desc:   ${e.description.slice(0, 200)}` : '';

    console.log(`  ─── Item ${i + 1} / ${reviewable.length} ───────────────────────────────────`);
    console.log(`  Feature: ${e.label} (${e.featureId ?? 'no ID'})`);
    console.log(`  Status:  ${e.status}${deps}${desc}`);

    // Get LLM advice for this item
    const itemContext = `## Production features (context)
${productionContext}

## Feature to review
${e.featureId ?? '?'} ${e.label} [${e.status}]
${e.description ?? 'No description.'}
${e.dependsOn.length ? `Dependencies: ${e.dependsOn.join(', ')}` : 'No dependencies.'}

Give your recommendation: ADVANCE, HOLD, or DROP. Explain in 2-3 sentences.`;

    try {
      console.log(`\n  Asking ${OLLAMA_MODEL}...`);
      const advice = await chat(systemPrompt, itemContext);
      console.log(`\n  LLM says:\n${indent(advice, '    ')}\n`);

      const answer = await ask('  Your decision (a=advance, h=hold, d=drop, s=skip, q=quit): ');

      if (answer.toLowerCase() === 'q') {
        console.log('\n  Ending review.\n');
        break;
      }

      if (answer.toLowerCase() === 's') {
        console.log('  Skipped.\n');
        continue;
      }

      const decision =
        answer.toLowerCase().startsWith('a') ? 'ADVANCE' :
        answer.toLowerCase().startsWith('h') ? 'HOLD' :
        answer.toLowerCase().startsWith('d') ? 'DROP' : answer.toUpperCase();

      let userNote = '';
      if (decision !== 'SKIP') {
        userNote = await ask('  Note (optional, enter to skip): ');
      }

      decisions.push({ entity: e, decision, llmAdvice: advice, userNote });
      console.log(`  Recorded: ${e.label} → ${decision}\n`);

    } catch (err) {
      console.error(`  LLM error: ${err instanceof Error ? err.message : err}`);
      const answer = await ask('  Decide without LLM (a/h/d/s/q): ');
      if (answer.toLowerCase() === 'q') break;
      if (answer.toLowerCase() === 's') continue;
      const decision =
        answer.toLowerCase().startsWith('a') ? 'ADVANCE' :
        answer.toLowerCase().startsWith('h') ? 'HOLD' :
        answer.toLowerCase().startsWith('d') ? 'DROP' : answer.toUpperCase();
      decisions.push({ entity: e, decision, llmAdvice: '(LLM unavailable)', userNote: '' });
    }
  }

  // Summary
  if (decisions.length > 0) {
    console.log('  ═══ Review Summary ═══════════════════════════════════════\n');
    const groups = { ADVANCE: [] as typeof decisions, HOLD: [] as typeof decisions, DROP: [] as typeof decisions, OTHER: [] as typeof decisions };
    for (const d of decisions) {
      const bucket = groups[d.decision as keyof typeof groups] ?? groups.OTHER;
      bucket.push(d);
    }
    for (const [label, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      const icon = label === 'ADVANCE' ? '▶' : label === 'HOLD' ? '⏸' : label === 'DROP' ? '✗' : '?';
      console.log(`  ${icon} ${label} (${items.length}):`);
      for (const d of items) {
        const note = d.userNote ? ` — ${d.userNote}` : '';
        console.log(`    ${(d.entity.featureId ?? '?').padEnd(5)} ${d.entity.label}${note}`);
      }
      console.log();
    }

    // Offer to apply status changes
    const apply = await ask('  Apply status changes to TTL file? (y/n): ');
    if (apply.toLowerCase() === 'y') {
      const kbPath = join(PROJECT_ROOT, KB_FILES[KB_NAME]);
      let ttlContent = readFileSync(kbPath, 'utf8');
      let changes = 0;

      for (const d of decisions) {
        if (d.decision === 'DROP') {
          // Mark as dropped by adding a comment (don't delete, let human do that)
          const labelPattern = `rdfs:label   "${d.entity.label}"`;
          if (ttlContent.includes(labelPattern)) {
            ttlContent = ttlContent.replace(
              labelPattern,
              `rdfs:label   "${d.entity.label}" ;\n               kpred:review-note "${d.decision}: ${d.userNote || 'dropped in review'}"`
            );
            changes++;
          }
        }
      }

      if (changes > 0) {
        writeFileSync(kbPath, ttlContent);
        console.log(`  Applied ${changes} annotations to ${KB_FILES[KB_NAME]}\n`);
      } else {
        console.log('  No changes to apply.\n');
      }
    }

    if (SAVE) {
      const outPath = join(RESULTS_DIR, `kb-review_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`);
      mkdirSync(RESULTS_DIR, { recursive: true });
      const md = decisions.map(d =>
        `### ${d.entity.label} (${d.entity.featureId ?? '?'})\n- **Decision**: ${d.decision}\n- **User note**: ${d.userNote || '(none)'}\n- **LLM advice**: ${d.llmAdvice.slice(0, 300)}\n`
      ).join('\n');
      writeFileSync(outPath, `# KB Review: ${KB_NAME}\n\nModel: ${OLLAMA_MODEL}\nDate: ${new Date().toISOString()}\nItems reviewed: ${decisions.length}\n\n${md}`);
      console.log(`  Saved: ${outPath}\n`);
    }
  }
}

async function cmdReckon() {
  const triples = loadKB();
  const entities = extractEntities(triples);

  const customQuery = param('query', '');

  // Build compressed KB context
  const features = entities.filter(e => e.featureId || e.status);
  const context = features.map(e => {
    const deps = e.dependsOn.length ? ` deps:[${e.dependsOn.join(',')}]` : '';
    const desc = e.description ? ` "${e.description.slice(0, 120)}"` : '';
    return `${e.featureId ?? '-'} ${e.label} [${e.status ?? '?'}]${deps}${desc}`;
  }).join('\n');

  // Phase 1: Gather situation + target from the user
  console.log(`\n  Reckoning: ${KB_NAME}`);
  console.log(`  Model: ${OLLAMA_MODEL}`);
  console.log(`  Features: ${features.length} (${features.filter(e => e.status === 'production').length} prod, ${features.filter(e => e.status === 'planned').length} planned)\n`);

  let situation: string;
  if (customQuery) {
    situation = customQuery;
  } else {
    const defaultSituation = `Reckons.AI is a local-first personal knowledge graph with ${features.filter(e => e.status === 'production').length} production features and ${features.filter(e => e.status === 'planned').length} planned features.`;
    console.log(`  Default situation: ${defaultSituation}`);
    const customSit = await ask('  Situation (enter for default, or type your own): ');
    situation = customSit || defaultSituation;
  }

  let target: string;
  if (customQuery) {
    target = customQuery;
  } else {
    const defaultTarget = 'Determine the optimal priority ordering of all planned roadmap items. Identify the top 3 items to work on next.';
    console.log(`  Default target: ${defaultTarget}`);
    const customTgt = await ask('  Target (enter for default, or type your own): ');
    target = customTgt || defaultTarget;
  }

  // Phase 2: LLM analysis
  const systemPrompt = `You are a strategic product advisor performing a "Reckoning" — a Situation-Target-Proposal analysis.

Given a knowledge base of features with statuses and dependencies, you must:
1. Assess the SITUATION (current state, strengths, gaps)
2. Clarify the TARGET (what we're trying to achieve)
3. Propose concrete OPTIONS, each grounded in the KB data

Rules:
- Every claim must reference a specific feature from the KB
- Consider dependency chains — don't recommend something whose dependencies aren't ready
- Prefer features that unlock other features (force multipliers)
- Weight user-facing impact heavily
- Be specific and actionable, not vague`;

  const userPrompt = `## Knowledge Base: ${KB_NAME}
${context}

## Situation
${situation}

## Target
${target}

Produce a Situation-Target-Proposal analysis. Include:
1. Current state assessment (what's strong, what's missing)
2. Priority-ordered list of next features with rationale
3. Dependency warnings
4. Estimated impact per feature (high/medium/low)`;

  console.log(`\n  Sending to ${OLLAMA_MODEL}...\n`);

  try {
    const start = Date.now();
    const response = await chat(systemPrompt, userPrompt);
    const elapsed = Date.now() - start;

    console.log('  ═══ Reckoning ═══════════════════════════════════════════\n');
    console.log(response);
    console.log(`\n  ═══ (${(elapsed / 1000).toFixed(1)}s) ═════════════════════════════════════\n`);

    // Phase 3: Interactive follow-up loop
    let prevResponse = response;
    let conversationLog = response;
    while (true) {
      const followUp = await ask('  Follow-up question? (enter to continue to proposals): ');
      if (!followUp) break;
      console.log(`\n  Asking ${OLLAMA_MODEL}...\n`);
      prevResponse = await chat(
        systemPrompt,
        `${userPrompt}\n\n## Previous analysis:\n${prevResponse}\n\n## Follow-up:\n${followUp}`
      );
      console.log(prevResponse);
      conversationLog += `\n\n## Follow-up: ${followUp}\n\n${prevResponse}`;
      console.log();
    }

    // Phase 4: Extract proposed triples from the reckoning
    console.log('  ─── Extracting proposals as triples ───────────────────\n');
    console.log(`  Asking ${OLLAMA_MODEL} to propose KB changes...\n`);

    const triplePrompt = `Based on this reckoning analysis, propose specific changes to the knowledge base as RDF-style triples.

## Analysis
${prevResponse}

## Current KB entities
${features.map(e => `${e.iri.split('/').pop()} [${e.status ?? '?'}]`).join(', ')}

Output ONLY a JSON array of proposed triples. Each triple:
{
  "subject": "kebab-case-entity",
  "predicate": "has-status|has-priority|depends-on|description|review-note",
  "object": "value",
  "objectIsLiteral": true/false,
  "rationale": "why this change"
}

Propose changes like:
- Updating priorities (has-priority: "high"/"medium"/"low")
- Status changes if warranted (has-status: "advancing"/"on-hold"/"dropped")
- New dependency edges (depends-on: existing-entity)
- Review notes capturing the reckoning insight (review-note: "...")
- New entities if the analysis identified gaps (with description)

Be selective — only propose changes the analysis strongly supports. 5-15 triples maximum.
Output ONLY the JSON array, no prose.`;

    const tripleResponse = await chat(
      'You extract structured data from analysis text. Output ONLY valid JSON arrays. No prose, no markdown fences.',
      triplePrompt
    );

    // Parse proposed triples
    interface ProposedTriple {
      subject: string;
      predicate: string;
      object: string;
      objectIsLiteral: boolean;
      rationale: string;
    }

    let proposals: ProposedTriple[] = [];
    try {
      let jsonText = tripleResponse.trim();
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const startIdx = jsonText.indexOf('[');
      const endIdx = jsonText.lastIndexOf(']');
      if (startIdx >= 0 && endIdx > startIdx) {
        jsonText = jsonText.slice(startIdx, endIdx + 1);
      }
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) {
        proposals = parsed.filter((t: unknown) => {
          const r = t as Record<string, unknown>;
          return r && typeof r.subject === 'string' && typeof r.predicate === 'string' && r.object != null;
        });
      }
    } catch {
      console.log('  Could not parse LLM triple proposals. Raw output:\n');
      console.log(indent(tripleResponse, '    '));
      console.log();
    }

    // Phase 5: Human review of proposed triples
    if (proposals.length > 0) {
      console.log(`  ${proposals.length} proposed triples:\n`);

      const approved: ProposedTriple[] = [];
      const rejected: ProposedTriple[] = [];

      for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        console.log(`  [${i + 1}/${proposals.length}] ${p.subject} → ${p.predicate} → ${p.objectIsLiteral ? `"${p.object}"` : p.object}`);
        if (p.rationale) console.log(`           ${p.rationale}`);

        const answer = await ask('    approve? (y/n/e=edit/q=quit): ');

        if (answer.toLowerCase() === 'q') {
          console.log('  Stopping triple review.\n');
          break;
        }

        if (answer.toLowerCase() === 'e') {
          const newObj = await ask(`    new object value (was "${p.object}"): `);
          if (newObj) p.object = newObj;
          approved.push(p);
          console.log(`    Approved (edited): ${p.subject} → ${p.predicate} → ${p.object}\n`);
        } else if (answer.toLowerCase() === 'y') {
          approved.push(p);
          console.log('    Approved.\n');
        } else {
          rejected.push(p);
          console.log('    Rejected.\n');
        }
      }

      // Phase 6: Write approved triples
      if (approved.length > 0) {
        console.log(`\n  ═══ Approved ${approved.length} triples ═══\n`);
        for (const t of approved) {
          console.log(`    ${t.subject} → ${t.predicate} → ${t.objectIsLiteral ? `"${t.object}"` : t.object}`);
        }

        // Option A: Append to TTL file directly
        const doWrite = await ask(`\n  Append to ${KB_FILES[KB_NAME]}? (y/n): `);
        if (doWrite.toLowerCase() === 'y') {
          const kbPath = join(PROJECT_ROOT, KB_FILES[KB_NAME]);
          const timestamp = new Date().toISOString().slice(0, 10);

          let ttlBlock = `\n# ── Reckoning proposals (${timestamp}, ${OLLAMA_MODEL}) ────────────────────\n\n`;
          for (const t of approved) {
            const subj = t.subject.includes(':') ? t.subject : `kb:${t.subject}`;
            const pred = t.predicate.includes(':') ? t.predicate : `kpred:${t.predicate}`;
            const obj = t.objectIsLiteral
              ? `"${t.object.replace(/"/g, '\\"')}"`
              : (t.object.includes(':') ? t.object : `kb:${t.object}`);
            ttlBlock += `${subj.padEnd(20)} ${pred.padEnd(22)} ${obj} .\n`;
          }

          const existingContent = readFileSync(kbPath, 'utf8');
          writeFileSync(kbPath, existingContent + ttlBlock);
          console.log(`  Appended ${approved.length} triples to ${KB_FILES[KB_NAME]}`);
        }

        // Option B: Also write to pending.jsonl for web app review queue
        const workspacePath = join(PROJECT_ROOT, 'mcp-workspace/kbs');
        const kbFolders = existsSync(workspacePath)
          ? ['roadmap', 'production', 'features'].filter(n => existsSync(join(workspacePath, n)))
          : [];
        const targetFolder = kbFolders.find(f => f === KB_NAME);
        if (targetFolder) {
          const pendingPath = join(workspacePath, targetFolder, 'pending.jsonl');
          const now = new Date().toISOString();
          for (const t of approved) {
            const entry = JSON.stringify({
              subject: t.subject.includes(':') ? t.subject : `urn:kbase:${t.subject}`,
              predicate: t.predicate.includes(':') ? t.predicate : `urn:kbase:predicate/${t.predicate}`,
              object: t.object,
              note: t.rationale ?? `Reckoning proposal (${OLLAMA_MODEL})`,
              type: 'suggestion',
              agent: `kb-workflow/${OLLAMA_MODEL}`,
              priority: 'normal',
              addedByMcp: true,
              addedAt: now,
            });
            appendFileSync(pendingPath, entry + '\n');
          }
          console.log(`  Queued ${approved.length} proposals to ${targetFolder}/pending.jsonl`);
          console.log(`  Open Review page and click ↻ to import.`);
        }
      }

      if (rejected.length > 0) {
        console.log(`  Rejected ${rejected.length} triples.\n`);
      }
    }

    // Save the full session
    if (SAVE) {
      const outPath = join(RESULTS_DIR, `kb-reckon_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`);
      mkdirSync(RESULTS_DIR, { recursive: true });
      const proposalMd = proposals.length > 0
        ? `\n## Proposed Triples\n\n${proposals.map(p => `- ${p.subject} → ${p.predicate} → ${p.objectIsLiteral ? `"${p.object}"` : p.object} — ${p.rationale ?? ''}`).join('\n')}\n`
        : '';
      writeFileSync(outPath, `# Reckoning: ${KB_NAME}\n\nModel: ${OLLAMA_MODEL}\nDate: ${new Date().toISOString()}\nDuration: ${(elapsed / 1000).toFixed(1)}s\nKB: ${KB_FILES[KB_NAME]}\n\n## Situation\n${situation}\n\n## Target\n${target}\n\n## KB Context\n\`\`\`\n${context}\n\`\`\`\n\n## Analysis\n\n${conversationLog}\n${proposalMd}`);
      console.log(`  Saved: ${outPath}\n`);
    }

  } catch (err) {
    console.error(`  Error: ${err instanceof Error ? err.message : err}`);
    console.error(`  Is Ollama running at ${OLLAMA_URL}?`);
    process.exit(1);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  switch (command) {
    case 'stats': await cmdStats(); break;
    case 'search': await cmdSearch(); break;
    case 'entity': await cmdEntity(); break;
    case 'review': await cmdReview(); break;
    case 'reckon': await cmdReckon(); break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: stats, search, entity, review, reckon');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
