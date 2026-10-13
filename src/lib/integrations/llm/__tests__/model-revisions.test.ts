import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_REVISIONS, UNPINNABLE_LOADERS, isPinned, revisionFor } from '../model-revisions';

/**
 * Model ids from these Hugging Face organizations that appear in source but are never loaded, each
 * with the reason. Anything else from these organizations must be pinned in model-revisions.ts.
 */
const NOT_LOADED: Record<string, string> = {
  'Xenova/Qwen2.5-0.5B-Instruct': 'db.ts STALE_MODELS migration list and a doc comment; the repo is gone',
};
const HF_ORGS = ['Xenova', 'onnx-community', 'HuggingFaceTB', 'nomic-ai'];

describe('model revisions', () => {
  it('pins every entry to a full commit sha, which cannot move', () => {
    for (const [repo, sha] of Object.entries(MODEL_REVISIONS)) expect(sha, repo).toMatch(/^[0-9a-f]{40}$/);
  });

  it('pins every Hugging Face model the source names, unless it is listed as never loaded', () => {
    const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|svelte)$/.test(f) && !f.includes('__tests__'));
    const pattern = new RegExp(`['"\`]((?:${HF_ORGS.join('|')})/[A-Za-z0-9._-]+)['"\`]`, 'g');
    const named = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(pattern)) named.add(m[1]);

    expect(named.size).toBeGreaterThan(10); // the scan found the real lists, not nothing
    const unpinned = [...named].filter((r) => !(r in MODEL_REVISIONS) && !(r in NOT_LOADED));
    expect(unpinned).toEqual([]);
  });

  it('fetches the pinned commit for a pinned model and main for anything else', () => {
    expect(revisionFor('Xenova/bge-small-en-v1.5')).toBe(MODEL_REVISIONS['Xenova/bge-small-en-v1.5']);
    expect(isPinned('Xenova/bge-small-en-v1.5')).toBe(true);
    expect(revisionFor('someone/typed-in-settings')).toBe('main');
    expect(isPinned('someone/typed-in-settings')).toBe(false);
  });

  it('does not claim a pin for a loader that drops the revision', () => {
    for (const repo of Object.keys(UNPINNABLE_LOADERS)) {
      expect(isPinned(repo), repo).toBe(false);
      expect(revisionFor(repo), repo).toBe('main');
    }
  });
});
