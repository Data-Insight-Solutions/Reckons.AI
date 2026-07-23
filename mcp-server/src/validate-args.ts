/**
 * Runtime validation of MCP tool arguments against a tool's declared inputSchema (F107.1).
 *
 * MCP arguments arrive from an LLM and were otherwise cast with `as` and trusted, so a missing,
 * blank, or wrong-typed field reached a handler as an opaque crash (-32603) instead of a clear
 * "invalid params" (-32602). This is schema-driven, so it never drifts from the advertised
 * contract. It lives in its own module (no server bootstrap on import) so it is unit-testable.
 */

// `inputSchema` is left as `unknown` so the declared TOOLS array — whose literal type is very
// specific — is assignable without a cast; it is narrowed structurally below.
export type ToolSchema = { name: string; inputSchema?: unknown };

type SchemaShape = { properties?: Record<string, { type?: string } | undefined>; required?: string[] };

/** Returns an error message (for JSON-RPC -32602) or null when the args conform. */
export function validateToolArgs(
  tools: readonly ToolSchema[],
  toolName: string,
  args: Record<string, unknown>
): string | null {
  const tool = tools.find(t => t.name === toolName);
  if (!tool) return null; // unknown tool → handled as -32601 downstream
  const schema = (tool.inputSchema ?? {}) as SchemaShape;
  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const field of required) {
    const v = args[field];
    if (v === undefined || v === null) return `Missing required argument "${field}" for ${toolName}`;
    if (props[field]?.type === 'string' && typeof v === 'string' && v.trim() === '') {
      return `Argument "${field}" for ${toolName} must not be empty`;
    }
  }
  for (const [field, value] of Object.entries(args)) {
    const type = props[field]?.type;
    if (!type || value === undefined || value === null) continue;
    if (type === 'string' && typeof value !== 'string') return `Argument "${field}" must be a string`;
    if ((type === 'number' || type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))) {
      return `Argument "${field}" must be a number`;
    }
    if (type === 'boolean' && typeof value !== 'boolean') return `Argument "${field}" must be a boolean`;
  }
  return null;
}
