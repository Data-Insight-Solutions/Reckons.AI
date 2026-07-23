import { describe, it, expect } from 'vitest';
import { validateToolArgs, type ToolSchema } from '../validate-args.js';

const tools: ToolSchema[] = [
  {
    name: 'kb_search',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' }, kb: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'kb_git_status',
    inputSchema: {
      properties: { commits: { type: 'number' }, diff: { type: 'boolean' } },
    },
  },
];

describe('validateToolArgs (F107.1)', () => {
  it('accepts conforming arguments', () => {
    expect(validateToolArgs(tools, 'kb_search', { query: 'coffee', limit: 5 })).toBeNull();
    expect(validateToolArgs(tools, 'kb_git_status', { commits: 3, diff: true })).toBeNull();
    expect(validateToolArgs(tools, 'kb_git_status', {})).toBeNull(); // no required fields
  });

  it('rejects a missing required argument', () => {
    expect(validateToolArgs(tools, 'kb_search', {})).toMatch(/Missing required argument "query"/);
    expect(validateToolArgs(tools, 'kb_search', { limit: 5 })).toMatch(/query/);
  });

  it('rejects a blank required string', () => {
    expect(validateToolArgs(tools, 'kb_search', { query: '   ' })).toMatch(/must not be empty/);
  });

  it('rejects wrong-typed arguments', () => {
    expect(validateToolArgs(tools, 'kb_search', { query: 42 })).toMatch(/must be a string/);
    expect(validateToolArgs(tools, 'kb_search', { query: 'x', limit: 'ten' })).toMatch(/must be a number/);
    expect(validateToolArgs(tools, 'kb_git_status', { diff: 'yes' })).toMatch(/must be a boolean/);
    expect(validateToolArgs(tools, 'kb_git_status', { commits: Number.NaN })).toMatch(/must be a number/);
  });

  it('passes through unknown tools (handled elsewhere as -32601)', () => {
    expect(validateToolArgs(tools, 'kb_unknown', { anything: true })).toBeNull();
  });
});
