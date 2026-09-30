/**
 * RENAME BY COMPILER, NOT BY TEXT (F203.4, script tier) — the edit half of the taxonomy rename.
 *
 * Matt, 2026-09-30: the large refactor should run mostly without cloud Claude, and the rename plan
 * (kb:taxonomy-rename) put the EDIT in the script tier: the TypeScript language service finds every
 * reference to a symbol — through imports, re-exports and shorthand properties — or the rename does
 * not happen. A local model editing text can miss one silently (the PR #43 lesson); a model's job in
 * this plan is only the judgment a compiler cannot make, such as which meaning a bare `node` carries.
 *
 * Two operations:
 *   --rename=<file>:<Name>:<NewName>     every reference, across the program's .ts files
 *   --interface-to-type=<file>:<Name>    `interface X {…}` → `type X = {…};` from the syntax tree
 *
 * GUARDS, each refusing rather than guessing:
 *   - the declaration must be unique in the file;
 *   - an EXPORTED symbol whose name appears in any .svelte file is refused: the language service
 *     does not see inside .svelte, so it would leave those references stale. (svelte2tsx support is
 *     the next step of this harness; until then such symbols wait.)
 *   - an interface with `extends`, or a second declaration of the same name
 *     (declaration merging), is refused — the cases where interface and type differ.
 *   - the new name must not already be declared in the file.
 *
 * It edits files and nothing else. Gates (npm run check, the unit suite, naming-ratchet, term-usage)
 * are run by the caller after the batch; --dry-run prints the edit without writing.
 *
 * Usage:
 *   npx tsx scripts/offline/rename-identifier.ts --rename=src/lib/x.ts:foo:FOO [--dry-run]
 *   npx tsx scripts/offline/rename-identifier.ts --interface-to-type=src/lib/x.ts:Thing [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');

export type Edit = { file: string; start: number; end: number; text: string };

function languageService(): ts.LanguageService {
  const configPath = join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const files = parsed.fileNames.filter((f) => /\.[cm]?tsx?$/.test(f));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: () => '0',
    getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8')) : undefined),
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/** Declarations named `name` at the top level of a source file. */
export function topLevelDeclarations(sf: ts.SourceFile, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) out.push(d.name);
    } else if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) {
      out.push(st.name);
    }
  }
  return out;
}

function isExported(node: ts.Node): boolean {
  let n: ts.Node | undefined = node;
  while (n && !ts.isSourceFile(n)) {
    if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    n = n.parent;
  }
  return false;
}

function svelteFilesMentioning(name: string): string[] {
  try {
    return execFileSync('git', ['grep', '-lw', name, '--', '*.svelte'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
}

export function planRename(file: string, name: string, newName: string, ls = languageService()): Edit[] {
  const abs = resolve(ROOT, file);
  const program = ls.getProgram();
  const sf = program?.getSourceFile(abs);
  if (!sf) throw new Error(`${file} is not part of the TypeScript program (tsconfig include)`);
  const decls = topLevelDeclarations(sf, name);
  if (decls.length !== 1) throw new Error(`expected exactly one top-level declaration of ${name} in ${file}, found ${decls.length}`);
  if (topLevelDeclarations(sf, newName).length) throw new Error(`${newName} is already declared in ${file}`);
  if (isExported(decls[0])) {
    const svelte = svelteFilesMentioning(name);
    if (svelte.length) throw new Error(`${name} is exported and named in ${svelte.length} .svelte file(s) (${svelte.slice(0, 3).join(', ')}) which the language service cannot see — refusing until svelte2tsx support lands`);
  }
  const locations = ls.findRenameLocations(abs, decls[0].getStart(sf), false, false, { providePrefixAndSuffixTextForRename: true });
  if (!locations?.length) throw new Error(`the language service found no rename locations for ${name}`);
  return locations.map((l) => ({
    file: relative(ROOT, l.fileName),
    start: l.textSpan.start,
    end: l.textSpan.start + l.textSpan.length,
    text: `${l.prefixText ?? ''}${newName}${l.suffixText ?? ''}`,
  }));
}

/** `interface X<T> { … }` → `type X<T> = { … };`, refusing where the two are not equivalent. */
export function planInterfaceToType(file: string, name: string, text = readFileSync(resolve(ROOT, file), 'utf8')): Edit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const matches = sf.statements.filter((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name);
  if (matches.length !== 1) throw new Error(`expected one interface ${name} in ${file}, found ${matches.length} (several would be declaration merging)`);
  const decl = matches[0];
  if (decl.heritageClauses?.length) throw new Error(`interface ${name} extends another type; convert by hand with an intersection`);
  const modifiers = (ts.getModifiers(decl) ?? []).map((m) => m.getText(sf)).join(' ');
  const typeParams = decl.typeParameters ? `<${decl.typeParameters.map((p) => p.getText(sf)).join(', ')}>` : '';
  const openBrace = text.indexOf('{', decl.name.end);
  const body = text.slice(openBrace, decl.end);
  const start = decl.getStart(sf);
  return [{ file, start, end: decl.end, text: `${modifiers ? `${modifiers} ` : ''}type ${name}${typeParams} = ${body};` }];
}

/** Apply edits back to front per file, so earlier offsets stay valid. */
export function applyEdits(edits: Edit[], read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8'), write = (f: string, t: string) => writeFileSync(resolve(ROOT, f), t)): string[] {
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, list] of byFile) {
    let text = read(file);
    for (const e of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    write(file, text);
  }
  return [...byFile.keys()];
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const dry = argv.includes('--dry-run');
  let edits: Edit[];
  try {
    const rename = flag('rename');
    const toType = flag('interface-to-type');
    if (rename) {
      const [file, name, newName] = rename.split(':');
      if (!file || !name || !newName) throw new Error('--rename=<file>:<Name>:<NewName>');
      edits = planRename(file, name, newName);
    } else if (toType) {
      const [file, name] = toType.split(':');
      if (!file || !name) throw new Error('--interface-to-type=<file>:<Name>');
      edits = planInterfaceToType(file, name);
    } else {
      throw new Error('Usage: --rename=<file>:<Name>:<NewName> | --interface-to-type=<file>:<Name> [--dry-run]');
    }
  } catch (e) {
    console.error(`rename-identifier: REFUSED — ${(e as Error).message}`);
    process.exit(1);
  }
  const files = [...new Set(edits.map((e) => e.file))];
  console.log(`${edits.length} edit(s) in ${files.length} file(s): ${files.join(', ')}${dry ? ' (dry run, nothing written)' : ''}`);
  if (!dry) applyEdits(edits);
}

if (process.argv[1] && process.argv[1].endsWith('rename-identifier.ts')) main();
