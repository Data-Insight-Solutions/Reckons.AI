#!/usr/bin/env node
/**
 * Reckons.AI MCP Server
 *
 * Exposes a Reckons.AI knowledge base as MCP tools
 * that any compatible AI agent (Claude, Cursor, Windsurf, etc.) can call.
 *
 * Usage:
 *   # Workspace mode (recommended) — reads all KBs from kbs/{name}/{name}.ttl
 *   # (legacy kbs/{name}/kb.ttl is read as a fallback):
 *   node dist/index.js --kb /path/to/workspace/
 *
 *   # Legacy single-file mode:
 *   node dist/index.js --kb /path/to/knowledge.ttl
 *
 * MCP Protocol: JSON-RPC 2.0 over stdio
 * Spec: https://modelcontextprotocol.io/
 */

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MultiKBReader, type Triple } from './kb-reader.js';
import { bm25Search, invalidateCache } from './search.js';
import { gitStatus, gitLog, gitChangedFiles } from './git-utils.js';
import { ollamaEnabled, OLLAMA_DISABLED_MESSAGE, OLLAMA_MODEL } from './ollama-client.js';
import { extractTriplesLocally, summarizeLocally } from './local-llm.js';
import { entityToMarkdown } from './entity-markdown.js';
import { generatePageMarkdown, type GeneratePageParams } from './generate-page.js';
import type { PageTemplate } from './page-markdown.js';

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const kbFlag = args.indexOf('--kb');
const kbPath = kbFlag >= 0 ? args[kbFlag + 1] : (process.env.RECKONS_KB_PATH ?? './knowledge.ttl');

if (!kbPath) {
  process.stderr.write('Usage: reckons-mcp --kb /path/to/workspace/  (or /path/to/knowledge.ttl)\n');
  process.exit(1);
}

const kb = new MultiKBReader(kbPath);
kb.watch(() => {
  invalidateCache();
  process.stderr.write(`[reckons-mcp] KB reloaded\n`);
});

const kbList = kb.listKbs();
if (kb.isLegacy()) {
  const s = kb.stats();
  process.stderr.write(`[reckons-mcp] Legacy mode: loaded ${s.tripleCount} triples from ${kbPath}\n`);
} else {
  process.stderr.write(`[reckons-mcp] Workspace mode: ${kbList.length} KB(s) from ${kbPath}\n`);
  for (const k of kbList) {
    process.stderr.write(`  - ${k.name} (${k.stats.tripleCount} triples)\n`);
  }
}

// ── Shared parameter for KB targeting ───────────────────────────────────────

const KB_PARAM = {
  kb: {
    type: 'string',
    description: 'Target a specific KB by name or folder. Omit to search all KBs.'
  }
};

