#!/usr/bin/env npx tsx
/**
 * Fetch a compact, provenance-labelled knowledge-graph slice through the project's OWN MCP
 * server. Local agents receive this file as context; they do not need shell or MCP credentials
 * of their own, and the runner retains exactly what grounding was available for a proposal.
 *
 * This deliberately calls `kb_compress` over MCP instead of importing the graph reader. The
 * server is the public harness contract: using it here exercises the same boundary that Codex,
 * Claude, and any other MCP client uses.
 *
 * Usage:
 *   npx tsx scripts/agent/mcp-context.ts --query="local code review" --out=run.json [--budget=1400]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface McpContext {
  schema: 'reckons.mcp-context/v1';
  tool: 'kb_compress';
  query: string;
  budget: number;
  fetchedAt: string;
  content: string;
  contentSha256: string;
  provenance: {
    transport: 'stdio-json-rpc';
    command: 'bash scripts/mcp-server.sh';
    workspace: 'mcp-workspace';
  };
}

export interface ConsumedMcpContext {
  schema: 'reckons.mcp-context/v1';
  tool: 'kb_compress';
  query: string;
  content: string;
  sourceContentSha256: string;
  consumedContentSha256: string;
  sourceChars: number;
  consumedChars: number;
  truncated: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Validate a stored context before it reaches a model and bind the exact consumed slice.
 * A declared hash is not evidence until it is recomputed. If a downstream prompt caps the
 * context, its report must hash the bytes actually shown rather than the larger source file. */
export function consumeStoredMcpContext(value: unknown, maxChars = 9_000): ConsumedMcpContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('context must be a JSON object');
  const parsed = value as Partial<McpContext>;
  if (parsed.schema !== 'reckons.mcp-context/v1' || parsed.tool !== 'kb_compress' ||
      typeof parsed.query !== 'string' || typeof parsed.content !== 'string' ||
      typeof parsed.contentSha256 !== 'string') {
    throw new Error('context has an invalid schema');
  }
  const actual = sha256(parsed.content);
  if (actual !== parsed.contentSha256) throw new Error('context content hash does not match its bytes');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer');
  const content = parsed.content.slice(0, maxChars);
  return {
    schema: parsed.schema,
    tool: parsed.tool,
    query: parsed.query,
    content,
    sourceContentSha256: actual,
    consumedContentSha256: sha256(content),
    sourceChars: parsed.content.length,
    consumedChars: content.length,
    truncated: content.length < parsed.content.length,
  };
}

/** Parse the one response to an MCP `tools/call` request. Exported so malformed transport never
 * becomes a silent "empty context" regression. */
export function parseCompressedContext(stdout: string): string {
  const response = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as { result?: { content?: { type?: string; text?: string }[] }; error?: { message?: string } }; }
      catch { return null; }
    })
    .find((message) => message?.result || message?.error);
  if (!response) throw new Error('MCP returned no JSON-RPC response');
  if (response.error) throw new Error(`MCP error: ${response.error.message ?? 'unknown error'}`);
  const text = response.result?.content?.find((part) => part.type === 'text')?.text?.trim();
  if (!text) throw new Error('MCP kb_compress returned no text context');
  return text;
}

export function collectMcpContext(query: string, budget = 1400): McpContext {
  if (!query.trim()) throw new Error('MCP context query must not be blank');
  if (!Number.isInteger(budget) || budget < 200 || budget > 8000) {
    throw new Error('MCP context budget must be an integer from 200 to 8000');
  }
  const request = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'kb_compress', arguments: { query, budget, hops: 1 } },
  }) + '\n';
  const result = spawnSync('bash', ['scripts/mcp-server.sh'], {
    input: request,
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not start Reckons MCP: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Reckons MCP exited ${result.status ?? 'by signal'}: ${(result.stderr ?? '').trim().slice(-400)}`);
  }
  const content = parseCompressedContext(result.stdout ?? '');
  return {
    schema: 'reckons.mcp-context/v1',
    tool: 'kb_compress',
    query,
    budget,
    fetchedAt: new Date().toISOString(),
    content,
    contentSha256: sha256(content),
    provenance: {
      transport: 'stdio-json-rpc',
      command: 'bash scripts/mcp-server.sh',
      workspace: 'mcp-workspace',
    },
  };
}

export function writeMcpContext(output: string, query: string, budget?: number): McpContext {
  const context = collectMcpContext(query, budget);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(context, null, 2) + '\n');
  return context;
}

const raw = process.argv.slice(2);
const flag = (name: string) => raw.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (import.meta.url === `file://${process.argv[1]}`) {
  const query = flag('query');
  const out = flag('out');
  const budget = Number(flag('budget') ?? 1400);
  if (!query || !out) {
    console.error('Usage: mcp-context.ts --query=<text> --out=<path> [--budget=1400]');
    process.exit(2);
  }
  try {
    const context = writeMcpContext(out, query, budget);
    console.log(`MCP context: ${context.content.length} chars, sha256 ${context.contentSha256.slice(0, 12)} → ${out}`);
  } catch (error) {
    console.error(`MCP context failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
