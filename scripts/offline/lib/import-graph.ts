/**
 * Import edges — deterministic "who calls whom" over the repo's .ts and .svelte files.
 *
 * dead-weight used to guess "no callers" from whole-repo identifier matching and then rolled
 * that up into a whole-module verdict ("a whole module with no entry point") it could not
 * support: a module with three dead symbols was reported as an orphaned feature while it was
 * imported everywhere. This builds the edges such a verdict needs — the actual import lines,
 * resolved the way the bundler resolves them:
 *   - '$lib/x'        → src/lib/x        (the SvelteKit alias, or any passed alias)
 *   - './x.js', './x' → x.ts or x.svelte (extension substitution, as TS/ESM importers write it)
 *   - './x'           → x/index.ts       (a directory with an index file)
 *   - a barrel line that re-exports from './x' is an edge from the barrel to x: a barrel's
 *     re-exports count as callers of what it re-exports
 *
 * Bare package specifiers leave the repo and are not edges. A module reached only through a
 * namespace import (import * as m; then m.foo) is not proven called here either: for a
 * maintenance flag, fewer claims beats more. What this layer CANNOT see is named in the
 * unresolved and external lists so a human can check it, rather than silently assumed.
 *
 * SCRIPT TIER (F74.3): parsed with the TypeScript compiler — no regex over code, no tokens,
 * no hallucination. Pure over a root directory: tests point it at a fixture tree, never the
 * real repo.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface ImportMap {
  /** every module file under the scanned roots (root-relative, /-separated) */
  files: string[];
  /** file → repo files it imports (resolved and in-universe) */
  imports: Map<string, Set<string>>;
  /** file → specifiers that resolved to nothing and are not bare packages (broken, or out of universe) */
  unresolved: Map<string, string[]>;
  /** entry points: files nothing imports by nature (routes, stories, hooks, workers, tests) */
  entries: Set<string>;
}

export interface Options {
  /** directories to walk for modules, relative to root. Default: ['src']. */
  roots?: string[];
  /** extra directories whose files may CALL a module without being modules themselves.
      Default: ['scripts', 'cli/src', 'mcp-server/src', 'tests']. */
  callerRoots?: string[];
  /** alias → repo directory. Default: { '$lib': 'src/lib' } (SvelteKit's built-in alias). */
  aliases?: Record<string, string>;
  /** is this file an entry point (nothing imports it by nature)? */
  isEntry?: (file: string) => boolean;
  /** is this file out of scope entirely (a separate build with its own entries)? */
  isExcluded?: (file: string) => boolean;
}

/**
 * Entry points are loaded by a framework or a harness, not imported: SvelteKit routes,
 * Storybook stories, hooks, the service worker, type declarations, and test files (run by
 * vitest). A test file is BOTH — an entry (nothing imports it) and a caller (the imports it
 * writes count as call edges), so a module a test drives is still reported as called.
 */
export const defaultIsEntry = (f: string): boolean =>
  f.startsWith('src/routes/') || f.startsWith('src/stories/')
  || f === 'src/hooks.ts' || f === 'src/hooks.server.ts'
  || f === 'src/service-worker.ts' || f.startsWith('src/service-worker/')
  || f.includes('__tests__/') || f.endsWith('.test.ts') || f.endsWith('.test.svelte')
  || f.endsWith('.d.ts');

/** The browser extension is a SEPARATE app with its own manifest entries (vite.extension.config.ts);
    judging its internals from the app's edges would flag entry files the manifest loads. */
export const defaultIsExcluded = (f: string): boolean => f.startsWith('src/extension/');

const SKIP = new Set(['node_modules', 'dist', 'build', '.svelte-kit', '.git', 'coverage', 'storybook-static', 'playwright-report']);
const SOURCE = /\.(ts|svelte)$/;

function walk(dir: string, out: Set<string>, root: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = path.join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, root);
    else if (SOURCE.test(e) && !e.endsWith('.d.ts')) {
      out.add(path.relative(root, p).split(path.sep).join('/'));
    }
  }
}

/** Every module specifier in the file: static imports, side-effect imports, re-exports,
    dynamic import(...), and worker registrations (new URL('./x.ts', import.meta.url) —
    the Vite worker pattern in src/lib/integrations/llm/wasm.ts, where the worker file
    is loaded by a path, not an import). Parsed with the TypeScript compiler, so markup
    and comments in .svelte files are noise the parser recovers over — the import lines
    are still found. */
