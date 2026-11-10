/** F89.4.3 done-test: 12 unimported files in 2 directories emit 2 questions; after one is answered, 1. */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataFactory } from 'n3';
import { buildImportMap, deadModules } from '../lib/import-graph.js';
import { directoryQuestion, groupByDirectory, isKept, keptDirectories, KEPT_ON_PURPOSE } from '../lib/dead-weight-groups.js';

const { namedNode, literal, quad } = DataFactory;

function fixtureTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dead-weight-'));
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  for (let i = 0; i < 7; i++) put(`src/lib/scaffold/mod${i}.ts`, `export const v${i} = ${i};\n`);
  for (let i = 0; i < 5; i++) put(`src/lib/spare/mod${i}.ts`, `export const w${i} = ${i};\n`);
  put('src/lib/used.ts', 'export const used = 1;\n');
  put('src/routes/+page.ts', "import { used } from '$lib/used';\nexport const x = used;\n");
  return root;
}

const answer = (dir: string) => quad(namedNode('urn:kbase:concept/some-module'), namedNode(KEPT_ON_PURPOSE), literal(dir));

describe('dead-weight asks one question per directory', () => {
  const root = fixtureTree();
  const dead = deadModules(buildImportMap(root));

  it('the fixture has 12 unimported files', () => {
    expect(dead).toHaveLength(12);
  });

  it('emits 2 questions for 12 files in 2 directories', () => {
    const { groups, suppressed } = groupByDirectory(dead, new Set());
    expect(groups.map((g) => [g.dir, g.files.length])).toEqual([['src/lib/scaffold', 7], ['src/lib/spare', 5]]);
    expect(suppressed).toBe(0);
    const row = directoryQuestion(groups[0], { now: '2026-11-10T00:00:00.000Z' });
    expect(row).toMatchObject({ type: 'question', lane: 'question', kb: 'codebase', agent: 'offline:dead-weight' });
    expect(row.question).toContain('kept whole on purpose');
    expect(row.question).toContain('"src/lib/scaffold"');
  });

  it("after one is answered 'kept on purpose' the next run emits 1 and lists no file of that directory", () => {
    const kept = keptDirectories([answer('src/lib/scaffold/')]);
    const { groups, suppressed } = groupByDirectory(dead, kept);
    expect(groups).toHaveLength(1);
    expect(groups[0].dir).toBe('src/lib/spare');
    expect(suppressed).toBe(7);
    expect(groups.flatMap((g) => g.files).some((f) => f.startsWith('src/lib/scaffold/'))).toBe(false);
    const text = JSON.stringify(directoryQuestion(groups[0], { now: 'x' }));
    expect(text).not.toContain('lib/scaffold');
  });

  it('an answer for a parent covers its subdirectories, but not a sibling with a shared prefix', () => {
    const kept = keptDirectories([answer('src/lib/a')]);
    expect(isKept('src/lib/a/b', kept)).toBe(true);
    expect(isKept('src/lib/ab', kept)).toBe(false);
  });
});
