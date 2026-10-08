/**
 * RENAME BY COMPILER, NOT BY TEXT (F203.4, script tier) — the edit half of the taxonomy rename.
 *
 * Matt, 2026-09-30: the large refactor should run mostly without cloud Claude, and the rename plan
 * (kb:taxonomy-rename) put the EDIT in the script tier: the TypeScript language service finds every
 * reference to a symbol — through imports, re-exports and shorthand properties — or the rename does
 * not happen. A local model editing text can miss one silently (the PR #43 lesson); a model's job in
 * this plan is only the judgment a compiler cannot make, such as which meaning a bare `node` carries.
 *
 * Operations:
 *   --rename=<file>:<Name>:<NewName>     every reference, across the program's .ts files
 *   --interface-to-type=<file>:<Name>    `interface X {…}` → `type X = {…};` from the syntax tree
 *   --batch=underscore-module-state      F203.4 batch 1: every non-exported `let _x` in src/ → `x`
 *   --batch=term --term=kb --dir=a,b     F203.4 batch 2: top-level declarations whose name has the WHOLE
 *                                        segment kb (kbId, KbEntry, CURRENT_KB, kbs) → knowledgeBase…
 *                                        Names merely containing "kb" (kbase) are listed AMBIGUOUS, never
 *                                        renamed. Only top-level declarations are renamed; properties,
 *                                        members, parameters and locals are counted as "deferred".
 *                                        Extra guard: a name that also appears as a quoted string anywhere
 *                                        in src/ is refused (it may be a stored key or serialized field).
 *
 * GUARDS, each refusing rather than guessing:
 *   - the declaration must be unique at the top level of its file;
 *   - the new name must be a legal identifier and not a keyword (`_default` cannot become `default`);
 *   - the new name must not already be declared in the file;
 *   - SHADOWING: at every reference, no OTHER declaration of the new name may be in scope. The
 *     language service's rename does not check this, and it is the silent failure — renaming
 *     `_loaded` to `loaded` inside `function set(loaded) { _loaded = loaded }` compiles and turns an
 *     assignment into `loaded = loaded`. The type checker is asked at each reference instead;
 *   - an EXPORTED symbol is refused while any import in the program fails to resolve — an importer
 *     the program cannot see is an importer the rename silently skips;
 *   - an EXPORTED symbol whose name appears in any .svelte file is refused: the language service
 *     cannot see inside .svelte, so it would leave those references stale (svelte2tsx support is the
 *     next step of this harness);
 *   - an interface with `extends`, or a second declaration of the same name (declaration merging),
 *     is refused — the cases where interface and type differ.
 *
 * It edits files and nothing else. Gates (npm run check, the unit suite, naming-ratchet) are run by
 * the caller after the batch; --dry-run prints the plan without writing.
 *
 * Usage:
 *   npx tsx scripts/offline/rename-identifier.ts --rename=src/lib/x.ts:foo:FOO [--dry-run]
 *   npx tsx scripts/offline/rename-identifier.ts --interface-to-type=src/lib/x.ts:Thing [--dry-run]
 *   npx tsx scripts/offline/rename-identifier.ts --batch=underscore-module-state [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');

export type Edit = { file: string; start: number; end: number; text: string };

/**
 * One language service over a project, with files versioned so that edits made between renames are
 * seen without rebuilding the program. `memory` replaces the disk entirely — for tests.
 */
export class RenameSession {
  readonly root: string;
  readonly ls: ts.LanguageService;
  private readonly versions = new Map<string, number>();
  private readonly memory?: Map<string, string>;