function specifiersOf(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword
      && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])) {
      out.push(n.arguments[0].text);
    } else if (ts.isNewExpression(n) && n.expression.kind === ts.SyntaxKind.Identifier
      && (n.expression as ts.Identifier).text === 'URL'
      && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0])
      && (n.arguments[0].text.startsWith('./') || n.arguments[0].text.startsWith('../'))) {
      // new URL('./x.ts', import.meta.url) — a module loaded by path (a worker).
      // Only RELATIVE literals count: new URL(value) with a variable is runtime URL
      // parsing, of which this repo is full, and must not become a module edge.
      out.push(n.arguments[0].text);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * Candidate file names for one base path, in bundler order. A specifier written with a .js
 * ending (the ESM/TS convention for a .ts file) is tried with the .js stripped as well:
 * './util.js' and '$lib/util.js' both mean util.ts on disk.
 */
const CANDIDATES = (base: string): string[] => {
  const out = [base, `${base}.ts`, `${base}.svelte`, `${base}/index.ts`, `${base}/index.svelte`];
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -3);
    out.push(stem, `${stem}.ts`, `${stem}.svelte`, `${stem}/index.ts`, `${stem}/index.svelte`);
  }
  return out;
};

/**
 * Resolve one specifier the way the bundler does. Returns the root-relative target,
 * `'external'` for bare package names, or null when nothing on disk matches (a broken
 * import, or a target outside the scanned universe).
 */
function resolveOne(root: string, from: string, spec: string, aliases: Record<string, string>): string | 'external' | null {
  let base: string | null = null;
  for (const [alias, dir] of Object.entries(aliases)) {
    if (spec === alias || spec.startsWith(`${alias}/`)) {
      base = path.join(root, dir, spec === alias ? '' : spec.slice(alias.length + 1));
      break;
    }
  }
  if (base === null) {
    if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(root, path.dirname(from), spec);
    else return 'external';
  }
  for (const c of CANDIDATES(base)) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return path.relative(root, c).split(path.sep).join('/');
    } catch { /* unreadable — keep looking */ }
  }
  return null;
}

/**
 * Build the import edges over the tree under `root`. Pure: reads only that tree (and nothing
 * else), which is what lets a test point it at a fixture directory.
 */
export function buildImportMap(root: string, opts: Options = {}): ImportMap {
  const roots = opts.roots ?? ['src'];
  const callerRoots = opts.callerRoots ?? ['scripts', 'cli/src', 'mcp-server/src', 'tests'];
  const aliases = opts.aliases ?? { '$lib': 'src/lib' };
  const isEntry = opts.isEntry ?? defaultIsEntry;
  const isExcluded = opts.isExcluded ?? defaultIsExcluded;

  const modules = new Set<string>();
  for (const r of roots) walk(path.join(root, r), modules, root);

  const callers = new Set<string>(modules);
  for (const r of callerRoots) walk(path.join(root, r), callers, root);

  const imports = new Map<string, Set<string>>();
  const unresolved = new Map<string, string[]>();
  const entries = new Set<string>();
  for (const f of callers) {
    let text: string;
    try { text = readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const spec of specifiersOf(f, text)) {
      const r = resolveOne(root, path.join(root, f), spec, aliases);
      if (r === 'external') continue;
      if (r === null) { (unresolved.get(f) ?? unresolved.set(f, []).get(f)!).push(spec); continue; }
      // Only edges into the scanned universe are recorded; a script importing another
      // script is not evidence about an app module.
      if (!modules.has(r)) continue;
      (imports.get(f) ?? imports.set(f, new Set()).get(f)!).add(r);
    }
    if (isEntry(f)) entries.add(f);
  }

  const files = [...modules].filter((f) => !isExcluded(f)).sort();
  return { files, imports, unresolved, entries };
}

/**
 * Modules nothing calls: no file in the repo (app, tests, scripts, CLI, MCP server) has an
 * import line that resolves to them, and they are not entry points. A barrel that re-exports
 * a module counts as its caller, so a dead feature island shows up as the death of its
 * BARREL — its root — not as a list of its internals.
 */
export function deadModules(m: ImportMap): string[] {
  const called = new Set<string>();
  for (const [from, to] of m.imports) for (const t of to) if (t !== from) called.add(t);
  return m.files.filter((f) => !called.has(f) && !m.entries.has(f));
}
