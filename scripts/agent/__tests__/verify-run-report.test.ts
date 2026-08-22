import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY = path.join(REPO, 'scripts/agent/verify-run-report.ts');
const TSX = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
const dirs: string[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-run-report-'));
  dirs.push(dir);
  const content = 'F81 local orchestration context';
  const consumed = content.slice(0, 12);
  const context = path.join(dir, 'context.json');
  const report = path.join(dir, 'report.json');
  writeFileSync(context, JSON.stringify({
    schema: 'reckons.mcp-context/v1',
    tool: 'kb_compress',
    query: 'F81 local orchestration',
    budget: 1400,
    fetchedAt: new Date(0).toISOString(),
    content,
    contentSha256: sha256(content),
    provenance: {
      transport: 'stdio-json-rpc',
      command: 'bash scripts/mcp-server.sh',
      workspace: 'mcp-workspace',
    },
  }));
  const value = {
    schema: 'reckons.local-code-review/v1',
    files: ['scripts/agent/runner.ts'],
    discovered: 1,
    selected: 1,
    omitted: 0,
    discoverySha256: 'c'.repeat(64),
    reviewed: 1,
    truncatedFiles: [],
    failed: 0,
    finishedAt: new Date().toISOString(),
    mcpContext: {
      query: 'F81 local orchestration',
      sourceContentSha256: sha256(content),
      consumedContentSha256: sha256(consumed),
      sourceChars: content.length,
      consumedChars: consumed.length,
      truncated: true,
    },
  };
  writeFileSync(report, JSON.stringify(value));
  return { context, report, value };
}

function verify(context: string, report: string) {
  return spawnSync(process.execPath, [
    TSX,
    VERIFY,
    '--kind=local-code-review',
    `--file=${report}`,
    '--require-mcp',
  ], {
    cwd: REPO,
    env: { ...process.env, TASK_MCP_CONTEXT: context },
    encoding: 'utf8',
  });
}

describe('verify-run-report MCP binding', () => {
  it('binds a report to the exact runner context slice', () => {
    const { context, report } = fixture();
    const result = verify(context, report);
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a valid-looking consumed hash that does not match the runner context', () => {
    const { context, report, value } = fixture();
    value.mcpContext.consumedContentSha256 = 'a'.repeat(64);
    writeFileSync(report, JSON.stringify(value));
    const result = verify(context, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/consumed hash does not match/i);
  });
});
