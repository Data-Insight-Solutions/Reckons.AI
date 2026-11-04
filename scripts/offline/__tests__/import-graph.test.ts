/**
 * Fixture tests for the import resolver (lib/import-graph.ts) — the "who calls whom" layer
 * dead-weight.ts uses for its module-level claim.
 *
 * The tree is tiny and lives in a temp dir, NEVER the real repo: a module imported ONLY
 * through the $lib alias must be reported as called, and the same for './x.js', for an
 * extensionless specifier, and for a barrel's re-exports; a module nobody imports must
 * still be reported. The 2026-11-03 bug was a module-level claim ("a whole module with no
 * entry point") made about modules that are imported everywhere; these tests pin the edges
 * such a claim needs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildImportMap, deadModules } from '../lib/import-graph.js';

let dir: string;
const write = (rel: string, text: string) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
};

afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; }
});

const fixture = (): string => {
  dir = mkdtempSync(path.join(tmpdir(), 'import-graph-'));
  write('src/lib/alias-target.ts', 'export function aliasTarget() { return 1; }\n');
  write('src/lib/dotjs.ts', 'export function viaJs() { return 2; }\n');
  write('src/lib/plain.ts', 'export function viaPlain() { return 3; }\n');
  write('src/lib/lazy.ts', 'export function lazyThing() { return 4; }\n');
  write('src/lib/barrel-target.ts', 'export function inBarrel() { return 5; }\n');
  // A barrel that re-exports another module: the re-export line is a caller edge.
  write('src/lib/index.ts', "export * from './barrel-target.js';\n");
  write('src/lib/unused.ts', 'export function nobodyImports() { return 6; }\n');
  // A worker: a module loaded by path (new URL + new Worker), the Vite pattern in
  // src/lib/integrations/llm/wasm.ts — not an import, but still a caller edge.
  write('src/lib/worker.ts', 'export const workerMarker = 7;\n');
  // A module imported ONLY by a test file: a test drives it, so it is called.
  write('src/lib/test-only.ts', 'export function testOnly() { return 8; }\n');
  write('src/lib/__tests__/thing.test.ts', "import { testOnly } from '../test-only.js';\nvoid testOnly();\n");
  // The caller is a .svelte route with markup around its script: the import lines must
  // still be found, exactly as they are in the real app.
  write('src/routes/+page.svelte',
    '<script lang="ts">\n'
    + "import { aliasTarget } from '$lib/alias-target';\n"
    + "import { viaJs } from '$lib/dotjs.js';\n"
    + "import { viaPlain } from '../lib/plain';\n"
    + "import { inBarrel } from '$lib';\n"
    + "import { noSuchThing } from '$lib/does-not-exist';\n"
    + "const load = () => import('$lib/lazy.js');\n"
    + "const worker = new Worker(new URL('../lib/worker.ts', import.meta.url), { type: 'module' });\n"
    + 'void [aliasTarget, viaJs, viaPlain, inBarrel, noSuchThing, load, worker];\n'
    + '</script>\n'
    + '<h1>hello</h1>\n');
  return dir;
};

describe('import-graph (the resolver behind dead-weight\'s module claim)', () => {
  it('reports a module called only through the $lib alias as called', () => {
    expect(deadModules(buildImportMap(fixture()))).not.toContain('src/lib/alias-target.ts');
  });

  it('resolves a .js specifier to the .ts file, through the alias', () => {
    expect(deadModules(buildImportMap(fixture()))).not.toContain('src/lib/dotjs.ts');
  });

  it('resolves an extensionless relative specifier', () => {
    expect(deadModules(buildImportMap(fixture()))).not.toContain('src/lib/plain.ts');
  });

  it('counts a barrel re-export as a caller of what it re-exports', () => {
    const m = buildImportMap(fixture());
    expect(deadModules(m)).not.toContain('src/lib/barrel-target.ts');
    // and the barrel itself is called by `from '$lib'`
    expect(deadModules(m)).not.toContain('src/lib/index.ts');
  });

  it('counts a dynamic import() as a caller', () => {
    expect(deadModules(buildImportMap(fixture()))).not.toContain('src/lib/lazy.ts');
  });

  it('counts a worker registration (new Worker + new URL) as a caller', () => {
    expect(deadModules(buildImportMap(fixture()))).not.toContain('src/lib/worker.ts');
  });

  it('treats a test file as an entry, and counts the module it drives as called', () => {
    const m = buildImportMap(fixture());
    expect(m.entries).toContain('src/lib/__tests__/thing.test.ts');
    expect(deadModules(m)).not.toContain('src/lib/__tests__/thing.test.ts');
    // imported only by the test — a test driving a module is the module being called
    expect(deadModules(m)).not.toContain('src/lib/test-only.ts');
  });

  it('still reports a module nobody imports', () => {
    expect(deadModules(buildImportMap(fixture()))).toContain('src/lib/unused.ts');
  });

  it('treats routes as entry points, and records what it could NOT resolve', () => {
    const m = buildImportMap(fixture());
    expect(m.entries).toContain('src/routes/+page.svelte');
    // Honesty about the edges: a broken specifier is named, not silently dropped.
    expect(m.unresolved.get('src/routes/+page.svelte')).toContain('$lib/does-not-exist');
  });
});
