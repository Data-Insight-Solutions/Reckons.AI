/**
 * Codex voice — the automated incorporation of OpenAI Codex CLI into the tri-party
 * council (Matt + Claude + Codex). See F102 kpred:decision (2026-07-21).
 *
 * Codex is a READ-ONLY ADVISORY voice: it proposes, it never writes. We drive it
 * head-lessly with `codex exec` and — crucially — constrain its FINAL answer to a
 * JSON Schema we define (`--output-schema`), so the council consumes structured
 * findings by contract rather than parsing free text. This is the PR #43 lesson made
 * structural: ground → prompt → VALIDATE → emit-proposal.
 *
 * Auth is Matt's ChatGPT subscription (`codex login --device-auth`), not an API key.
 * If Codex is not installed or not logged in, this returns { ok:false, reason } and
 * the council records the voice as ABSENT — never a silent single-voice pass.
 */
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface CodexFinding {
  file?: string;
  text: string;
}

export interface CodexResult {
  ok: boolean;
  reason?: string;
  findings: CodexFinding[];
  /** The model's raw final message, kept for debugging a failed parse. */
  raw: string;
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The shape we force Codex's final answer into. A reviewer returns a list of findings. */
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // OpenAI strict structured-output requires EVERY property under
          // additionalProperties:false to be listed in `required`. So `file` is
          // required-but-NULLABLE (the reviewer sends null when a finding is not
          // file-specific); parseCodexOutput maps null → undefined. Validated live
          // 2026-07-21 — an optional field is rejected with invalid_json_schema.
          file: { type: ['string', 'null'], description: 'repo-relative path the finding is about, or null' },
          text: { type: 'string', description: 'the concrete finding, one issue' },
        },
        required: ['file', 'text'],
      },
    },
  },
  required: ['findings'],
} as const;

function run(args: string[], cwd: string, timeoutMs: number): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('codex', args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { code: e?.status ?? 1, stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e?.message ?? e) };
  }
}

/** Is Codex installed AND authenticated? Cheap pre-flight so we fail loud and early. */
export function codexAvailable(): { ok: boolean; reason?: string } {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
  } catch {
    return { ok: false, reason: 'codex CLI not on PATH — install with `npm i -g @openai/codex`' };
  }
  const status = run(['login', 'status'], process.cwd(), 15_000);
  const out = (status.stdout + status.stderr).toLowerCase();
  if (out.includes('not logged in') || status.code !== 0) {
    return { ok: false, reason: 'codex not authenticated — run `codex login --device-auth`' };
  }
  return { ok: true };
}

/**
 * Parse the schema-constrained final message into findings. Because we passed
 * `--output-schema`, the happy path is a JSON object `{ findings: [...] }`. We stay
 * defensive: a stray code fence is stripped; anything that will not parse is an
 * HONEST failure (ok:false), not a fabricated finding.
 */
export function parseCodexOutput(raw: string): CodexResult {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!trimmed) return { ok: true, findings: [], raw };
  try {
    const obj = JSON.parse(trimmed);
    const list = Array.isArray(obj?.findings) ? obj.findings : [];
    const findings: CodexFinding[] = list
      .filter((f: any) => f && typeof f.text === 'string' && f.text.trim())
      .map((f: any) => ({ file: typeof f.file === 'string' ? f.file : undefined, text: f.text.trim() }));
    return { ok: true, findings, raw };
  } catch {
    return { ok: false, reason: 'codex returned output that did not match the findings schema', findings: [], raw };
  }
}

export interface RunCodexOptions {
  /** Working root for Codex (the repo). Defaults to process.cwd(). */
  cwd?: string;
  /** Sandbox policy. HARD-DEFAULTED to read-only — the advisory role. */
  sandbox?: SandboxMode;
  /** Model override; unset = Codex's own default (verify a pin before forcing one). */
  model?: string;
  timeoutMs?: number;
}

/**
 * Run Codex non-interactively over `prompt` and return structured findings.
 * The caller adapts this to a council MemberResult (member: 'codex').
 */
export function runCodex(prompt: string, opts: RunCodexOptions = {}): CodexResult {
  const avail = codexAvailable();
  if (!avail.ok) return { ok: false, reason: avail.reason, findings: [], raw: '' };

  const cwd = opts.cwd ?? process.cwd();
  const sandbox: SandboxMode = opts.sandbox ?? 'read-only';
  const dir = mkdtempSync(join(tmpdir(), 'codex-council-'));
  const schemaFile = join(dir, 'schema.json');
  const outFile = join(dir, 'last.txt');
  try {
    writeFileSync(schemaFile, JSON.stringify(FINDINGS_SCHEMA));
    const args = [
      'exec',
      '--sandbox', sandbox,
      '--json',
      '--color', 'never',
      '--output-schema', schemaFile,
      '--output-last-message', outFile,
    ];
    if (opts.model) args.push('--model', opts.model);
    args.push(prompt);

    const res = run(args, cwd, opts.timeoutMs ?? 180_000);
    let raw = '';
    try { raw = readFileSync(outFile, 'utf8'); } catch { /* no last message written */ }
    if (!raw && res.code !== 0) {
      return { ok: false, reason: `codex exec failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`, findings: [], raw: res.stdout };
    }
    return parseCodexOutput(raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
