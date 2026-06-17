#!/usr/bin/env node
/**
 * Reckons.AI MCP Server
 *
 * Exposes a Reckons.AI knowledge base (.ttl file) as MCP tools
 * that any compatible AI agent (Claude, Cursor, Windsurf, etc.) can call.
 *
 * Usage:
 *   node dist/index.js --kb /path/to/knowledge.ttl
 *
 * Or configure in your MCP client (e.g. Claude Desktop ~/.config/claude/mcp.json):
 *   {
 *     "reckons": {
 *       "command": "node",
 *       "args": ["/path/to/reckons-ai-mcp/dist/index.js", "--kb", "/path/to/kb.ttl"]
 *     }
 *   }
 *
 * MCP Protocol: JSON-RPC 2.0 over stdio
 * Spec: https://modelcontextprotocol.io/
 */

import { createInterface } from 'node:readline';
import { KBReader } from './kb-reader.js';
import { bm25Search, invalidateCache } from './search.js';

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const kbFlag = args.indexOf('--kb');
const kbPath = kbFlag >= 0 ? args[kbFlag + 1] : (process.env.RECKONS_KB_PATH ?? './knowledge.ttl');

if (!kbPath) {
  process.stderr.write('Usage: reckons-mcp --kb /path/to/knowledge.ttl\n');
  process.exit(1);
}

const kb = new KBReader(kbPath);
kb.watch(() => {
  invalidateCache();
  process.stderr.write(`[reckons-mcp] KB reloaded\n`);
});

process.stderr.write(`[reckons-mcp] Loaded KB from ${kbPath} (${kb.stats().tripleCount} triples)\n`);

// ── MCP Tool Definitions ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'kb_search',
    description: 'Search the knowledge base using full-text BM25 search. Returns the most relevant statements (subject-predicate-object triples) matching the query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'kb_get_entity',
    description: 'Get all known facts about a specific entity in the KB. Accepts an entity IRI or a name/slug that will be resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity IRI (e.g. urn:kbase:person/alice) or a name/slug to look up' }
      },
      required: ['entity']
    }
  },
  {
    name: 'kb_stats',
    description: 'Get statistics about the knowledge base: triple count, entity count, source count, last modified.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kb_list_entities',
    description: 'List all entity IRIs in the knowledge base. Use kb_get_entity to fetch details about specific ones.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entities to return (default 50)', default: 50 }
      }
    }
  },
  {
    name: 'kb_add_note',
    description: 'Add a note or observation to the knowledge base as a pending statement for human review. The note will appear in the Reckons.AI review queue — it is NOT automatically confirmed.',
    inputSchema: {
      type: 'object',
      properties: {
        subject:   { type: 'string', description: 'Subject entity slug (e.g. "project-x", "alice")' },
        predicate: { type: 'string', description: 'Predicate slug (e.g. "has-status", "works-with")' },
        object:    { type: 'string', description: 'Object value or entity slug' },
        note:      { type: 'string', description: 'Optional human-readable context for the reviewer' }
      },
      required: ['subject', 'predicate', 'object']
    }
  },
  {
    name: 'kb_subgraph',
    description: 'Extract a focused neighborhood around an entity (1-2 hops). More efficient than kb_get_entity for understanding context around a specific topic.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity IRI or name/slug to center the subgraph on' },
        hops:   { type: 'number', description: 'Number of hops from the entity (default 1, max 2)', default: 1 },
        limit:  { type: 'number', description: 'Max triples to return (default 30, max 60)', default: 30 }
      },
      required: ['entity']
    }
  },
  {
    name: 'kb_reckoning',
    description: 'Run an STP (Situation-Target-Proposal) analysis using the knowledge base. Returns a structured proposal with KB citations.',
    inputSchema: {
      type: 'object',
      properties: {
        situation: { type: 'string', description: 'Current situation description' },
        target:    { type: 'string', description: 'Desired outcome or goal' }
      },
      required: ['situation', 'target']
    }
  }
];

// ── Tool Handlers ─────────────────────────────────────────────────────────────

