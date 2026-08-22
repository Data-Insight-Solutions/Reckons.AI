#!/usr/bin/env npx tsx
import { readFileSync, statSync } from 'node:fs';
import { validateRunReport, type RunReportKind } from './run-contract.js';
import { consumeStoredMcpContext } from './mcp-context.js';

const raw = process.argv.slice(2);
const flag = (name: string) => raw.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const kind = flag('kind') as RunReportKind | undefined;
const file = flag('file');
const requireMcp = raw.includes('--require-mcp');
const since = Number(flag('since') ?? process.env.TASK_RUN_EPOCH ?? 0);

if (!kind || !['local-code-review', 'button-crawl', 'visual-diff'].includes(kind) || !file) {
  console.error('Usage: verify-run-report.ts --kind=<local-code-review|button-crawl|visual-diff> --file=<json> [--require-mcp] [--since=<epoch-seconds>]');
  process.exit(2);
}

try {
  const stat = statSync(file);
  if (since > 0 && stat.mtimeMs < since * 1000) {
    throw new Error(`report predates this task run: ${file}`);
  }
  const report = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (since > 0 && report && typeof report === 'object' && !Array.isArray(report)) {
    const finishedAt = (report as Record<string, unknown>).finishedAt;
    if (typeof finishedAt !== 'string' || Date.parse(finishedAt) < since * 1000) {
      throw new Error(`report content predates this task run: ${file}`);
    }
  }
  const errors = validateRunReport(kind, report, { requireMcp });
  if (errors.length) throw new Error(errors.join('; '));
  if (requireMcp) {
    const contextFile = process.env.TASK_MCP_CONTEXT;
    if (!contextFile) throw new Error('TASK_MCP_CONTEXT is required to verify MCP consumption');
    const reportObject = report as Record<string, unknown>;
    const mcp = reportObject.mcpContext as Record<string, unknown>;
    const consumedChars = mcp.consumedChars;
    if (!Number.isInteger(consumedChars) || Number(consumedChars) < 1) {
      throw new Error('report has no positive MCP consumed character count');
    }
    const source = JSON.parse(readFileSync(contextFile, 'utf8')) as unknown;
    // Recompute the source hash and the exact prefix the consumer says it used. Valid-looking
    // 64-hex strings in a report are not evidence unless they bind back to the runner's file.
    const consumed = consumeStoredMcpContext(source, Number(consumedChars));
    if (mcp.query !== consumed.query) throw new Error('report MCP query does not match runner context');
    if (mcp.sourceContentSha256 !== consumed.sourceContentSha256) {
      throw new Error('report MCP source hash does not match runner context');
    }
    if (mcp.consumedContentSha256 !== consumed.consumedContentSha256) {
      throw new Error('report MCP consumed hash does not match the declared source slice');
    }
    if (mcp.sourceChars !== consumed.sourceChars || mcp.consumedChars !== consumed.consumedChars) {
      throw new Error('report MCP character counts do not match runner context');
    }
    if (mcp.truncated !== consumed.truncated) {
      throw new Error('report MCP truncation flag does not match runner context');
    }
  }
  console.log(`valid ${kind} report: ${file}`);
} catch (error) {
  console.error(`invalid ${kind} report: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
