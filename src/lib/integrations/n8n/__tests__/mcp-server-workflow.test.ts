/**
 * The MCP server workflow is a contract with two parties that never see each other: an MCP
 * client (a phone app, a ring's companion app) on one side, and the capture webhook on the
 * other. Nothing at runtime checks that the tool the client calls matches the payload the
 * webhook expects — a rename on either side yields a tool that reports success while the note
 * goes nowhere, which is the failure mode this whole capture chain is most prone to.
 *
 * Node identifiers and versions are pinned against @n8n/n8n-nodes-langchain 2.36.4, read out of
 * the published package rather than guessed, because a wrong type string produces a workflow
 * that imports as a broken node and fails at activation with no useful message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const wf = JSON.parse(
  readFileSync(path.join(process.cwd(), 'static/n8n/reckons-mcp-server.workflow.json'), 'utf8'),
);
type Node = { name: string; type: string; typeVersion: number; parameters: Record<string, any> };
const node = (name: string): Node => {
  const f = (wf.nodes as Node[]).find((n) => n.name === name);
  if (!f) throw new Error(`no node "${name}"`);
  return f;
};

describe('MCP server workflow — node identity', () => {
  it('pins a typeVersion the OLDEST supported n8n can actually run', () => {
    // Not the newest available, deliberately. mcpTrigger 2.1 exists in langchain 2.36.x but
    // NOT in 2.23.0, which ships with n8n 2.23.x — and the public API stores whatever JSON you
    // send without validating node versions, so a too-new version deploys "successfully" and
    // then fails at activation on the instance. Shipping 2 works on both.
    const t = node('MCP Server Trigger');
    expect(t.type).toBe('@n8n/n8n-nodes-langchain.mcpTrigger');
    expect(t.typeVersion).toBe(2);
  });

  it('uses the real HTTP tool type and a supported version', () => {
    const t = node('capture_note');
    expect(t.type).toBe('@n8n/n8n-nodes-langchain.toolHttpRequest');
    expect([1, 1.1]).toContain(t.typeVersion);
  });

  it('attaches the tool over ai_tool, the only connection the trigger accepts', () => {
    expect(wf.connections.capture_note.ai_tool[0][0]).toMatchObject({
      node: 'MCP Server Trigger',
      type: 'ai_tool',
    });
  });
});

describe('MCP server workflow — the contract with the capture webhook', () => {
  it('sends the field name the capture workflow reads', () => {
    // ios-note-capture's row builder reads body.text. Anything else and the note is dropped as
    // empty while the MCP client is told it succeeded.
    const names = node('capture_note').parameters.parametersBody.values.map((v: any) => v.name);
    expect(names).toContain('text');
  });

  it('requires the model to supply the note, and only optionally the timestamp', () => {
    const values = node('capture_note').parameters.parametersBody.values;
    const byName = Object.fromEntries(values.map((v: any) => [v.name, v.valueProvider]));
    expect(byName.text).toBe('modelRequired');
    // Optional on purpose: the capture workflow falls back to server time, and a model
    // inventing a timestamp is worse than not sending one.
    expect(byName.capturedAt).toBe('modelOptional');
  });

  it('POSTs, because the capture webhook only accepts POST', () => {
    expect(node('capture_note').parameters.method).toBe('POST');
  });
});

describe('MCP server workflow — safety', () => {
  it('requires bearer auth on a public write endpoint', () => {
    // The tool WRITES into a personal knowledge graph. Unauthenticated is not an option.
    expect(node('MCP Server Trigger').parameters.authentication).toBe('bearerAuth');
  });

  it('carries an auth header to the capture webhook as well', () => {
    const headers = node('capture_note').parameters.parametersHeaders.values;
    expect(headers.some((h: any) => h.name === 'Authorization')).toBe(true);
  });

  it('ships both secrets unset so a half-configured deploy is caught', () => {
    const json = JSON.stringify(wf);
    expect(json).toContain('PUT-YOUR-CAPTURE-WEBHOOK-URL-HERE');
    expect(json).toContain('PUT-YOUR-CAPTURE-WEBHOOK-TOKEN-HERE');
  });

  it('tells the model NOT to rewrite what the user said', () => {
    // The single most important line in the tool description. A model that "helpfully" tidies a
    // transcript destroys the only thing capture is for — and does it invisibly.
    const d = node('capture_note').parameters.toolDescription as string;
    expect(d).toMatch(/verbatim|EXACTLY/i);
    expect(d).toMatch(/do not summarise|do not summarize/i);
  });
});
