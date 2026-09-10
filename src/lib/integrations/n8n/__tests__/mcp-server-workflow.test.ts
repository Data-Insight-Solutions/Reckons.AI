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
  it('names its parameter `input`, because that is what n8n ADVERTISES over MCP', () => {
    // n8n publishes a different schema than it enforces. tools/list advertises exactly one
    // property — `input` — regardless of what the tool node declares, but execution validates
    // against the DECLARED parameter names. A tool declaring `text` therefore advertised
    // `input` and then rejected every call with "Received tool input did not match expected
    // schema ✖ Required → at text". That is not theory: it is n8n execution 2784, a real
    // Pebble call that failed. Naming the parameter `input` makes the two agree, verified by
    // a live tools/call against a throwaway workflow.
    const values = node('capture_note').parameters.parametersBody.values;
    expect(values).toHaveLength(1);
    expect(values[0].name).toBe('input');
    expect(values[0].valueProvider).toBe('modelRequired');
  });

  it('sends a body the capture webhook can read', () => {
    // The webhook's noteText() accepts text | input | JSON-in-input, so `input` lands.
    const names = node('capture_note').parameters.parametersBody.values.map((v: any) => v.name);
    expect(names.some((n: string) => ['text', 'input'].includes(n))).toBe(true);
  });

  it('POSTs, because the capture webhook only accepts POST', () => {
    expect(node('capture_note').parameters.method).toBe('POST');
  });
});

describe('MCP server workflow — client tool-name namespacing', () => {
  it('keeps the PLAIN tool name, because the client adds its own prefix', () => {
    // Renaming this node to match what the client displays is the obvious fix and it is wrong.
    // Pebble applies <server_nickname>__ to whatever the server ADVERTISES, so renaming the
    // node to `Reckons_AI__capture_note` produced `Reckons_AI__Reckons_AI__capture_note` on the
    // next call. Measured on the live instance, not reasoned about. The plain name is correct.
    const values = (wf.nodes as Node[]).filter((n) => n.type.endsWith('toolHttpRequest'));
    expect(values.map((n) => n.name)).toEqual(['capture_note']);
  });

  it('tells the reader NOT to rename it, and why', () => {
    const sticky = (wf.nodes as Node[]).find((n) => n.name === 'Read me first');
    const content = String(sticky?.parameters.content ?? '');
    expect(content).toMatch(/do not rename this node/i);
    expect(content).toMatch(/no execution/i);
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
