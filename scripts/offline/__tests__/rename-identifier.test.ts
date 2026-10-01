/**
 * The rename harness (F203.4). The rename plan trusts this script to change code across hundreds of
 * files with no model in the loop, so what it REFUSES is tested as carefully as what it does — above
 * all shadowing, which compiles cleanly and changes behaviour.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { mapKbName, nameSegments, termCandidates, applyEdits, isUsableName, planInterfaceToType, planRename, RenameSession, topLevelDeclarations, underscoreModuleState, type Edit } from '../rename-identifier';

const ROOT = '/virtual-project';
const session = (files: Record<string, string>) => new RenameSession({ root: ROOT, memory: files });
const renameIn = (files: Record<string, string>, file: string, name: string, to: string) => {
  const s = session(files);
  applyEdits(planRename(s, file, name, to), (f) => s.read(f) ?? '', (f, t) => s.write(f, t));
  return (f: string) => s.read(f);
};

describe('planRename — every reference, through imports', () => {
  it('renames a module constant and its uses across files', () => {
    const read = renameIn({
      'a.ts': 'export const maxItems = 3;\nexport const twice = maxItems * 2;\n',
      'b.ts': "import { maxItems } from './a';\nexport const n = maxItems + 1;\n",
    }, 'a.ts', 'maxItems', 'MAX_ITEMS');
    expect(read('a.ts')).toBe('export const MAX_ITEMS = 3;\nexport const twice = MAX_ITEMS * 2;\n');
    expect(read('b.ts')).toBe("import { MAX_ITEMS } from './a';\nexport const n = MAX_ITEMS + 1;\n");
  });

  it('expands a shorthand property instead of changing the object\'s key', () => {
    const read = renameIn({ 'a.ts': 'let _count = 0;\nexport const snapshot = () => ({ _count });\n' }, 'a.ts', '_count', 'count');
    expect(read('a.ts')).toContain('({ _count: count })');
  });

  it('leaves the same word inside a string alone', () => {
    const read = renameIn({ 'a.ts': "const profile = { a: 1 };\nexport const msg = 'bad profile';\nexport const p = profile;\n" }, 'a.ts', 'profile', 'PROFILE');
    expect(read('a.ts')).toBe("const PROFILE = { a: 1 };\nexport const msg = 'bad profile';\nexport const p = PROFILE;\n");
  });
});

describe('planRename — refusals', () => {
  it('REFUSES when a parameter of the new name would capture a reference (the silent self-assignment)', () => {
    const s = session({ 'a.ts': 'let _loaded = false;\nexport function set(loaded: boolean) { _loaded = loaded; }\nexport const get = () => _loaded;\n' });
    expect(() => planRename(s, 'a.ts', '_loaded', 'loaded')).toThrow(/shadowed at 1 reference/);
  });

  it('REFUSES when a local variable of the new name is in scope at a reference', () => {
    const s = session({ 'a.ts': 'let _t = 1;\nexport function f() { const t = 2; return _t + t; }\n' });
    expect(() => planRename(s, 'a.ts', '_t', 't')).toThrow(/shadowed/);
  });

  it('allows the rename when the same name exists only in an unrelated scope', () => {
    const read = renameIn({ 'a.ts': 'let _t = 1;\nexport function f() { return _t; }\nexport function g() { const t = 2; return t; }\n' }, 'a.ts', '_t', 't');
    expect(read('a.ts')).toContain('let t = 1;\nexport function f() { return t; }');
  });

  it('allows shadowing a lib global, which is the point of a module-level name', () => {
    const read = renameIn({ 'a.ts': 'let _escape = 1;\nexport const e = () => _escape;\n' }, 'a.ts', '_escape', 'escape');
    expect(read('a.ts')).toContain('let escape = 1;');
  });

  it('REFUSES a keyword as the new name', () => {
    const s = session({ 'a.ts': 'let _default = 1;\nexport const d = _default;\n' });
    expect(() => planRename(s, 'a.ts', '_default', 'default')).toThrow(/not a usable identifier/);
  });

  it('REFUSES a new name already declared at the top level', () => {
    const s = session({ 'a.ts': 'let _x = 1;\nconst x = 2;\nexport const y = _x + x;\n' });
    expect(() => planRename(s, 'a.ts', '_x', 'x')).toThrow(/already declared/);
  });
});

describe('planRename — an importer the program cannot see stops the rename', () => {
  it('REFUSES an exported rename while any import fails to resolve', () => {
    const s = session({ 'a.ts': 'export const maxItems = 3;\n', 'b.ts': "import { maxItems } from './a';\nimport { gone } from './missing';\nexport const n = maxItems + gone;\n" });
    expect(() => planRename(s, 'a.ts', 'maxItems', 'MAX_ITEMS')).toThrow(/do not resolve/);
  });
});

describe('isUsableName', () => {
  it('rejects reserved and strict-mode reserved words, allows contextual keywords', () => {
    for (const bad of ['default', 'class', 'new', 'let', 'static', 'implements', 'await', '1x']) expect(isUsableName(bad), bad).toBe(false);
    for (const ok of ['type', 'of', 'async', 'loaded', 'status']) expect(isUsableName(ok), ok).toBe(true);
  });
});

describe('underscoreModuleState — batch 1 targets', () => {
  it('finds module-level `let _x`, and not exports, consts, or locals', () => {
    const s = session({ 'a.ts': 'let _a = 1;\nexport let _b = 2;\nconst _c = 3;\nfunction f() { let _d = 4; return _d; }\nlet _e = $state(0), _g = 1;\n' });
    expect(underscoreModuleState(s, ['a.ts']).map((t) => t.name)).toEqual(['_a', '_e', '_g']);
  });
});

describe('planInterfaceToType', () => {
  const convert = (text: string, name: string) => {
    const [edit] = planInterfaceToType('x.ts', name, text);
    return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  };

  it('turns an exported interface into a type alias, keeping members and doc comments', () => {
    const src = `/** A thing. */\nexport interface Thing {\n  /** its id */\n  id: string;\n  n?: number;\n}\n`;
    expect(convert(src, 'Thing')).toBe(`/** A thing. */\nexport type Thing = {\n  /** its id */\n  id: string;\n  n?: number;\n};\n`);
  });

  it('keeps type parameters', () => {
    expect(convert('interface Box<T = string> { value: T }', 'Box')).toBe('type Box<T = string> = { value: T };');
  });

  it('refuses an interface that extends another — that needs an intersection, by hand', () => {
    expect(() => planInterfaceToType('x.ts', 'B', 'interface A { a: 1 }\ninterface B extends A { b: 2 }')).toThrow(/extends/);
  });

  it('refuses a merged interface — two declarations are one type only as interfaces', () => {
    expect(() => planInterfaceToType('x.ts', 'M', 'interface M { a: 1 }\ninterface M { b: 2 }')).toThrow(/merging/);
  });
});

describe('applyEdits', () => {
  it('applies several edits to one file back to front, so offsets stay valid', () => {
    const files: Record<string, string> = { 'a.ts': 'const foo = 1; use(foo); foo;' };
    const edits: Edit[] = [
      { file: 'a.ts', start: 6, end: 9, text: 'FOO' },
      { file: 'a.ts', start: 19, end: 22, text: 'FOO' },
      { file: 'a.ts', start: 25, end: 28, text: 'FOO' },
    ];
    applyEdits(edits, (f) => files[f], (f, t) => (files[f] = t));
    expect(files['a.ts']).toBe('const FOO = 1; use(FOO); FOO;');
  });
});

describe('topLevelDeclarations — only module scope', () => {
  const sf = ts.createSourceFile('x.ts', 'const foo = 1;\nfunction f() { const foo = 2; }\nexport interface Foo {}\nexport enum Color { Red }\n', ts.ScriptTarget.Latest, true);
  it('finds the module-level const and not the local one', () => expect(topLevelDeclarations(sf, 'foo')).toHaveLength(1));
  it('finds interfaces and enums (enums accepted from the local review, 2026-09-30)', () => {
    expect(topLevelDeclarations(sf, 'Foo')).toHaveLength(1);
    expect(topLevelDeclarations(sf, 'Color')).toHaveLength(1);
  });
});

describe('mapKbName — whole-segment kb → knowledgeBase, case style kept', () => {
  const to = (n: string) => { const m = mapKbName(n); return m.kind === 'rename' ? m.to : m.kind; };
  it('maps camel, Pascal, UPPER_SNAKE and plural forms', () => {
    expect(to('kbId')).toBe('knowledgeBaseId');
    expect(to('kb')).toBe('knowledgeBase');
    expect(to('kbs')).toBe('knowledgeBases');
    expect(to('KbEntry')).toBe('KnowledgeBaseEntry');
    expect(to('KBEntry')).toBe('KnowledgeBaseEntry');
    expect(to('currentKb')).toBe('currentKnowledgeBase');
    expect(to('listKbs')).toBe('listKnowledgeBases');
    expect(to('kbStableId')).toBe('knowledgeBaseStableId');
    expect(to('CURRENT_KB')).toBe('CURRENT_KNOWLEDGE_BASE');
    expect(to('KB_IDS')).toBe('KNOWLEDGE_BASE_IDS');
    expect(to('_kbCache')).toBe('_knowledgeBaseCache');
  });
  it('lists names that merely contain kb as ambiguous, and unrelated names as none', () => {
    expect(to('kbase')).toBe('ambiguous');
    expect(to('KBase')).toBe('ambiguous');
    expect(to('kb_id')).toBe('ambiguous');
    expect(to('stuff')).toBe('none');
  });
  it('segments names', () => { expect(nameSegments('kbStableId')).toEqual(['kb', 'Stable', 'Id']); });
});

describe('termCandidates', () => {
  it('renames top-level only, counts nested as deferred, lists kbase as ambiguous', () => {
    const s = session({ 'src/a.ts': 'export const kbId = 1;\nexport type KbEntry = { kbName: string };\nexport const kbase = 2;\nexport function f(kbArg: number) { return kbArg; }\n' });
    const r = termCandidates(s, ['src/a.ts']);
    expect(r.toRename.map((t) => `${t.name}>${t.to}`)).toEqual(['kbId>knowledgeBaseId', 'KbEntry>KnowledgeBaseEntry']);
    expect(r.ambiguous.map((a) => a.name)).toEqual(['kbase']);
    expect(r.deferred).toBe(2);
  });
});
