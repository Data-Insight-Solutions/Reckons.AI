import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spaceForFileMap } from '../workspace-space';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('spaceForFileMap', () => {
  it('maps each static graph to the workspace space that links it, and skips what no space links', () => {
    root = mkdtempSync(path.join(tmpdir(), 'ws-space-'));
    mkdirSync(path.join(root, 'static'));
    for (const f of ['reckons-roadmap.ttl', 'docs-all.ttl', 'website.ttl']) writeFileSync(path.join(root, 'static', f), '');
    for (const [space, file] of [['roadmap', 'reckons-roadmap.ttl'], ['docs', 'docs-all.ttl']]) {
      mkdirSync(path.join(root, 'reckons-workspace', 'kbs', space), { recursive: true });
      symlinkSync(`../../../static/${file}`, path.join(root, 'reckons-workspace', 'kbs', space, `${space}.ttl`));
    }
    // A dangling link names no file; it must not throw or map anything.
    symlinkSync('../../../static/gone.ttl', path.join(root, 'reckons-workspace', 'kbs', 'docs', 'gone.ttl'));

    const map = spaceForFileMap(root);
    expect(map.get(path.join('static', 'reckons-roadmap.ttl'))).toBe('roadmap');
    expect(map.get(path.join('static', 'docs-all.ttl'))).toBe('docs');
    expect(map.has(path.join('static', 'website.ttl'))).toBe(false);
    expect(map.size).toBe(2);
  });

  it('returns an empty map when there is no workspace', () => {
    root = mkdtempSync(path.join(tmpdir(), 'ws-space-'));
    expect(spaceForFileMap(root).size).toBe(0);
  });
});
