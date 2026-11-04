import { describe, expect, it } from 'vitest';
import { findUnreferenced, prefixReport, relativeImports, scriptRefs, spawnedSiblings } from '../script-inventory.js';

describe('script-inventory pure functions', () => {
  it('scriptRefs extracts script paths from commands', () => {
    expect(scriptRefs('npx tsx scripts/offline/a.ts --x && bash ./scripts/b.sh')).toEqual(['scripts/offline/a.ts', 'scripts/b.sh']);
    expect(scriptRefs('vite build')).toEqual([]);
  });

  it('relativeImports resolves against the importing file and drops extensions', () => {
    const src = `import a from './lib/x.js';\nimport { b } from '../y';\nimport z from 'node:fs';`;
    expect(relativeImports(src, 'scripts/offline/main.ts')).toEqual(['scripts/offline/lib/x', 'scripts/y']);
  });

  it('findUnreferenced follows one level of imports from referenced files', () => {
    const infos = [
      { file: 'scripts/a.ts', source: `import './lib/h.js';` },
      { file: 'scripts/lib/h.ts', source: `import './deep.js';` },
      { file: 'scripts/lib/deep.ts', source: '' },
      { file: 'scripts/orphan.ts', source: '' },
      { file: 'scripts/run.sh', source: 'bash scripts/via-sh.ts' },
      { file: 'scripts/via-sh.ts', source: '' },
    ];
    expect(findUnreferenced(infos, new Set(['scripts/a.ts', 'scripts/run.sh']))).toEqual(['scripts/lib/deep.ts', 'scripts/orphan.ts']);
  });

  it('findUnreferenced counts a sibling spawned via path.join as referenced (job-watch false positive)', () => {
    const infos = [
      { file: 'scripts/agent/queue-worker.ts', source: "const w = path.join(path.dirname(here), 'job-watch.ts');" },
      { file: 'scripts/agent/job-watch.ts', source: '' },
      { file: 'scripts/agent/truly-orphan.ts', source: '' },
    ];
    expect(spawnedSiblings(infos[0].source, infos[0].file, infos)).toEqual(['scripts/agent/job-watch.ts']);
    expect(findUnreferenced(infos, new Set(['scripts/agent/queue-worker.ts']))).toEqual(['scripts/agent/truly-orphan.ts']);
  });

  it('spawnedSiblings ignores an ambiguous bare name that is not a sibling', () => {
    const infos = [
      { file: 'scripts/a/main.ts', source: "run('dup.ts')" },
      { file: 'scripts/b/dup.ts', source: '' },
      { file: 'scripts/c/dup.ts', source: '' },
    ];
    expect(spawnedSiblings(infos[0].source, infos[0].file, infos)).toEqual([]);
  });

  it('prefixReport counts prefixes and flags names that break the pattern', () => {
    const r = prefixReport(['build:a', 'build:b', 'build-storybook', 'test:x', 'lone']);
    expect(r.counts[0]).toEqual(['build', 2]);
    expect(r.breaks.map((b) => b.name)).toEqual(['build-storybook']);
    const r2 = prefixReport(['docs:a', 'docs:b', 'docs-site:c']);
    expect(r2.breaks.map((b) => b.name)).toEqual(['docs-site:c']);
  });
});
