import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type RunReportKind = 'local-code-review' | 'button-crawl' | 'visual-diff';

export interface GitStateFingerprint {
  available: true;
  head: string;
  dirty: boolean;
  statusSha256: string;
  trackedDiffSha256: string;
  untrackedFilesSha256: string;
  worktreeStateSha256: string;
}

export interface UnavailableGitStateFingerprint {
  available: false;
  error: string;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** A task succeeds only when BOTH execution and its independent acceptance check succeed.
 * Exit 0 from the command is not proof of completion, but a non-zero execution must not be
 * laundered into success by a verifier that only notices a fresh artifact. Exit 42 is handled by
 * the runner before this function because it means WAITING, not success or failure. */
export function runSucceeded(commandExit: number, verificationExit: number): boolean {
  return commandExit === 0 && verificationExit === 0;
}

export interface PriorReviewBatch {
  discoverySha256?: unknown;
  files?: unknown;
  omitted?: unknown;
}

export interface ReviewBatch {
  files: string[];
  discoverySha256: string;
  /** Index in the deterministic discovered-file order. Zero means the first batch. */
  start: number;
}

/** Select a bounded review batch without repeatedly starving everything after the first cap.
 *
 * The prior run report is already the standing job's receipt, so it is the only state consulted:
 * no second cursor file can drift from the evidence. Rotation is accepted only when the complete
 * ordered path set hashes identically and the prior report says it was capped. Any scope change,
 * malformed report, explicit complete run, or missing prior file safely resets to batch zero.
 *
 * This is scheduling only, not aggregate evidence. Each capped report remains incomplete and must
 * fail verification; rotating the next batch cannot turn several partial reviews into one claimed
 * complete review.
 */
export function selectReviewBatch(
  discoveredFiles: string[],
  maxFiles: number,
  previous?: PriorReviewBatch,
): ReviewBatch {
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer');
  const discoverySha256 = sha256(discoveredFiles.join('\0'));
  let start = 0;

  if (
    previous?.discoverySha256 === discoverySha256 &&
    typeof previous.omitted === 'number' && previous.omitted > 0 &&
    Array.isArray(previous.files) && previous.files.every((file) => typeof file === 'string') &&
    previous.files.length > 0
  ) {
    const last = previous.files[previous.files.length - 1] as string;
    const lastIndex = discoveredFiles.indexOf(last);
    if (lastIndex >= 0 && lastIndex + 1 < discoveredFiles.length) start = lastIndex + 1;
  }

  return {
    files: discoveredFiles.slice(start, start + maxFiles),
    discoverySha256,
    start,
  };
}

/** Hash git state without pulling a potentially huge binary diff into Node's default exec buffer.
 *
 * `git diff HEAD` binds both staged and unstaged tracked content. Porcelain status preserves the
 * distinction between index/worktree states. Untracked paths and bytes are hashed separately,
 * because `git diff` deliberately omits them. Every large stream is piped into sha256sum inside
 * the child; Node receives only a 64-character digest. */
export function captureGitState(cwd = process.cwd()): GitStateFingerprint | UnavailableGitStateFingerprint {
  const digest = (pipelineInput: string): string => {
    const out = execSync(`set -o pipefail\n${pipelineInput} | sha256sum`, {
      cwd,
      encoding: 'utf8',
      shell: '/bin/bash',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    }).trim();
    const value = out.split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`invalid sha256sum output: ${out.slice(0, 100)}`);
    return value;
  };

  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    const statusSha256 = sha256(status);
    const trackedDiffSha256 = digest('git diff --no-ext-diff --binary HEAD');
    const untrackedFilesSha256 = digest(
      `git ls-files --others --exclude-standard -z | sort -z | ` +
      `while IFS= read -r -d '' file; do ` +
      `printf '%s\\0' "$file"; sha256sum -- "$file" | cut -d ' ' -f1; ` +
      `done`,
    );
    return {
      available: true,
      head,
      dirty: status.length > 0,
      statusSha256,
      trackedDiffSha256,
      untrackedFilesSha256,
      worktreeStateSha256: sha256(
        `${head}\0${statusSha256}\0${trackedDiffSha256}\0${untrackedFilesSha256}`,
      ),
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
const finiteCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const validTime = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
const validSha256 = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Pure, deterministic validation for the three task-specific reports used as runner evidence. */
export function validateRunReport(
  kind: RunReportKind,
  value: unknown,
  options: { requireMcp?: boolean } = {},
): string[] {
  const report = object(value);
  if (!report) return ['report must be a JSON object'];
  const errors: string[] = [];

  if (kind === 'local-code-review') {
    if (report.schema !== 'reckons.local-code-review/v1') errors.push('unexpected code-review schema');
    if (!validTime(report.finishedAt)) errors.push('missing or invalid finishedAt');
    const files = strings(report.files);
    const discovered = finiteCount(report.discovered);
    const selected = finiteCount(report.selected);
    const omitted = finiteCount(report.omitted);
    const reviewed = finiteCount(report.reviewed);
    const failed = finiteCount(report.failed);
    const truncatedFiles = strings(report.truncatedFiles);
    if (!files) errors.push('files must be an array of paths');
    if (discovered === null) errors.push('discovered must be a non-negative integer');
    if (selected === null) errors.push('selected must be a non-negative integer');
    if (omitted === null) errors.push('omitted must be a non-negative integer');
    if (!validSha256(report.discoverySha256)) errors.push('missing or invalid discovery path-set hash');
    if (reviewed === null) errors.push('reviewed must be a non-negative integer');
    if (failed === null) errors.push('failed must be a non-negative integer');
    if (!truncatedFiles) errors.push('truncatedFiles must be an array of paths');
    if (files && selected !== null && selected !== files.length) {
      errors.push(`selected count ${selected} does not match ${files.length} reported file(s)`);
    }
    if (discovered !== null && selected !== null && omitted !== null && selected + omitted !== discovered) {
      errors.push(`discovery accounting is ${selected} selected + ${omitted} omitted != ${discovered} discovered`);
    }
    if (
      selected !== null && reviewed !== null && failed !== null && truncatedFiles &&
      reviewed + failed + truncatedFiles.length !== selected
    ) {
      errors.push(`review coverage is ${reviewed + failed + truncatedFiles.length}/${selected} selected file(s)`);
    }
    if (failed !== null && failed > 0) errors.push(`${failed} file(s) failed review`);
    if (truncatedFiles?.length) errors.push(`${truncatedFiles.length} file diff(s) were truncated`);
    if (omitted !== null && omitted > 0) {
      errors.push(`${omitted} discovered file(s) were omitted by the review cap`);
    }
    if (options.requireMcp) {
      const mcp = object(report.mcpContext);
      if (!mcp) errors.push('MCP context consumption is required');
      else {
        if (!validSha256(mcp.sourceContentSha256)) errors.push('missing or invalid MCP source content hash');
        if (!validSha256(mcp.consumedContentSha256)) errors.push('missing or invalid MCP consumed content hash');
        if (finiteCount(mcp.sourceChars) === null) errors.push('missing MCP source character count');
        if (finiteCount(mcp.consumedChars) === null) errors.push('missing MCP consumed character count');
        if (typeof mcp.truncated !== 'boolean') errors.push('missing MCP truncation flag');
        if (typeof mcp.query !== 'string' || !mcp.query.trim()) errors.push('missing MCP context query');
      }
    }
  }

  if (kind === 'button-crawl') {
    if (report.schema !== 'reckons.button-crawl/v1') errors.push('unexpected button-crawl schema');
    if (!validTime(report.finishedAt)) errors.push('missing or invalid finishedAt');
    const routes = strings(report.routes);
    const crawled = strings(report.crawled);
    const skipped = Array.isArray(report.skipped) ? report.skipped : null;
    if (!routes) errors.push('routes must be an array');
    if (routes?.length === 0) errors.push('button crawl requested no routes');
    if (!crawled) errors.push('crawled must be an array');
    if (!skipped) errors.push('skipped must be an array');
    if (skipped?.length) errors.push(`${skipped.length} route(s) were skipped`);
    if (routes && crawled) {
      const covered = new Set(crawled);
      const missing = routes.filter((route) => !covered.has(route));
      if (missing.length) errors.push(`routes not crawled: ${missing.join(', ')}`);
    }
  }

  if (kind === 'visual-diff') {
    if (report.schema !== 'reckons.visual-diff/v1') errors.push('unexpected visual-diff schema');
    if (!validTime(report.finishedAt)) errors.push('missing or invalid finishedAt');
    const routes = strings(report.routes);
    const skipped = Array.isArray(report.skipped) ? report.skipped : null;
    if (!routes) errors.push('routes must be an array');
    if (routes?.length === 0) errors.push('visual diff requested no routes');
    if (!skipped) errors.push('skipped must be an array');
    if (skipped?.length) errors.push(`${skipped.length} route(s) were skipped`);
    const flagged = finiteCount(report.flagged);
    if (flagged === null) errors.push('flagged must be a non-negative integer');
    if (flagged !== null && routes && flagged > routes.length) {
      errors.push(`flagged count ${flagged} exceeds ${routes.length} route(s)`);
    }
    if (typeof report.base !== 'string' || !report.base) errors.push('missing base URL');
    if (typeof report.head !== 'string' || !report.head) errors.push('missing head URL');
  }

  return errors;
}
