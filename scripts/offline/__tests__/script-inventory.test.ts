import { describe, expect, it } from 'vitest';
import { docWords, findOverlaps, findUnreferenced, jaccard, prefixReport, relativeImports, scriptRefs } from '../script-inventory.js';

describe('script-inventory pure functions', () => {
  it('jaccard handles empty and partial sets', () => {
    expect(jaccard(new Set<string>(), new Set(['a']))).toBe(0);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });

  it('scriptRefs extracts script paths from commands', () => {
    expect(scriptRefs('npx tsx scripts/offline/a.ts --x && bash ./scripts/b.sh')).toEqual(['scripts/offline/a.ts', 'scripts/b.sh']);
    expect(scriptRefs('vite build')).toEqual([]);
  });

  it('relativeImports resolves against the importing file and drops extensions', () => {
    const src = `import a from './lib/x.js';\nimport { b } from '../y';\nimport z from 'node:fs';`;
    expect(relativeImports(src, 'scripts/offline/main.ts')).toEqual(['scripts/offline/lib/x', 'scripts/y']);
  });

  it('docWords ignores short blocks and stop words', () => {
    expect(docWords('/** tiny */').size).toBe(0);
    expect(docWords('/** alpha bravo charlie delta echo foxtrot golf hotel with this */').has('with')).toBe(false);
    expect(docWords('/** alpha bravo charlie delta echo foxtrot golf hotel */').size).toBe(8);
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

  it('findOverlaps groups by stem, import Jaccard and doc words', () => {
    const doc = '/** alpha bravo charlie delta echo foxtrot golf hotel india */';
    const infos = [
      { file: 'scripts/x/dup.ts', source: '' },
      { file: 'scripts/y/dup.ts', source: '' },
      { file: 'scripts/p.ts', source: `import './a.js'; import './b.js';` },
      { file: 'scripts/q.ts', source: `import './a.js'; import './b.js';` },
      { file: 'scripts/d1.ts', source: doc },
      { file: 'scripts/d2.ts', source: doc },
      { file: 'scripts/alone.ts', source: `import './zzz.js'; import './yyy.js';` },
    ];
    const groups = findOverlaps(infos);
    expect(groups.map((g) => g.files)).toEqual([
      ['scripts/d1.ts', 'scripts/d2.ts'],
      ['scripts/p.ts', 'scripts/q.ts'],
      ['scripts/x/dup.ts', 'scripts/y/dup.ts'],
    ]);
    expect(groups[2].reasons[0]).toMatch(/same name stem/);
  });

  it('prefixReport counts prefixes and flags names that break the pattern', () => {
    const r = prefixReport(['build:a', 'build:b', 'build-storybook', 'test:x', 'lone']);
    expect(r.counts[0]).toEqual(['build', 2]);
    expect(r.breaks.map((b) => b.name)).toEqual(['build-storybook']);
    const r2 = prefixReport(['docs:a', 'docs:b', 'docs-site:c']);
    expect(r2.breaks.map((b) => b.name)).toEqual(['docs-site:c']);
  });
});
