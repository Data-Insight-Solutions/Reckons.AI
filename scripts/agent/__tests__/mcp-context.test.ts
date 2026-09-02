import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { consumeStoredMcpContext, parseCompressedContext } from '../mcp-context';

describe('parseCompressedContext', () => {
  it('extracts text from a kb_compress JSON-RPC response', () => {
    const stdout = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: '# KB context\n  .label "Orchestration"' }] },
    });
    expect(parseCompressedContext(stdout)).toContain('Orchestration');
  });

  it('refuses an empty or malformed MCP response', () => {
    expect(() => parseCompressedContext('not json')).toThrow(/no JSON-RPC/i);
    expect(() => parseCompressedContext(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }))).toThrow(/no text/i);
  });

  it('surfaces an MCP tool error instead of treating it as empty grounding', () => {
    expect(() => parseCompressedContext(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'bad query' } }))).toThrow(/bad query/);
  });
});

describe('consumeStoredMcpContext', () => {
  const stored = (content: string, contentSha256 = createHash('sha256').update(content).digest('hex')) => ({
    schema: 'reckons.mcp-context/v1',
    tool: 'kb_compress',
    query: 'local orchestration F81',
    budget: 1400,
    fetchedAt: new Date(0).toISOString(),
    content,
    contentSha256,
    provenance: { transport: 'stdio-json-rpc', command: 'bash scripts/mcp-server.sh', workspace: 'mcp-workspace' },
  });

  it('recomputes the source hash and records the exact slice a model consumes', () => {
    const consumed = consumeStoredMcpContext(stored('F81 local orchestration context'), 8);
    expect(consumed.content).toBe('F81 loca');
    expect(consumed.truncated).toBe(true);
    expect(consumed.sourceChars).toBe('F81 local orchestration context'.length);
    expect(consumed.consumedChars).toBe(8);
    expect(consumed.sourceContentSha256).toBe(stored('F81 local orchestration context').contentSha256);
    expect(consumed.consumedContentSha256).toBe(createHash('sha256').update('F81 loca').digest('hex'));
  });

  it('refuses declared provenance whose bytes no longer match', () => {
    expect(() => consumeStoredMcpContext(stored('F81', '0'.repeat(64)))).toThrow(/hash does not match/i);
  });
});