// ── MCP Tool Definitions ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'kb_list_kbs',
    description: 'List all knowledge bases available in the workspace, with their names, triple counts, and descriptions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kb_search',
    description: 'Search the knowledge base using full-text BM25 search. Returns the most relevant statements (subject-predicate-object triples) matching the query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50)', default: 10 },
        ...KB_PARAM
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
        entity: { type: 'string', description: 'Entity IRI (e.g. urn:kbase:person/alice) or a name/slug to look up' },
        ...KB_PARAM
      },
      required: ['entity']
    }
  },
  {
    name: 'kb_stats',
    description: 'Get statistics about the knowledge base: triple count, entity count, source count, last modified. When multiple KBs exist, shows aggregate stats.',
    inputSchema: {
      type: 'object',
      properties: { ...KB_PARAM }
    }
  },
  {
    name: 'kb_list_entities',
    description: 'List all entity IRIs in the knowledge base. Use kb_get_entity to fetch details about specific ones.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entities to return (default 50)', default: 50 },
        ...KB_PARAM
      }
    }
  },
  {
    name: 'kb_add_note',
    description: 'Add a note or observation to a knowledge base as a pending statement for human review. The note will appear in the Reckons.AI review queue — it is NOT automatically confirmed.',
    inputSchema: {
      type: 'object',
      properties: {
        subject:   { type: 'string', description: 'Subject entity slug (e.g. "project-x", "alice")' },
        predicate: { type: 'string', description: 'Predicate slug (e.g. "has-status", "works-with")' },
        object:    { type: 'string', description: 'Object value or entity slug' },
        note:      { type: 'string', description: 'Optional human-readable context for the reviewer' },
        type:      { type: 'string', enum: ['observation', 'question', 'suggestion', 'status-update', 'drift-warning'], description: 'Kind of note (default: observation)' },
        commit_sha: { type: 'string', description: 'Git commit SHA this note relates to' },
        agent:     { type: 'string', description: 'Agent identifier (e.g. "claude-code")' },
        priority:  { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority level (default: normal)' },
        ...KB_PARAM
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
        limit:  { type: 'number', description: 'Max triples to return (default 30, max 60)', default: 30 },
        ...KB_PARAM
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
        target:    { type: 'string', description: 'Desired outcome or goal' },
        ...KB_PARAM
      },
      required: ['situation', 'target']
    }
  },
  {
    name: 'kb_list_sources',
    description: 'List all sources in the knowledge base with their kind, URI, and refresh status. Shows which sources can be refreshed (URLs, repos) vs static (notes, documents).',
    inputSchema: {
      type: 'object',
      properties: { ...KB_PARAM }
    }
  },
  {
    name: 'kb_request_refresh',
    description: 'Request a refresh of one or all refreshable sources (URL, repository, calendar). Writes a refresh request that the Reckons.AI web app will pick up on next load.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Specific source ID to refresh. Omit to request refresh of all refreshable sources.' },
        ...KB_PARAM
      }
    }
  },
  {
    name: 'kb_git_status',
    description: 'Show current git branch, staged/modified files, and recent commits. Gives agents development context awareness.',
    inputSchema: {
      type: 'object',
      properties: {
        commits: { type: 'number', description: 'Number of recent commits to include (default 5, max 20)', default: 5 },
        diff: { type: 'boolean', description: 'Include list of changed files in diff (default false)', default: false }
      }
    }
  },
  {
    name: 'kb_check_plan',
    description: 'Check alignment of current work against the knowledge base. BM25 searches all KBs for matching features/entities and returns their statuses. The agent reasons about drift — this tool assembles context.',
    inputSchema: {
      type: 'object',
      properties: {
        work: { type: 'string', description: 'Description of current or planned work' },
        commits: { type: 'number', description: 'Include last N commit messages for cross-reference (default 0)', default: 0 },
        ...KB_PARAM
      },
      required: ['work']
    }
  },
  {
    name: 'kb_pending',
    description: 'List pending proposals from pending.jsonl files. Prevents duplicate proposals and lets agents see queued work.',
    inputSchema: {
      type: 'object',
      properties: { ...KB_PARAM }
    }
  },
  {
    name: 'kb_git_diff_triples',
    description: 'Cross-reference git changes with KB entities. Shows which KB facts relate to recently changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to diff from (default "HEAD~1")', default: 'HEAD~1' },
        ...KB_PARAM
      }
    }
  },
  {
    name: 'kb_alignment_score',
    description: 'Compute a quantitative alignment score (0.0–1.0) measuring how well recent git work aligns with the KB plan. Scores four dimensions: coverage (changed files with KB matches), status alignment (touching features in the right lifecycle state), dependency respect (dependencies already met), and scope discipline (planned vs unplanned work ratio). Returns composite score + per-dimension breakdown + per-entity verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to diff from (default "HEAD~5")', default: 'HEAD~5' },
        work: { type: 'string', description: 'Optional description of intended work to improve BM25 matching' },
        ...KB_PARAM
      }
    }
  },
  {
    name: 'kb_compress',
    description: 'Compress knowledge graph context for LLM consumption. Takes a topic query, extracts the relevant subgraph, and returns a compact, token-efficient representation preserving semantic meaning. Ideal for injecting KB context into LLM prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or question to extract context for' },
        budget: { type: 'number', description: 'Approximate token budget (default 2000, max 8000)', default: 2000 },
        hops: { type: 'number', description: 'Neighbourhood hops per matched entity (default 1, max 2)', default: 1 },
        ...KB_PARAM
      },
      required: ['query']
    }
  },
  {
    name: 'kb_local_extract',
    description: 'Extract subject-predicate-object triples from text using a LOCAL Ollama model, offloading bulk extraction work away from cloud/session tokens. Returns proposed triples (JSON + Turtle) for review — does NOT write to any KB. Requires OLLAMA_BASE_URL to be set (disabled by default); when disabled, returns instructions for enabling it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Source text to extract triples from' },
        source: { type: 'string', description: 'Optional source title/label for context (shown in the extraction prompt)' },
        ...KB_PARAM
      },
      required: ['text']
    }
  },
  {
    name: 'kb_local_summarize',
    description: 'Summarize an entity\'s subgraph or raw text using a LOCAL Ollama model, offloading bulk summarization work away from cloud/session tokens. Provide exactly one of entity or text. Requires OLLAMA_BASE_URL to be set (disabled by default); when disabled, returns instructions for enabling it.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity IRI or name/slug to summarize (pulls its 1-hop subgraph, like kb_subgraph)' },
        text: { type: 'string', description: 'Raw text to summarize (alternative to entity)' },
        budget: { type: 'number', description: 'Approximate max words for the summary (default 150, max 1000)', default: 150 },
        ...KB_PARAM
      }
    }
  },
  {
    name: 'kb_generate_page',
    description: 'PROPOSAL ONLY — draft a documentation-page markdown document (frontmatter + body) from a prompt, grounded strictly in the knowledge graph via the same search→subgraph→compress pipeline as kb_compress. Requires a LOCAL Ollama model (opt-in via OLLAMA_BASE_URL; disabled by default). Never writes to any KB or file — returns the markdown plus the parsed JSON fields for review.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the page should be about / cover' },
        section: { type: 'string', description: 'Site section (default "docs")' },
        slug: { type: 'string', description: 'Page slug (default: kebab-case of the title)' },
        title: { type: 'string', description: 'Page title (default: model-generated from the prompt)' },
        template: { type: 'string', enum: ['landing', 'doc', 'full', 'sidebar', 'post'], description: 'Page template (default "doc"; "post" adds a date: today)' },
        budget: { type: 'number', description: 'Approximate token budget for the grounding context pulled from the graph (default 2000, max 8000)', default: 2000 },
        ...KB_PARAM
      },
      required: ['prompt']
    }
  },
  {
    name: 'kb_entity_markdown',
    description: 'Deterministically render one KB entity as a WebPage markdown document (frontmatter + body) from its triples — no LLM involved, works without OLLAMA_BASE_URL. rdfs:label becomes the title, description-ish literal predicates become body sections (and drive the excerpt), and relations become a markdown link list naming the target entities.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity IRI or a name/slug to resolve' },
        ...KB_PARAM
      },
      required: ['entity']
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

function handleKbListKbs(): object {
  kb.reload();
  const kbs = kb.listKbs();
  if (kbs.length === 0) {
    return { content: [{ type: 'text', text: 'No KBs found.' }] };
  }
  const lines = kbs.map(k => {
    return `${k.name} (${k.stats.tripleCount} triples, ${k.stats.entityCount} entities)`;
  });
  return { content: [{ type: 'text', text: `${kbs.length} KB(s):\n${lines.join('\n')}` }] };
}

function handleKbSearch(params: { query: string; limit?: number; kb?: string }): object {
  kb.reload();
  const triples = kb.allTriples(params.kb);
  const results = bm25Search(triples, params.query, Math.min(params.limit ?? 10, 50));

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No results${params.kb ? ` in "${params.kb}"` : ''} for "${params.query}" (absence doesn't mean nonexistence)` }] };
  }

  const lines = results.map(r => fmtTriple(r.triple));
  return {
    content: [{
      type: 'text',
      text: `${results.length} results:\n${lines.join('\n')}`
    }]
  };
}

