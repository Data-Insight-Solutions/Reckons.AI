/**
 * Shared local-review primitives — the free, local first-pass review loop.
 *
 * Extracted from scripts/offline/code-review.ts so both the single-model local review
 * and the tri-party council (code-review-council.ts) use ONE copy. The council's
 * escalate-on-flagged policy depends on this cheap pass running first: a file the local
 * model flags is what escalates to the paid frontier voices (Claude + Codex).
 *
 * Nothing here calls a cloud model. `warmUp`/`reviewFileLocally` THROW on failure so
 * the caller decides what a local failure means (code-review.ts exits; the council
 * aborts, because with no local pass there is no escalation trigger).
 */
import { execSync } from 'child_process';
import { groundFile } from './graph-grounding.js';

// Files worth reviewing: skip lockfiles, generated, binary, vendored.
export const SKIP =
  /(package-lock\.json|pnpm-lock|yarn\.lock|\.min\.|\.map$|\.svg$|\.png$|\.jpe?g$|\.webm$|\.glb$|\.wasm$|\/draco\/|node_modules\/|content\/|\.snap$)/i;

const MAX_DIFF_CHARS = 14_000; // keep each file's diff within the local model's context

export function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e: any) {
    return e?.stdout ?? '';
  }
}

export type Ollama = (prompt: string) => Promise<string>;

/** Build an Ollama caller bound to a base URL + model. Surfaces the transport cause. */
export function makeOllama(baseUrl: string, model: string): Ollama {
  return async function ollama(prompt: string): Promise<string> {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, options: { num_ctx: 16384, temperature: 0 } }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
      const j = (await res.json()) as { response?: string };
      return (j.response ?? '').trim();
    } catch (e: any) {
      // Node's fetch reports every transport failure as the bare "fetch failed" and hides
      // the reason in .cause — that is how a cold model load looked like mystery failures.
      const cause = e?.cause?.code ?? e?.cause?.message;
      throw new Error(cause ? `${e.message} (${cause})` : String(e?.message ?? e));
    }
  };
}

/**
 * Load the model before the loop and REFUSE to proceed if it will not load — a review
 * that reviews nothing must not report success. Throws on failure.
 */
export async function warmUp(ollama: Ollama): Promise<void> {
  await ollama('Reply with exactly: OK');
}

/** Files changed vs the base (falls back to last commit if base is unknown). */
export function reviewableFiles(base: string, maxFiles: number): { mergeBase: string; files: string[] } {
  let mergeBase = sh(`git merge-base ${base} HEAD 2>/dev/null`).trim();
  if (!mergeBase) mergeBase = 'HEAD~1';
  const files = sh(`git diff --name-only ${mergeBase}...HEAD`)
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f && !SKIP.test(f))
    .slice(0, maxFiles);
  return { mergeBase, files };
}

/** One file's diff vs the merge base, truncated to the model's context. */
export function fileDiff(file: string, mergeBase: string): string {
  let diff = sh(`git diff ${mergeBase}...HEAD -- "${file}"`);
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n… [diff truncated]';
  return diff;
}

/** The shared review prompt — grounded in the graph so a change contradicting intent is catchable. */
export function reviewPrompt(file: string, diff: string): string {
  const grounding = groundFile(file);
  return (
    `You are a careful senior reviewer. Review ONLY this unified diff for real defects: ` +
    `correctness bugs, security issues, missed edge cases, resource leaks, or clearly broken logic. ` +
    `Ignore style/formatting/nits. Be conservative — only flag issues you are confident are real.\n\n` +
    (grounding
      ? `Context from the project's knowledge graph (what this file is FOR — flag changes that contradict it):\n${grounding}\n\n`
      : '') +
    `Output one finding per line as: "<file>:<line-ish> — <concise issue>". ` +
    `If there are no real defects, reply with exactly: NONE\n\n` +
    `File: ${file}\n\`\`\`diff\n${diff}\n\`\`\``
  );
}

/** Parse a local model's line-oriented review output into findings. */
export function parseLocalFindings(out: string): string[] {
  if (/^\s*none\b/i.test(out) || !out.trim()) return [];
  return out
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l && !/^none\b/i.test(l) && l.length > 8);
}

/** Review one file locally → findings (empty = clean). Throws only on transport failure. */
export async function reviewFileLocally(file: string, diff: string, ollama: Ollama): Promise<string[]> {
  const out = await ollama(reviewPrompt(file, diff));
  return parseLocalFindings(out);
}
