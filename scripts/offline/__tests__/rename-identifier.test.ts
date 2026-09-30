/**
 * The rename harness (F203.4). The rename plan trusts this script to change code across hundreds of
 * files with no model in the loop, so what it REFUSES is tested as carefully as what it does.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { applyEdits, planInterfaceToType, topLevelDeclarations, type Edit } from '../rename-identifier';

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

  it('refuses a name that is not an interface in the file', () => {
    expect(() => planInterfaceToType('x.ts', 'Nope', 'type Nope = {}')).toThrow(/found 0/);
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

  it('handles a shorthand-property expansion wider than the span it replaces', () => {
    const files: Record<string, string> = { 'a.ts': 'const x = { foo };' };
    applyEdits([{ file: 'a.ts', start: 12, end: 15, text: 'foo: FOO' }], (f) => files[f], (f, t) => (files[f] = t));
    expect(files['a.ts']).toBe('const x = { foo: FOO };');
  });
});

describe('topLevelDeclarations — only module scope, so a local of the same name is never the target', () => {
  const sf = ts.createSourceFile('x.ts', 'const foo = 1;\nfunction f() { const foo = 2; }\nexport interface Foo {}\n', ts.ScriptTarget.Latest, true);
  it('finds the module-level const and not the local one', () => {
    expect(topLevelDeclarations(sf, 'foo')).toHaveLength(1);
  });
  it('finds interfaces by name', () => {
    expect(topLevelDeclarations(sf, 'Foo')).toHaveLength(1);
  });
});
