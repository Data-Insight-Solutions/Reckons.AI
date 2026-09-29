import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { mainCheckoutRoot, pendingQueuePath } from '../lib/main-workspace';

describe('main checkout workspace', () => {
  it('resolves to the checkout that owns .git, even from a worktree', () => {
    const root = mainCheckoutRoot();
    // In the main checkout .git is a directory; in a worktree it is a FILE pointing back here.
    expect(existsSync(path.join(root, '.git')) && statSync(path.join(root, '.git')).isDirectory()).toBe(true);
    expect(pendingQueuePath()).toBe(path.join(root, 'reckons-workspace', 'knowledge.pending.jsonl'));
  });
});