/** Compact triple format: subject .predicate value */
function fmtTriple(t: { subject: string; predicate: string; object: string }): string {
  const s = t.subject.split('/').pop() ?? t.subject;
  const p = t.predicate.split('/').pop() ?? t.predicate;
  return `${s} .${p} ${t.object}`;
}

function handleKbSearch(params: { query: string; limit?: number }): object {
  kb.reload();
  const triples = kb.allTriples();
  const results = bm25Search(triples, params.query, Math.min(params.limit ?? 10, 50));

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No results in this KB for "${params.query}" (absence doesn't mean nonexistence)` }] };
  }

  const lines = results.map(r => fmtTriple(r.triple));

  return {
    content: [{
      type: 'text',
      text: `${results.length} results:\n${lines.join('\n')}`
    }]
  };
}

function handleKbGetEntity(params: { entity: string }): object {
  kb.reload();
  let iri = params.entity;

  if (!iri.startsWith('urn:') && !iri.startsWith('http')) {
    const resolved = kb.resolveLabel(iri);
    if (!resolved) {
      return { content: [{ type: 'text', text: `Not found in this KB: "${iri}". Use kb_search or kb_list_entities.` }] };
    }
    iri = resolved;
  }

  const triples = kb.triplesAbout(iri);
  if (triples.length === 0) {
    return { content: [{ type: 'text', text: `No facts in this KB for: ${iri}` }] };
  }

  const MAX = 40;
  const capped = triples.slice(0, MAX);
  const slug = iri.split('/').pop() ?? iri;

  const asSubject = capped.filter(t => t.subject === iri);
  const asObject  = capped.filter(t => t.object  === iri);

  const lines: string[] = [slug];
  for (const t of asSubject) {
    const p = t.predicate.split('/').pop() ?? t.predicate;
    lines.push(`.${p} ${t.object}`);
  }
  if (asObject.length > 0) {
    lines.push('refs:');
    for (const t of asObject) {
      const s = t.subject.split('/').pop() ?? t.subject;
      const p = t.predicate.split('/').pop() ?? t.predicate;
      lines.push(`${s} .${p}`);
    }
  }
  if (triples.length > MAX) lines.push(`(+${triples.length - MAX} more)`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleKbStats(): object {
  kb.reload();
  const s = kb.stats();
  const text = [
    `Knowledge base stats:`,
    `  Triples:      ${s.tripleCount}`,
    `  Entities:     ${s.entityCount}`,
    `  Sources:      ${s.sourceCount}`,
    `  Last modified: ${s.lastModified.toISOString()}`,
    `  KB file:      ${kbPath}`
  ].join('\n');
  return { content: [{ type: 'text', text }] };
}

function handleKbListEntities(params: { limit?: number }): object {
  kb.reload();
  const allIris = kb.entityIRIs();
  const cap = Math.min(params.limit ?? 50, 100);
  const iris = allIris.slice(0, cap);
  if (iris.length === 0) {
    return { content: [{ type: 'text', text: 'KB empty.' }] };
  }
  // Compact: just slugs, one per line
  const lines = iris.map(iri => iri.split('/').pop() ?? iri);
  const suffix = allIris.length > cap ? `\n(+${allIris.length - cap} more)` : '';
  return {
    content: [{
      type: 'text',
      text: `${allIris.length} entities:\n${lines.join('\n')}${suffix}`
    }]
  };
}

function handleKbAddNote(params: { subject: string; predicate: string; object: string; note?: string }): object {
  // Write a pending triple to a sidecar .pending.jsonl file next to the .ttl
  // The Reckons.AI app reads this on next launch and queues for review.
  import('node:fs').then(({ appendFileSync }) => {
    const pendingPath = kbPath.replace(/\.ttl$/, '.pending.jsonl');
    const entry = JSON.stringify({
      subject: `urn:kbase:${params.subject.replace(/\s+/g, '-').toLowerCase()}`,
      predicate: `urn:kbase:predicate/${params.predicate.replace(/\s+/g, '-').toLowerCase()}`,
      object: params.object,
      note: params.note,
      addedByMcp: true,
      addedAt: new Date().toISOString()
    });
    appendFileSync(pendingPath, entry + '\n', 'utf8');
  });

  return {
    content: [{
      type: 'text',
      text: `Queued for review: ${params.subject} — ${params.predicate} → ${params.object}\n\nOpen Reckons.AI review queue to confirm or reject.`
    }]
  };
}

function handleKbSubgraph(params: { entity: string; hops?: number; limit?: number }): object {
  kb.reload();
  let iri = params.entity;

  if (!iri.startsWith('urn:') && !iri.startsWith('http')) {
    const resolved = kb.resolveLabel(iri);
    if (!resolved) {
      return { content: [{ type: 'text', text: `Not found: "${iri}". Use kb_search.` }] };
    }
    iri = resolved;
  }

  const hops = Math.min(params.hops ?? 1, 2);
  const limit = Math.min(params.limit ?? 30, 60);
  const triples = kb.subgraph(iri, hops).slice(0, limit);

  if (triples.length === 0) {
    return { content: [{ type: 'text', text: `No facts near: ${iri}` }] };
  }

  const lines = triples.map(t => fmtTriple(t));
  const slug = iri.split('/').pop() ?? iri;
  return {
    content: [{
      type: 'text',
      text: `${slug} (${hops}-hop, ${triples.length} triples):\n${lines.join('\n')}`
    }]
  };
}

function handleKbReckoning(params: { situation: string; target: string }): object {
  kb.reload();
  const triples = kb.allTriples();

  const situationHits = bm25Search(triples, params.situation, 8);
  const targetHits    = bm25Search(triples, params.target, 8);

  const combined = [...new Map(
    [...situationHits, ...targetHits].map(r => [r.triple.subject + r.triple.predicate + r.triple.object, r])
  ).values()].slice(0, 12);

  const kbContext = combined.length > 0
    ? combined.map(r => fmtTriple(r.triple)).join('\n')
    : '(no relevant facts)';

  const prompt = [
    `SITUATION: ${params.situation}`,
    `TARGET: ${params.target}`,
    `KB FACTS:\n${kbContext}`,
    '',
    'Provide a structured proposal: options, recommendation, confidence. Cite KB facts. Max 250 words.'
  ].join('\n');

  return {
    content: [{
      type: 'text',
      text: `Reckoning context:\n\n${prompt}`
    }]
  };
}

// ── MCP Protocol (JSON-RPC 2.0 over stdio) ────────────────────────────────────

function respond(id: number | string | null, result: object): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id: number | string | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let req: { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    respondError(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params = {} } = req;

  try {
    switch (method) {
      case 'initialize':
        respond(id ?? null, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'reckons-ai-mcp', version: '0.1.0' }
        });
        break;

      case 'tools/list':
        respond(id ?? null, { tools: TOOLS });
        break;

      case 'tools/call': {
        const toolName = (params as { name?: string; arguments?: Record<string, unknown> }).name;
        const toolArgs = (params as { name?: string; arguments?: Record<string, unknown> }).arguments ?? {};

        let result: object;
        switch (toolName) {
          case 'kb_search':       result = handleKbSearch(toolArgs as { query: string; limit?: number }); break;
          case 'kb_get_entity':   result = handleKbGetEntity(toolArgs as { entity: string }); break;
          case 'kb_stats':        result = handleKbStats(); break;
          case 'kb_list_entities':result = handleKbListEntities(toolArgs as { limit?: number }); break;
          case 'kb_add_note':     result = handleKbAddNote(toolArgs as { subject: string; predicate: string; object: string; note?: string }); break;
          case 'kb_subgraph':    result = handleKbSubgraph(toolArgs as { entity: string; hops?: number; limit?: number }); break;
          case 'kb_reckoning':    result = handleKbReckoning(toolArgs as { situation: string; target: string }); break;
          default:
            respondError(id ?? null, -32601, `Unknown tool: ${toolName}`);
            return;
        }
        respond(id ?? null, result);
        break;
      }

      case 'notifications/initialized':
        // No-op acknowledgement
        break;

      default:
        respondError(id ?? null, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    respondError(id ?? null, -32603, `Internal error: ${msg}`);
  }
});

rl.on('close', () => process.exit(0));