  constructor(opts: { root?: string; memory?: Record<string, string>; options?: ts.CompilerOptions } = {}) {
    this.root = opts.root ?? ROOT;
    let files: string[];
    let options: ts.CompilerOptions;
    if (opts.memory) {
      this.memory = new Map(Object.entries(opts.memory).map(([f, t]) => [resolve(this.root, f), t]));
      files = [...this.memory.keys()];
      options = opts.options ?? {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true, noEmit: true, lib: ['lib.es2022.d.ts'],
      };
    } else {
      const configPath = join(this.root, 'tsconfig.json');
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
      // A broken config is not a smaller batch. In a fresh worktree .svelte-kit/tsconfig.json (which
      // tsconfig.json extends, and which defines $lib) does not exist yet: every $lib import then
      // fails to resolve and the safety checks refuse each name they cannot verify. Observed
      // 2026-10-07: 19 renames instead of 42, every refusal reasonable-looking. Stop instead.
      const configErrors = [...(config.error ? [config.error] : []), ...parsed.errors];
      if (configErrors.length) {
        const text = configErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ');
        throw new Error(`tsconfig.json does not load cleanly (${text}). In a fresh checkout or worktree run \`npx svelte-kit sync\` first.`);
      }
      files = parsed.fileNames.filter((f) => /\.[cm]?tsx?$/.test(f));
      options = parsed.options;
    }
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => files,
      getScriptVersion: (f) => String(this.versions.get(f) ?? 0),
      getScriptSnapshot: (f) => {
        const text = this.read(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => this.read(f) !== undefined,
      readFile: (f) => this.read(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: (d) => (this.memory ? [...this.memory.keys()].some((f) => f.startsWith(`${resolve(d)}/`)) || ts.sys.directoryExists(d) : ts.sys.directoryExists(d)),
      getDirectories: ts.sys.getDirectories,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  read(file: string): string | undefined {
    const abs = resolve(this.root, file);
    if (this.memory?.has(abs)) return this.memory.get(abs);
    if (this.memory && !abs.includes('node_modules')) return undefined;
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  }

  write(file: string, text: string): void {
    const abs = resolve(this.root, file);
    if (this.memory) this.memory.set(abs, text);
    else writeFileSync(abs, text);
    this.versions.set(abs, (this.versions.get(abs) ?? 0) + 1);
  }

  private unresolved?: string[];

  /**
   * Relative imports the program could not resolve (TS2307). A rename cannot reach an importer the
   * program does not see, and it would say nothing — found 2026-09-30, when a test project without
   * bundler resolution renamed a constant and silently skipped the file importing it. Computed once
   * per session (~8 s on this repository), only when an exported symbol is renamed.
   */
  unresolvedImports(): string[] {
    if (this.unresolved) return this.unresolved;
    const program = this.ls.getProgram();
    const out: string[] = [];
    for (const sf of program?.getSourceFiles() ?? []) {
      if (sf.fileName.includes('node_modules') || program!.isSourceFileDefaultLibrary(sf)) continue;
      for (const d of program!.getSemanticDiagnostics(sf)) {
        if (d.code === 2307) out.push(`${relative(this.root, sf.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    this.unresolved = out;
    return out;
  }

  sourceFile(file: string): ts.SourceFile {
    const sf = this.ls.getProgram()?.getSourceFile(resolve(this.root, file));
    if (!sf) throw new Error(`${file} is not part of the TypeScript program (tsconfig include)`);
    return sf;
  }
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

/**
 * A legal identifier that is not reserved. Modules are strict, so the strict-mode future reserved
 * words (let, static, implements, …) and `await` are refused too. Contextual keywords such as
 * `type`, `of` or `async` remain legal names and are allowed.
 */
export function isUsableName(name: string): boolean {
  if (!ts.isIdentifierText(name, ts.ScriptTarget.Latest)) return false;
  const token = ts.stringToToken(name);
  if (token === undefined) return true;
  const within = (lo: ts.SyntaxKind, hi: ts.SyntaxKind) => token >= lo && token <= hi;
  return !(
    within(ts.SyntaxKind.FirstReservedWord, ts.SyntaxKind.LastReservedWord) ||
    within(ts.SyntaxKind.FirstFutureReservedWord, ts.SyntaxKind.LastFutureReservedWord) ||
    token === ts.SyntaxKind.AwaitKeyword
  );
}

function svelteFilesMentioning(root: string, name: string): string[] {
  try {
    return execFileSync('git', ['grep', '-lw', name, '--', '*.svelte'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
}

function nodeAt(sf: ts.SourceFile, pos: number): ts.Node {
  let found: ts.Node = sf;
  const visit = (n: ts.Node) => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * References where `newName` would resolve to something else: another declaration of that name is
 * in scope there. Lib globals do not count — a module-level declaration shadows them, which is the
 * intended outcome of the rename.
 */
export function shadowingConflicts(session: RenameSession, target: ts.Symbol, refs: readonly ts.RenameLocation[], newName: string): string[] {
  const program = session.ls.getProgram();
  const checker = program?.getTypeChecker();
  if (!program || !checker) return ['no program'];
  const conflicts: string[] = [];
  for (const ref of refs) {
    const sf = program.getSourceFile(ref.fileName);
    if (!sf) continue;
    const node = nodeAt(sf, ref.textSpan.start);
    const visible = checker.getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias);
    for (const s of visible) {
      if (s.name !== newName || s === target) continue;
      const decl = s.declarations?.[0];
      if (!decl || program.isSourceFileDefaultLibrary(decl.getSourceFile()) || decl.getSourceFile().fileName.includes('node_modules')) continue;
      const { line } = sf.getLineAndCharacterOfPosition(ref.textSpan.start);
      conflicts.push(`${relative(session.root, ref.fileName)}:${line + 1} would see ${relative(session.root, decl.getSourceFile().fileName)}:${decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1}`);
    }
  }
  return [...new Set(conflicts)];
}

export function planRename(session: RenameSession, file: string, name: string, newName: string): Edit[] {
  if (!isUsableName(newName)) throw new Error(`${newName} is not a usable identifier (keyword or illegal)`);
  const abs = resolve(session.root, file);
  const sf = session.sourceFile(file);
  const decls = topLevelDeclarations(sf, name);
  if (decls.length !== 1) throw new Error(`expected exactly one top-level declaration of ${name} in ${file}, found ${decls.length}`);
  if (topLevelDeclarations(sf, newName).length) throw new Error(`${newName} is already declared in ${file}`);
  if (isExported(decls[0])) {
    const unresolved = session.unresolvedImports();
    if (unresolved.length) throw new Error(`${name} is exported and ${unresolved.length} import(s) in the program do not resolve, so some importers may be invisible: ${unresolved.slice(0, 2).join('; ')}`);
    const svelte = svelteFilesMentioning(session.root, name);
    if (svelte.length) throw new Error(`${name} is exported and named in ${svelte.length} .svelte file(s) (${svelte.slice(0, 3).join(', ')}) which the language service cannot see — refusing until svelte2tsx support lands`);
  }
  const locations = session.ls.findRenameLocations(abs, decls[0].getStart(sf), false, false, { providePrefixAndSuffixTextForRename: true });
  if (!locations?.length) throw new Error(`the language service found no rename locations for ${name}`);
  const target = session.ls.getProgram()?.getTypeChecker().getSymbolAtLocation(decls[0]);
  if (!target) throw new Error(`no symbol for ${name}`);
  const conflicts = shadowingConflicts(session, target, locations, newName);
  if (conflicts.length) throw new Error(`renaming to ${newName} would be shadowed at ${conflicts.length} reference(s): ${conflicts.slice(0, 3).join('; ')}`);
  return locations.map((l) => ({
    file: relative(session.root, l.fileName),
    start: l.textSpan.start,
    end: l.textSpan.start + l.textSpan.length,
    text: `${l.prefixText ?? ''}${newName}${l.suffixText ?? ''}`,
  }));
}

/** `interface X<T> { … }` → `type X<T> = { … };`, refusing where the two are not equivalent. */
export function planInterfaceToType(file: string, name: string, text: string): Edit[] {
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
export function applyEdits(edits: Edit[], read: (f: string) => string, write: (f: string, t: string) => void): string[] {
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, list] of byFile) {
    let text = read(file);
    for (const e of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    write(file, text);
  }
  return [...byFile.keys()];
}

/** Batch 1 targets: non-exported module-level `let _x` in src/, outside tests. */
export function underscoreModuleState(session: RenameSession, files: string[]): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const file of files) {
    const text = session.read(file);
    if (text === undefined) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st) || isExported(st)) continue;
      if (!(st.declarationList.flags & ts.NodeFlags.Let)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && /^_[a-zA-Z]/.test(d.name.text)) out.push({ file, name: d.name.text });
      }
    }
  }
  return out;
}

/** Split a name into case segments: kbStableId → kb, Stable, Id; CURRENT_KB → CURRENT, KB. */
export function nameSegments(name: string): string[] {
  return name.split('_').flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []);
}

export type TermMapping = { kind: 'rename'; to: string } | { kind: 'ambiguous' } | { kind: 'none' };

/**
 * Map a name whose whole segment is `kb` to the knowledgeBase spelling, preserving its case style.
 * Pure, so it is tested without a program. Mixed shapes it cannot map with certainty (lower_snake,
 * `KBs`, `KBId` runs) are AMBIGUOUS rather than guessed.
 */
export function mapKbName(name: string): TermMapping {
  if (!/kb/i.test(name)) return { kind: 'none' };
  const ambiguous: TermMapping = { kind: 'ambiguous' };
  const body = name.replace(/^_+/, '');
  const lead = name.slice(0, name.length - body.length);
  const upperSnake = !/[a-z]/.test(body);
  if (upperSnake) {
    const parts = body.split('_');
    if (!parts.some((p) => p === 'KB' || p === 'KBS')) return ambiguous;
    return { kind: 'rename', to: lead + parts.map((p) => (p === 'KB' ? 'KNOWLEDGE_BASE' : p === 'KBS' ? 'KNOWLEDGE_BASES' : p)).join('_') };
  }
  if (body.includes('_')) return ambiguous; // lower_snake or mixed: no certain target spelling
  const segs = nameSegments(body);
  if (segs.join('') !== body) return ambiguous; // digits or odd characters the splitter dropped
  if (!segs.some((s) => /^kbs?$/i.test(s))) return ambiguous;
  const out = segs.map((s, i) => {
    const low = s.toLowerCase();
    if (low !== 'kb' && low !== 'kbs') return s;
    const plural = low === 'kbs';
    if (i === 0 && s === low) return plural ? 'knowledgeBases' : 'knowledgeBase';
    if (s === 'KB' || s === 'Kb' || s === 'kb' || s === 'Kbs') return plural ? 'KnowledgeBases' : 'KnowledgeBase';
    return null;
  });
  if (out.includes(null)) return ambiguous;
  return { kind: 'rename', to: lead + out.join('') };
}

export type TermScan = { toRename: { file: string; name: string; to: string }[]; ambiguous: { file: string; name: string }[]; deferred: number };

/** Top-level declarations in `files` whose names carry the term; nested declarations are only counted. */
export function termCandidates(session: RenameSession, files: string[]): TermScan {
  const scan: TermScan = { toRename: [], ambiguous: [], deferred: 0 };
  for (const file of files) {
    const text = session.read(file);
    if (text === undefined) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const top = new Set<ts.Node>();
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => ts.isIdentifier(d.name) && top.add(d.name));
      else if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) top.add(st.name);
    }
    const visit = (n: ts.Node) => {
      const nameNode = (n as { name?: ts.Node }).name;
      const declares = ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) || ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n) || ts.isMethodSignature(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isEnumMember(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);
      if (declares && nameNode && ts.isIdentifier(nameNode) && /kb/i.test(nameNode.text)) {
        if (top.has(nameNode)) {
          const m = mapKbName(nameNode.text);
          if (m.kind === 'rename') scan.toRename.push({ file, name: nameNode.text, to: m.to });
          else if (m.kind === 'ambiguous') scan.ambiguous.push({ file, name: nameNode.text });
        } else scan.deferred++;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return scan;
}

/** Files under src/ in which `name` appears as a quoted string: a possible stored key or serialized field. */
export function quotedAsString(root: string, name: string, run: typeof execFileSync = execFileSync): string[] {
  try {
    return (run('git', ['grep', '-lF', '-e', `'${name}'`, '-e', `"${name}"`, '-e', `\`${name}\``, '--', 'src'], { cwd: root, encoding: 'utf8' }) as string).split('\n').filter(Boolean);
  } catch (e) {
    // Exit status 1 is git grep's "no match". Anything else (other status, spawn failure) is a failed
    // lookup, and a failed lookup must REFUSE the rename: the guard fails closed, never open.
    if ((e as { status?: number }).status === 1) return [];
    throw new Error(`STORED-NAME GUARD: lookup of ${name} failed (${(e as Error).message.split('\n')[0]}) — refusing rather than guessing`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const dry = argv.includes('--dry-run');
  const session = new RenameSession();
  const apply = (edits: Edit[]) => (dry ? [...new Set(edits.map((e) => e.file))] : applyEdits(edits, (f) => session.read(f) ?? '', (f, t) => session.write(f, t)));
  try {
    const rename = flag('rename');
    const toType = flag('interface-to-type');
    const batch = flag('batch');
    if (rename) {
      const [file, name, newName] = rename.split(':');
      if (!file || !name || !newName) throw new Error('--rename=<file>:<Name>:<NewName>');
      const edits = planRename(session, file, name, newName);
      console.log(`${edits.length} edit(s) in ${apply(edits).join(', ')}${dry ? ' (dry run, nothing written)' : ''}`);
    } else if (toType) {
      const [file, name] = toType.split(':');
      if (!file || !name) throw new Error('--interface-to-type=<file>:<Name>');
      const edits = planInterfaceToType(file, name, session.read(file) ?? '');
      console.log(`${edits.length} edit(s) in ${apply(edits).join(', ')}${dry ? ' (dry run, nothing written)' : ''}`);
    } else if (batch === 'underscore-module-state') {
      const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter((f) => /\.ts$/.test(f) && !/__tests__|\.test\.ts$|\.spec\.ts$/.test(f));
      const targets = underscoreModuleState(session, files);
      let done = 0;
      const refused: string[] = [];
      for (const t of targets) {
        try {
          const edits = planRename(session, t.file, t.name, t.name.slice(1));
          // In a dry run nothing is written, so later plans in the same file still see the originals.
          apply(edits);
          done++;
        } catch (e) {
          refused.push(`${t.file} ${t.name}: ${(e as Error).message}`);
        }
      }
      console.log(`batch underscore-module-state: ${targets.length} targets · ${done} renamed · ${refused.length} refused${dry ? ' (dry run, nothing written)' : ''}`);
      for (const r of refused) console.log(`  REFUSED ${r}`);
    } else if (batch === 'term') {
      if (flag('term') !== 'kb') throw new Error('--batch=term supports --term=kb only');
      const dirs = (flag('dir') ?? '').split(',').filter(Boolean).map((d) => d.replace(/\/$/, ''));
      if (!dirs.length) throw new Error('--batch=term needs --dir=<path>[,<path>…]');
      const all = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.ts$/.test(f));
      const rows: string[] = [];
      const details: string[] = [];
      let sumWould = 0;
      for (const dir of dirs) {
        const scan = termCandidates(session, all.filter((f) => f.startsWith(`${dir}/`)));
        let done = 0;
        const refused: string[] = [];
        for (const t of scan.toRename) {
          try {
            const quoted = quotedAsString(ROOT, t.name);
            if (quoted.length) throw new Error(`STORED-NAME GUARD: ${t.name} also appears as a quoted string (${quoted.slice(0, 2).join(', ')}) — possible persisted key`);
            apply(planRename(session, t.file, t.name, t.to));
            done++;
          } catch (e) {
            refused.push(`${t.file} ${t.name} -> ${t.to}: ${(e as Error).message}`);
          }
        }
        sumWould += done;
        rows.push(`| ${dir} | ${scan.toRename.length + scan.ambiguous.length} | ${done} | ${refused.length} | ${scan.ambiguous.length} | ${scan.deferred} |`);
        for (const r of refused) details.push(`  REFUSED ${r}`);
        for (const a of scan.ambiguous) details.push(`  AMBIGUOUS ${a.file} ${a.name}`);
      }
      console.log(`batch term=kb ${dry ? '(dry run, nothing written)' : '(applied)'}`);
      console.log('| dir | candidates | would-rename | refused | ambiguous | deferred (non-top-level) |\n|---|---|---|---|---|---|');
      for (const r of rows) console.log(r);
      console.log(`total ${dry ? 'would-rename' : 'renamed'}: ${sumWould}`);
      for (const d of details) console.log(d);
    } else {
      throw new Error('Usage: --rename=<file>:<Name>:<NewName> | --interface-to-type=<file>:<Name> | --batch=underscore-module-state | --batch=term --term=kb --dir=<path> [--dry-run]');
    }
  } catch (e) {
    console.error(`rename-identifier: REFUSED — ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('rename-identifier.ts')) main();
