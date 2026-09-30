/**
 * term-senses grounding (F203.4). The panel can only be as right as the menu and the sites it is
 * shown, so the grounding is tested against the real terminology graph: if a meaning is added to
 * the graph it must reach the menu, and a site must be one identifier per line with its context.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTask, moduleOf, sampleSites, sensesFor, sitesIn, type Site } from '../term-senses';

const TTL = readFileSync(resolve(import.meta.dirname, '../../../static/reckons-terminology.ttl'), 'utf8');

describe('sensesFor — the menu comes from the graph, not from the prompt', () => {
  it('finds every meaning of node the terminology graph defines', () => {
    const ids = sensesFor('node', TTL).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['rdf-node', 'graph-vertex', 'rendered-node', 'scene-object', 'node-runtime']));
  });

  it('carries each meaning’s definition, because a bare id is not enough to judge by', () => {
    const rdf = sensesFor('node', TTL).find((s) => s.id === 'rdf-node');
    expect(rdf?.definition).toMatch(/RDF triple/);
  });

  it('treats the plural as the same word', () => {
    expect(sensesFor('nodes', TTL).length).toBe(sensesFor('node', TTL).length);
  });
});

describe('sitesIn — one site per line, with the marked line in its context', () => {
  const text = ['const a = 1;', 'const nodeMap = new Map();', 'for (const node of nodes) {}', 'const other = 2;'].join('\n');

  it('matches camelCase segments and reports one site per line', () => {
    const sites = sitesIn('src/x.ts', text, 'node');
    expect(sites.map((s) => [s.line, s.token])).toEqual([[2, 'nodeMap'], [3, 'node']]);
  });

  it('marks the target line in the context', () => {
    const [first] = sitesIn('src/x.ts', text, 'node');
    expect(first.context).toMatch(/^>>\s+2 const nodeMap/m);
    expect(first.context).toMatch(/^ {3}\s+1 const a = 1;/m);
  });

  it('does not match a word that merely contains the letters', () => {
    expect(sitesIn('src/x.ts', 'const anode = 1; const nodeless = 2;', 'node')).toEqual([]);
  });
});

describe('sampleSites — coverage of files first, deterministic by seed', () => {
  const site = (file: string, line: number): Site => ({ file, line, token: 'node', binding: 'free', context: '' });
  const byFile = new Map([
    ['a.ts', [site('a.ts', 1), site('a.ts', 2), site('a.ts', 3)]],
    ['b.ts', [site('b.ts', 1)]],
    ['c.ts', [site('c.ts', 1)]],
  ]);

  it('takes one site from every file before a second from any', () => {
    const files = sampleSites(byFile, 3, 1).map((s) => s.file).sort();
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('is the same sample for the same seed', () => {
    expect(sampleSites(byFile, 4, 7)).toEqual(sampleSites(byFile, 4, 7));
  });

  it('stops at the number of sites that exist', () => {
    expect(sampleSites(byFile, 50, 1)).toHaveLength(5);
  });
});

describe('buildTask', () => {
  it('offers exactly the graph’s meanings plus other, and one item per site', () => {
    const senses = sensesFor('node', TTL);
    const t = buildTask('node', senses, [{ file: 'src/x.ts', line: 3, token: 'node', binding: 'free', context: '>> 3 x' }]);
    const props = t.answer.properties as { sense: { enum: string[] } };
    expect(props.sense.enum).toEqual([...senses.map((s) => s.id), 'other']);
    expect(t.items).toEqual([{ id: 'src/x.ts:3', context: 'FILE src/x.ts\nIDENTIFIER node\n>> 3 x' }]);
  });

  it('groups files by the directory a rename batch would take', () => {
    expect(moduleOf('src/lib/3d/scene.ts')).toBe('src/lib/3d');
    expect(moduleOf('src/lib/embed.ts')).toBe('src/lib');
  });
});