function handleKbGetEntity(params: { entity: string; kb?: string }): object {
  kb.reload();
  let iri = params.entity;

  if (!iri.startsWith('urn:') && !iri.startsWith('http')) {
    const resolved = kb.resolveLabel(iri, params.kb);
    if (!resolved) {
      return { content: [{ type: 'text', text: `Not found: "${iri}". Use kb_search or kb_list_entities.` }] };
    }
    iri = resolved;
  }

  const triples = kb.triplesAbout(iri, params.kb);
  if (triples.length === 0) {
    return { content: [{ type: 'text', text: `No facts for: ${iri}` }] };
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

function handleKbStats(params: { kb?: string }): object {
  kb.reload();
  const s = kb.stats(params.kb);
  const lines = [
    `Knowledge base stats:`,
    `  KBs:          ${s.kbCount}`,
    `  Triples:      ${s.tripleCount}`,
    `  Entities:     ${s.entityCount}`,
    `  Sources:      ${s.sourceCount}`,
    `  Last modified: ${s.lastModified.toISOString()}`,
    `  Path:         ${kbPath}`
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleKbListEntities(params: { limit?: number; kb?: string }): object {
  kb.reload();
  const allIris = kb.entityIRIs(params.kb);
  const cap = Math.min(params.limit ?? 50, 100);
  const iris = allIris.slice(0, cap);
  if (iris.length === 0) {
    return { content: [{ type: 'text', text: 'KB empty.' }] };
  }
  const lines = iris.map(iri => iri.split('/').pop() ?? iri);
  const suffix = allIris.length > cap ? `\n(+${allIris.length - cap} more)` : '';
  return {
    content: [{
      type: 'text',
      text: `${allIris.length} entities:\n${lines.join('\n')}${suffix}`
    }]
  };
}

type AddNoteParams = {
  subject: string; predicate: string; object: string; note?: string;
  type?: string; commit_sha?: string; agent?: string; priority?: string;
  kb?: string;
};

function handleKbAddNote(params: AddNoteParams): object {
  const entry = JSON.stringify({
    subject: `urn:kbase:${params.subject.replace(/\s+/g, '-').toLowerCase()}`,
    predicate: `urn:kbase:predicate/${params.predicate.replace(/\s+/g, '-').toLowerCase()}`,
    object: params.object,
    note: params.note,
    type: params.type ?? 'observation',
    commitSha: params.commit_sha,
    agent: params.agent,
    priority: params.priority ?? 'normal',
    addedByMcp: true,
    addedAt: new Date().toISOString()
  });

  // Try workspace kbs/{name}/ folder first, fall back to legacy sidecar file
  const kbFolder = kb.getKbFolderPath(params.kb);
  if (kbFolder) {
    const pendingPath = join(kbFolder, 'pending.jsonl');
    appendFileSync(pendingPath, entry + '\n', 'utf8');
  } else {
    // Legacy: write next to the .ttl file
    const pendingPath = kbPath.replace(/\.ttl$/, '.pending.jsonl');
    appendFileSync(pendingPath, entry + '\n', 'utf8');
  }

  return {
    content: [{
      type: 'text',
      text: `Queued for review: ${params.subject} — ${params.predicate} → ${params.object}\n\nOpen Reckons.AI review queue to confirm or reject.`
    }]
  };
}

function handleKbSubgraph(params: { entity: string; hops?: number; limit?: number; kb?: string }): object {
  kb.reload();
  let iri = params.entity;

  if (!iri.startsWith('urn:') && !iri.startsWith('http')) {
    const resolved = kb.resolveLabel(iri, params.kb);
    if (!resolved) {
      return { content: [{ type: 'text', text: `Not found: "${iri}". Use kb_search.` }] };
    }
    iri = resolved;
  }

  const hops = Math.min(params.hops ?? 1, 2);
  const limit = Math.min(params.limit ?? 30, 60);
  const triples = kb.subgraph(iri, hops, params.kb).slice(0, limit);

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

function handleKbReckoning(params: { situation: string; target: string; kb?: string }): object {
  kb.reload();
  const triples = kb.allTriples(params.kb);

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

function handleKbListSources(params: { kb?: string }): object {
  kb.reload();
  const sources = kb.listSources(params.kb);

  if (sources.length === 0) {
    return { content: [{ type: 'text', text: 'No sources found. Sources are visible when using workspace mode with sources.json files.' }] };
  }

  const REFRESHABLE = new Set(['url', 'repository', 'calendar']);
  const lines = sources.map(({ kb: kbName, source: s }) => {
    const kind = String(s.kind ?? 'unknown');
    const refreshable = REFRESHABLE.has(kind);
    const title = String(s.title ?? '');
    const uri = String(s.uri ?? '');
    const id = String(s.id ?? '');
    const age = s.ingestedAt ? `${Math.round((Date.now() - Number(s.ingestedAt)) / 86400000)}d ago` : '';
    const sha = s.repoHeadSha ? ` @${String(s.repoHeadSha).slice(0, 8)}` : '';
    return `${refreshable ? '↻' : '·'} [${kind}] ${title} — ${uri}${sha} (${age}) id:${id.slice(0, 8)}`;
  });

  const refreshableCount = sources.filter(({ source: s }) => REFRESHABLE.has(String(s.kind))).length;
  return {
    content: [{
      type: 'text',
      text: `${sources.length} sources (${refreshableCount} refreshable):\n${lines.join('\n')}\n\n↻ = refreshable, · = static`
    }]
  };
}

function handleKbRequestRefresh(params: { source_id?: string; kb?: string }): object {
  const kbFolder = kb.getKbFolderPath(params.kb);
  if (!kbFolder) {
    return { content: [{ type: 'text', text: 'Refresh requires workspace mode. Use --kb /path/to/workspace/' }] };
  }

  const request = {
    type: 'refresh',
    sourceId: params.source_id ?? 'all',
    requestedAt: new Date().toISOString(),
    requestedBy: 'mcp',
  };

  const refreshPath = join(kbFolder, 'refresh-request.json');
  appendFileSync(refreshPath, JSON.stringify(request) + '\n', 'utf8');

  const msg = params.source_id
    ? `Refresh requested for source ${params.source_id}. Open Reckons.AI to process.`
    : `Refresh requested for all refreshable sources. Open Reckons.AI to process.`;

  return { content: [{ type: 'text', text: msg }] };
}

function handleKbGitStatus(params: { commits?: number; diff?: boolean }): object {
  try {
    const status = gitStatus();
    const commits = gitLog(params.commits ?? 5);

    const lines: string[] = [
      `Branch: ${status.branch}`,
      status.ahead || status.behind
        ? `Tracking: +${status.ahead} ahead / -${status.behind} behind`
        : 'Tracking: up to date',
    ];

    if (status.staged.length > 0) lines.push(`Staged (${status.staged.length}): ${status.staged.join(', ')}`);
    if (status.modified.length > 0) lines.push(`Modified (${status.modified.length}): ${status.modified.join(', ')}`);
    if (status.untracked.length > 0) lines.push(`Untracked (${status.untracked.length}): ${status.untracked.join(', ')}`);
    if (status.clean) lines.push('Working tree clean.');

    if (commits.length > 0) {
      lines.push('', `Recent commits (${commits.length}):`);
      for (const c of commits) {
        lines.push(`  ${c.shortHash} ${c.message} (${c.author}, ${c.filesChanged} files)`);
      }
    }

    if (params.diff) {
      try {
        const changed = gitChangedFiles('HEAD~1');
        if (changed.length > 0) {
          lines.push('', 'Files changed since HEAD~1:');
          for (const f of changed) lines.push(`  [${f.status}] ${f.path}`);
        }
      } catch { /* no prior commit */ }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Git unavailable: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

function handleKbCheckPlan(params: { work: string; commits?: number; kb?: string }): object {
  kb.reload();
  const triples = kb.allTriples(params.kb);
  const results = bm25Search(triples, params.work, 8);

  const sections: string[] = [`Plan check for: "${params.work}"`];

  if (results.length === 0) {
    sections.push('\nNo matching KB entities found. This work may be unplanned or uses different terminology.');
  } else {
    sections.push(`\n${results.length} KB matches:`);

    // Group by entity and fetch subgraph for each
    const entities = new Set<string>();
    for (const r of results) {
      entities.add(r.triple.subject);
    }

    for (const iri of entities) {
      const slug = iri.split('/').pop() ?? iri;
      const entityTriples = kb.triplesAbout(iri, params.kb);

      // Extract key facts: status, dependencies, description
      const facts: string[] = [];
      for (const t of entityTriples.slice(0, 10)) {
        const p = t.predicate.split('/').pop() ?? t.predicate;
        facts.push(`  .${p} ${t.object}`);
      }

      sections.push(`\n${slug}:`);
      sections.push(...facts);
    }
  }

  // Optionally cross-reference with recent commits
  if (params.commits && params.commits > 0) {
    try {
      const commits = gitLog(params.commits);
      if (commits.length > 0) {
        sections.push('\nRecent commits:');
        for (const c of commits) {
          sections.push(`  ${c.shortHash} ${c.message}`);
        }
      }
    } catch { /* git unavailable */ }
  }

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

function handleKbPending(params: { kb?: string }): object {
  const folders: string[] = [];

  if (kb.isLegacy()) {
    // Legacy: check sidecar file
    const legacyPath = kbPath.replace(/\.ttl$/, '.pending.jsonl');
    if (existsSync(legacyPath)) folders.push(legacyPath);
  } else {
    // Workspace: scan kbs/*/pending.jsonl
    const kbList = kb.listKbs();
    for (const k of kbList) {
      if (params.kb && !k.name.toLowerCase().includes(params.kb.toLowerCase()) && k.folderName !== params.kb) continue;
      const kbFolder = kb.getKbFolderPath(k.folderName);
      if (kbFolder) {
        const pendingPath = join(kbFolder, 'pending.jsonl');
        if (existsSync(pendingPath)) folders.push(pendingPath);
      }
    }
  }

  type PendingLine = { subject: string; predicate: string; object: string; note?: string; type?: string; priority?: string; agent?: string; addedAt?: string };
  const entries: Array<PendingLine & { file: string }> = [];

  for (const file of folders) {
    try {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as PendingLine;
          entries.push({ ...parsed, file });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }

  if (entries.length === 0) {
    return { content: [{ type: 'text', text: 'No pending proposals.' }] };
  }

  const lines = entries.map(e => {
    const s = e.subject.split('/').pop() ?? e.subject;
    const p = e.predicate.split('/').pop() ?? e.predicate;
    const tag = e.type && e.type !== 'observation' ? `[${e.type}] ` : '';
    const pri = e.priority === 'high' ? ' !' : '';
    const agent = e.agent ? ` (${e.agent})` : '';
    const when = e.addedAt ? ` ${e.addedAt.slice(0, 10)}` : '';
    return `${tag}${s} .${p} ${e.object}${pri}${agent}${when}`;
  });

  return { content: [{ type: 'text', text: `${entries.length} pending:\n${lines.join('\n')}` }] };
}

function handleKbGitDiffTriples(params: { ref?: string; kb?: string }): object {
  const ref = params.ref ?? 'HEAD~1';

  let changed: { path: string; status: string }[];
  try {
    changed = gitChangedFiles(ref);
  } catch (e) {
    return { content: [{ type: 'text', text: `Git diff failed: ${e instanceof Error ? e.message : String(e)}` }] };
  }

  if (changed.length === 0) {
    return { content: [{ type: 'text', text: `No files changed since ${ref}.` }] };
  }

  kb.reload();
  const triples = kb.allTriples(params.kb);

  // Extract keywords from changed file paths
  const keywords = new Set<string>();
  for (const f of changed) {
    // Get filename without extension, directory names, component names
    const parts = f.path.split('/');
    for (const part of parts) {
      const name = part.replace(/\.[^.]+$/, ''); // strip extension
      if (name.length > 2) {
        keywords.add(name.toLowerCase());
        // Split camelCase/kebab-case into words
        for (const word of name.split(/[-_.]/).filter(w => w.length > 2)) {
          keywords.add(word.toLowerCase());
        }
      }
    }
  }

  // Search KB with extracted keywords
  const query = [...keywords].join(' ');
  const matches = bm25Search(triples, query, 10);

  const sections: string[] = [`${changed.length} files changed since ${ref}:`];
  for (const f of changed) {
    sections.push(`  [${f.status}] ${f.path}`);
  }

  if (matches.length > 0) {
    sections.push(`\n${matches.length} related KB facts:`);
    for (const m of matches) {
      sections.push(`  ${fmtTriple(m.triple)}`);
    }
  } else {
    sections.push('\nNo KB entities matched the changed files.');
  }

  // Find unmatched files (files with no KB coverage)
  const matchedKeywords = new Set<string>();
  for (const m of matches) {
    const slug = m.triple.subject.split('/').pop()?.toLowerCase() ?? '';
    matchedKeywords.add(slug);
    for (const word of slug.split(/[-_]/)) matchedKeywords.add(word);
  }

  const unmatched = changed.filter(f => {
    const name = f.path.split('/').pop()?.replace(/\.[^.]+$/, '')?.toLowerCase() ?? '';
    return !matchedKeywords.has(name) && ![...matchedKeywords].some(k => name.includes(k) || k.includes(name));
  });

  if (unmatched.length > 0) {
    sections.push(`\n${unmatched.length} files with no KB coverage:`);
    for (const f of unmatched) sections.push(`  ${f.path}`);
  }

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

// ── Alignment Score ──────────────────────────────────────────────────────────

type AlignmentVerdict = {
  entity: string;
  status: string;
  verdict: 'aligned' | 'advancing' | 'premature' | 'regressing' | 'unplanned';
  score: number;
  reason: string;
};

/**
 * Score how appropriate it is to be working on a feature given its current status.
 *
 * Status lifecycle: speculative → planned → scaffolded → functional → production
 *
 * Working on "planned" or "scaffolded" is the sweet spot (advancing).
 * Working on "production" means modifying stable code (may be maintenance or regression).
 * Working on "speculative" means jumping ahead of the plan.
 */
function scoreStatusAlignment(status: string, isModifying: boolean): { score: number; verdict: AlignmentVerdict['verdict']; reason: string } {
  const STATUS_ORDER: Record<string, number> = {
    speculative: 0, planned: 1, scaffolded: 2, functional: 3, production: 4,
  };
  const rank = STATUS_ORDER[status];

  if (rank === undefined) {
    // Unknown status — treat neutrally
    return { score: 0.5, verdict: 'aligned', reason: `unknown status "${status}"` };
  }

  if (rank <= 1) {
    // planned or speculative — this is the active frontier, great alignment
    return { score: 1.0, verdict: 'advancing', reason: `${status} → actively advancing` };
  }
  if (rank === 2) {
    // scaffolded — still being built, good
    return { score: 0.9, verdict: 'advancing', reason: `${status} → building on scaffold` };
  }
  if (rank === 3) {
    // functional — polishing, acceptable
    return { score: 0.7, verdict: 'aligned', reason: `${status} → polishing functional code` };
  }
  // production — touching stable code
  if (isModifying) {
    return { score: 0.4, verdict: 'regressing', reason: `${status} → modifying stable production code` };
  }
  return { score: 0.6, verdict: 'aligned', reason: `${status} → minor production touch` };
}

/**
 * Check whether all depends-on targets of an entity are "production" or "functional".
 */
function scoreDependencies(entityIri: string, kbName?: string): { score: number; met: number; total: number; unmet: string[] } {
  const triples = kb.triplesAbout(entityIri, kbName);
  const deps = triples
    .filter(t => t.predicate.endsWith('/depends-on'))
    .map(t => t.object);

  if (deps.length === 0) return { score: 1.0, met: 0, total: 0, unmet: [] };

  const READY = new Set(['production', 'functional']);
  let met = 0;
  const unmet: string[] = [];

  for (const dep of deps) {
    const depTriples = kb.triplesAbout(dep, kbName);
    const statusTriple = depTriples.find(t => t.predicate.endsWith('/has-status'));
    if (statusTriple && READY.has(statusTriple.object)) {
      met++;
    } else {
      unmet.push(dep.split('/').pop() ?? dep);
    }
  }

  return { score: deps.length > 0 ? met / deps.length : 1.0, met, total: deps.length, unmet };
}

/**
 * Extract keywords from file paths for matching against KB entities.
 */
function fileKeywords(paths: string[]): Set<string> {
  const kw = new Set<string>();
  for (const p of paths) {
    for (const part of p.split('/')) {
      const name = part.replace(/\.[^.]+$/, '');
      if (name.length > 2) {
        kw.add(name.toLowerCase());
        for (const word of name.split(/[-_.]/).filter(w => w.length > 2)) {
          kw.add(word.toLowerCase());
        }
      }
    }
  }
  return kw;
}

function handleKbAlignmentScore(params: { ref?: string; work?: string; kb?: string }): object {
  const ref = params.ref ?? 'HEAD~5';

  // 1. Get changed files from git
  let changedFiles: { path: string; status: string }[];
  try {
    changedFiles = gitChangedFiles(ref);
  } catch (e) {
    return { content: [{ type: 'text', text: `Git diff failed: ${e instanceof Error ? e.message : String(e)}` }] };
  }

  if (changedFiles.length === 0) {
    return { content: [{ type: 'text', text: `No files changed since ${ref}. Alignment score: N/A` }] };
  }

  kb.reload();
  const allTriples = kb.allTriples(params.kb);

  // 2. Build search query from file paths + optional work description
  const keywords = fileKeywords(changedFiles.map(f => f.path));
  let query = [...keywords].join(' ');
  if (params.work) query = `${params.work} ${query}`;

  const searchHits = bm25Search(allTriples, query, 15);

  // 3. Deduplicate to unique entities and gather their facts
  const entityMap = new Map<string, { iri: string; triples: ReturnType<typeof kb.triplesAbout> }>();
  for (const hit of searchHits) {
    const iri = hit.triple.subject;
    if (!entityMap.has(iri)) {
      entityMap.set(iri, { iri, triples: kb.triplesAbout(iri, params.kb) });
    }
  }

  // 4. Filter to entities that are features (have has-status)
  const featureEntities: Array<{
    iri: string;
    slug: string;
    status: string;
    featureId: string;
    triples: ReturnType<typeof kb.triplesAbout>;
  }> = [];

  for (const { iri, triples } of entityMap.values()) {
    const statusTriple = triples.find(t => t.predicate.endsWith('/has-status'));
    if (!statusTriple) continue;
    const fidTriple = triples.find(t => t.predicate.endsWith('/feature-id'));
    featureEntities.push({
      iri,
      slug: iri.split('/').pop() ?? iri,
      status: statusTriple.object,
      featureId: fidTriple?.object ?? '',
      triples,
    });
  }

  // ── Dimension 1: Coverage (30%) ──
  // What fraction of changed files can be linked to a KB entity?
  const matchedSlugs = new Set<string>();
  for (const fe of featureEntities) {
    matchedSlugs.add(fe.slug.toLowerCase());
    for (const word of fe.slug.toLowerCase().split(/[-_]/)) {
      if (word.length > 2) matchedSlugs.add(word);
    }
    // Also add words from description/label
    for (const t of fe.triples) {
      if (t.predicate.endsWith('/description') || t.predicate.endsWith('label')) {
        for (const w of t.object.toLowerCase().split(/\s+/).filter(w => w.length > 3)) {
          matchedSlugs.add(w);
        }
      }
    }
  }

  let coveredFiles = 0;
  for (const f of changedFiles) {
    const parts = f.path.toLowerCase().split('/');
    const name = parts[parts.length - 1]?.replace(/\.[^.]+$/, '') ?? '';
    const matched = [...matchedSlugs].some(slug =>
      name.includes(slug) || slug.includes(name) ||
      parts.some(p => p === slug || slug.includes(p))
    );
    if (matched) coveredFiles++;
  }
  const coverageScore = changedFiles.length > 0 ? coveredFiles / changedFiles.length : 0;

  // ── Dimension 2: Status Alignment (30%) ──
  // Are we working on features in an appropriate lifecycle stage?
  const verdicts: AlignmentVerdict[] = [];
  let statusScoreSum = 0;

  if (featureEntities.length === 0) {
    // No feature entities matched → all work is unplanned
    statusScoreSum = 0;
  } else {
    for (const fe of featureEntities) {
      const hasDeletes = changedFiles.some(f => f.status === 'deleted');
      const sa = scoreStatusAlignment(fe.status, hasDeletes);
      verdicts.push({
        entity: fe.slug,
        status: fe.status,
        verdict: sa.verdict,
        score: sa.score,
        reason: `${fe.featureId ? fe.featureId + ' ' : ''}${sa.reason}`,
      });
      statusScoreSum += sa.score;
    }
  }
  const statusScore = featureEntities.length > 0 ? statusScoreSum / featureEntities.length : 0;

  // ── Dimension 3: Dependency Respect (20%) ──
  // Do the features we're touching have their dependencies met?
  let depScoreSum = 0;
  let depCount = 0;
  const unmetDeps: string[] = [];

  for (const fe of featureEntities) {
    const dep = scoreDependencies(fe.iri, params.kb);
    if (dep.total > 0) {
      depScoreSum += dep.score;
      depCount++;
      unmetDeps.push(...dep.unmet);
    }
  }
  const depScore = depCount > 0 ? depScoreSum / depCount : 1.0; // no deps = perfect

  // ── Dimension 4: Scope Discipline (20%) ──
  // Ratio of planned work (matched features) vs unplanned (unmatched files)
  const unmatchedCount = changedFiles.length - coveredFiles;
  // Penalise when a large fraction of changes is unplanned
  const scopeScore = changedFiles.length > 0
    ? Math.max(0, 1 - (unmatchedCount / changedFiles.length) * 0.8)
    : 1.0;

  // ── Composite ──
  const composite = (
    coverageScore * 0.30 +
    statusScore   * 0.30 +
    depScore      * 0.20 +
    scopeScore    * 0.20
  );

  // ── Format output ──
  const grade =
    composite >= 0.85 ? 'EXCELLENT' :
    composite >= 0.70 ? 'GOOD' :
    composite >= 0.50 ? 'FAIR' :
    composite >= 0.30 ? 'POOR' : 'MISALIGNED';

  const lines: string[] = [
    `Alignment Score: ${composite.toFixed(2)} (${grade})`,
    `  ref: ${ref} → ${changedFiles.length} files changed`,
    '',
    `Dimensions:`,
    `  Coverage:    ${(coverageScore * 100).toFixed(0)}%  (${coveredFiles}/${changedFiles.length} files matched KB entities)`,
    `  Status:      ${(statusScore * 100).toFixed(0)}%  (working on features in appropriate lifecycle stage)`,
    `  Deps:        ${(depScore * 100).toFixed(0)}%  (dependency prerequisites met)`,
    `  Scope:       ${(scopeScore * 100).toFixed(0)}%  (planned vs unplanned work ratio)`,
  ];

  if (verdicts.length > 0) {
    lines.push('', 'Per-entity verdicts:');
    for (const v of verdicts) {
      const icon = v.verdict === 'advancing' ? '+' :
                   v.verdict === 'aligned' ? '=' :
                   v.verdict === 'regressing' ? '!' :
                   v.verdict === 'premature' ? '?' : '-';
      lines.push(`  ${icon} ${v.entity} [${v.status}] → ${v.verdict}: ${v.reason}`);
    }
  }

  if (unmetDeps.length > 0) {
    lines.push('', `Unmet dependencies: ${[...new Set(unmetDeps)].join(', ')}`);
  }

  if (featureEntities.length === 0) {
    lines.push('', 'No KB feature entities matched the changed files. Consider using the `work` parameter to describe your intent.');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── Context Compression ──────────────────────────────────────────────────────

/** Rough token estimate (~1.33 tokens per word, matching the benchmark) */
function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.33);
}

/**
 * Compress a subgraph into a token-efficient format for LLM context.
 *
 * Format (entity-grouped, compact):
 *   # EntitySlug
 *     .predicate value
 *     .predicate "literal with spaces"
 *     < OtherEntity .refPredicate
 *
 * This achieves ~60-70% token reduction vs raw Turtle while preserving
 * all semantic content. Entities are ordered by relevance score.
 */
function compressTriples(
  triples: Triple[],
  entityOrder: string[],
  budget: number
): { text: string; stats: { entities: number; facts: number; tokens: number } } {
  // Group triples by subject
  const bySubject = new Map<string, Triple[]>();
  const asObject = new Map<string, Triple[]>();
  for (const t of triples) {
    const list = bySubject.get(t.subject) ?? [];
    list.push(t);
    bySubject.set(t.subject, list);

    // Track inbound references (where this entity appears as object)
    if (!t.objectIsLiteral && t.object.startsWith('urn:')) {
      const refs = asObject.get(t.object) ?? [];
      refs.push(t);
      asObject.set(t.object, refs);
    }
  }

  // Ordered entity list: prioritise by relevance, then by triple count
  const allEntities = new Set<string>(entityOrder);
  for (const iri of bySubject.keys()) allEntities.add(iri);

  const orderedEntities = [...allEntities].filter(iri => bySubject.has(iri) || asObject.has(iri));

  const slug = (iri: string) => localName(iri) || iri;

  // Extract local name from IRI (handles both / and # separators)
  const localName = (iri: string): string => {
    const hash = iri.lastIndexOf('#');
    if (hash >= 0) return iri.slice(hash + 1);
    const slash = iri.lastIndexOf('/');
    if (slash >= 0) return iri.slice(slash + 1);
    return iri;
  };

  // Predicate abbreviations for common namespaces
  const abbreviate = (pred: string): string => {
    const local = localName(pred);
    if (local === 'type' && pred.includes('rdf')) return 'a';
    return local;
  };

  // Format a value: unquoted if numeric or single-word, quoted otherwise
  const fmtValue = (obj: string, isLiteral: boolean): string => {
    if (!isLiteral) return slug(obj);
    if (/^-?[\d.]+$/.test(obj)) return obj;
    if (/^\S+$/.test(obj) && obj.length < 40) return obj;
    return `"${obj}"`;
  };

  const blocks: string[] = [];
  let totalTokens = 0;
  let factCount = 0;
  let entityCount = 0;

  for (const iri of orderedEntities) {
    const outbound = bySubject.get(iri) ?? [];
    const inbound = asObject.get(iri) ?? [];
    if (outbound.length === 0 && inbound.length === 0) continue;

    // Build entity block
    const lines: string[] = [`# ${slug(iri)}`];

    // Deduplicate predicates (same pred+obj)
    const seen = new Set<string>();
    for (const t of outbound) {
      const key = `${t.predicate}\t${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  .${abbreviate(t.predicate)} ${fmtValue(t.object, t.objectIsLiteral)}`);
      factCount++;
    }

    // Inbound references (capped to avoid bloat)
    const inboundCapped = inbound.slice(0, 5);
    for (const t of inboundCapped) {
      const key = `${t.subject}\t${t.predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  < ${slug(t.subject)} .${abbreviate(t.predicate)}`);
      factCount++;
    }
    if (inbound.length > 5) {
      lines.push(`  (+${inbound.length - 5} more refs)`);
    }

    const block = lines.join('\n');
    const blockTokens = estimateTokens(block);

    // Budget check — stop adding entities if we'd exceed
    if (totalTokens + blockTokens > budget && entityCount > 0) break;

    blocks.push(block);
    totalTokens += blockTokens;
    entityCount++;
  }

  return {
    text: blocks.join('\n'),
    stats: { entities: entityCount, facts: factCount, tokens: totalTokens }
  };
}

function handleKbCompress(params: { query: string; budget?: number; hops?: number; kb?: string }): object {
  kb.reload();
  const budget = Math.min(params.budget ?? 2000, 8000);
  const hops = Math.min(params.hops ?? 1, 2);

  const allTriples = kb.allTriples(params.kb);
  if (allTriples.length === 0) {
    return { content: [{ type: 'text', text: 'KB empty — nothing to compress.' }] };
  }

  // 1. BM25 search to find relevant entities
  const searchHits = bm25Search(allTriples, params.query, 20);
  if (searchHits.length === 0) {
    return { content: [{ type: 'text', text: `No relevant facts for "${params.query}".` }] };
  }

  // 2. Collect unique entities in relevance order
  const entityOrder: string[] = [];
  const entitySet = new Set<string>();
  for (const hit of searchHits) {
    if (!entitySet.has(hit.triple.subject)) {
      entitySet.add(hit.triple.subject);
      entityOrder.push(hit.triple.subject);
    }
  }

  // 3. Expand subgraphs for each matched entity
  const expandedTriples: Triple[] = [];
  const seen = new Set<string>();
  for (const iri of entityOrder) {
    const sub = kb.subgraph(iri, hops, params.kb);
    for (const t of sub) {
      const key = `${t.subject}\t${t.predicate}\t${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expandedTriples.push(t);
    }
  }

  // 4. Compress into token-efficient format
  const { text, stats } = compressTriples(expandedTriples, entityOrder, budget);

  // 5. Build header
  const header = `# KB context for: ${params.query}\n# ${stats.entities} entities, ${stats.facts} facts, ~${stats.tokens} tokens\n`;

  return {
    content: [{
      type: 'text',
      text: header + text
    }]
  };
}

// ── Local LLM offload (Ollama) ──────────────────────────────────────────────

async function handleKbLocalExtract(params: { text: string; source?: string; kb?: string }): Promise<object> {
  if (!ollamaEnabled()) {
    return { content: [{ type: 'text', text: OLLAMA_DISABLED_MESSAGE }] };
  }
  if (!params.text || !params.text.trim()) {
    return { content: [{ type: 'text', text: 'text is required and must be non-empty.' }] };
  }

  try {
    const { triples, turtle } = await extractTriplesLocally(params.text, params.source);
    if (triples.length === 0) {
      return { content: [{ type: 'text', text: `No triples extracted by local model (${OLLAMA_MODEL}) — the source text may be too short or off-topic.` }] };
    }
    const json = JSON.stringify(triples, null, 2);
    return {
      content: [{
        type: 'text',
        text: `${triples.length} proposed triples from local model "${OLLAMA_MODEL}" — NOT written to any KB, review before adding:\n\nJSON:\n${json}\n\nTurtle:\n${turtle}`
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: `Local extraction failed: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

async function handleKbLocalSummarize(params: { entity?: string; text?: string; kb?: string; budget?: number }): Promise<object> {
  if (!ollamaEnabled()) {
    return { content: [{ type: 'text', text: OLLAMA_DISABLED_MESSAGE }] };
  }

  kb.reload();

  try {
    const { label, summary } = await summarizeLocally(params, kb);
    return {
      content: [{
        type: 'text',
        text: `Summary of ${label} (local model: ${OLLAMA_MODEL}):\n\n${summary}`
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: `Local summarization failed: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

// ── Page generation (Ollama, grounded) + deterministic entity rendering ───────

type GeneratePageToolParams = {
  prompt: string; kb?: string; section?: string; slug?: string; title?: string;
  template?: string; budget?: number;
};

async function handleKbGeneratePage(params: GeneratePageToolParams): Promise<object> {
  if (!ollamaEnabled()) {
    return { content: [{ type: 'text', text: OLLAMA_DISABLED_MESSAGE }] };
  }
  if (!params.prompt || !params.prompt.trim()) {
    return { content: [{ type: 'text', text: 'prompt is required and must be non-empty.' }] };
  }

  kb.reload();
  const budget = Math.min(params.budget ?? 2000, 8000);
  const allTriples = kb.allTriples(params.kb);

  // Grounding: same search → subgraph → compress pipeline as kb_compress.
  let graphContext = '';
  if (allTriples.length > 0) {
    const searchHits = bm25Search(allTriples, params.prompt, 20);
    const entityOrder: string[] = [];
    const entitySet = new Set<string>();
    for (const hit of searchHits) {
      if (!entitySet.has(hit.triple.subject)) {
        entitySet.add(hit.triple.subject);
        entityOrder.push(hit.triple.subject);
      }
    }
    const expandedTriples: Triple[] = [];
    const seen = new Set<string>();
    for (const iriStr of entityOrder) {
      for (const t of kb.subgraph(iriStr, 1, params.kb)) {
        const key = `${t.subject}\t${t.predicate}\t${t.object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        expandedTriples.push(t);
      }
    }
    graphContext = compressTriples(expandedTriples, entityOrder, budget).text;
  }

  try {
    const generateParams: GeneratePageParams = {
      prompt: params.prompt,
      section: params.section,
      slug: params.slug,
      title: params.title,
      template: params.template as PageTemplate | undefined,
    };
    const result = await generatePageMarkdown(generateParams, graphContext);
    return {
      content: [{
        type: 'text',
        text: `PROPOSAL ONLY — not written to any KB or file. Generated with local model "${OLLAMA_MODEL}".\n\n--- MARKDOWN ---\n${result.markdown}\n\n--- JSON ---\n${JSON.stringify({ frontmatter: result.frontmatter, body: result.body }, null, 2)}`
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: `Page generation failed: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

function handleKbEntityMarkdown(params: { entity: string; kb?: string }): object {
  kb.reload();
  let iriStr = params.entity;

  if (!iriStr.startsWith('urn:') && !iriStr.startsWith('http')) {
    const resolved = kb.resolveLabel(iriStr, params.kb);
    if (!resolved) {
      return { content: [{ type: 'text', text: `Not found: "${iriStr}". Use kb_search or kb_list_entities.` }] };
    }
    iriStr = resolved;
  }

  const triples = kb.triplesAbout(iriStr, params.kb);
  if (triples.length === 0) {
    return { content: [{ type: 'text', text: `No facts for: ${iriStr}` }] };
  }

  const result = entityToMarkdown(iriStr, kb, params.kb);
  return {
    content: [{
      type: 'text',
      text: `--- MARKDOWN ---\n${result.markdown}\n\n--- JSON ---\n${JSON.stringify(result.frontmatter, null, 2)}`
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
          serverInfo: { name: 'reckons-ai-mcp', version: '0.2.0' }
        });
        break;

      case 'tools/list':
        respond(id ?? null, { tools: TOOLS });
        break;

      case 'tools/call': {
        const toolName = (params as { name?: string; arguments?: Record<string, unknown> }).name;
        const toolArgs = (params as { name?: string; arguments?: Record<string, unknown> }).arguments ?? {};

        switch (toolName) {
          case 'kb_list_kbs':    respond(id ?? null, handleKbListKbs()); break;
          case 'kb_search':      respond(id ?? null, handleKbSearch(toolArgs as { query: string; limit?: number; kb?: string })); break;
          case 'kb_get_entity':  respond(id ?? null, handleKbGetEntity(toolArgs as { entity: string; kb?: string })); break;
          case 'kb_stats':       respond(id ?? null, handleKbStats(toolArgs as { kb?: string })); break;
          case 'kb_list_entities': respond(id ?? null, handleKbListEntities(toolArgs as { limit?: number; kb?: string })); break;
          case 'kb_add_note':    respond(id ?? null, handleKbAddNote(toolArgs as AddNoteParams)); break;
          case 'kb_subgraph':    respond(id ?? null, handleKbSubgraph(toolArgs as { entity: string; hops?: number; limit?: number; kb?: string })); break;
          case 'kb_reckoning':   respond(id ?? null, handleKbReckoning(toolArgs as { situation: string; target: string; kb?: string })); break;
          case 'kb_list_sources': respond(id ?? null, handleKbListSources(toolArgs as { kb?: string })); break;
          case 'kb_request_refresh': respond(id ?? null, handleKbRequestRefresh(toolArgs as { source_id?: string; kb?: string })); break;
          case 'kb_git_status':  respond(id ?? null, handleKbGitStatus(toolArgs as { commits?: number; diff?: boolean })); break;
          case 'kb_check_plan':  respond(id ?? null, handleKbCheckPlan(toolArgs as { work: string; commits?: number; kb?: string })); break;
          case 'kb_pending':     respond(id ?? null, handleKbPending(toolArgs as { kb?: string })); break;
          case 'kb_git_diff_triples': respond(id ?? null, handleKbGitDiffTriples(toolArgs as { ref?: string; kb?: string })); break;
          case 'kb_alignment_score': respond(id ?? null, handleKbAlignmentScore(toolArgs as { ref?: string; work?: string; kb?: string })); break;
          case 'kb_compress': respond(id ?? null, handleKbCompress(toolArgs as { query: string; budget?: number; hops?: number; kb?: string })); break;
          // Async tools (call out to a local Ollama instance) — resolve then respond.
          case 'kb_local_extract':
            handleKbLocalExtract(toolArgs as { text: string; source?: string; kb?: string })
              .then(result => respond(id ?? null, result))
              .catch(e => respondError(id ?? null, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`));
            break;
          case 'kb_local_summarize':
            handleKbLocalSummarize(toolArgs as { entity?: string; text?: string; kb?: string; budget?: number })
              .then(result => respond(id ?? null, result))
              .catch(e => respondError(id ?? null, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`));
            break;
          case 'kb_generate_page':
            handleKbGeneratePage(toolArgs as GeneratePageToolParams)
              .then(result => respond(id ?? null, result))
              .catch(e => respondError(id ?? null, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`));
            break;
          case 'kb_entity_markdown': respond(id ?? null, handleKbEntityMarkdown(toolArgs as { entity: string; kb?: string })); break;
          default:
            respondError(id ?? null, -32601, `Unknown tool: ${toolName}`);
            return;
        }
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
