/**
 * Naming-convention measurement (F204).
 *
 * The regexes here decide which upstream project is recorded as disagreeing with us, so a loose
 * one does not produce a slightly wrong number — it manufactures a conflict and then a decision
 * gets taken to resolve it. Two of these tests exist because exactly that happened on the first
 * run: `const saveBtn = document.getElementById(...)` was counted as a camelCase CONSTANT, making
 * it look as though SvelteKit and Threlte reject UPPER_SNAKE (they do not), and module-scope
 * `let _autoSaveTimer` was counted as a private CLASS member in a codebase with 16 classes.
 */
import { describe, it, expect } from 'vitest';
import { countLines, verdictsFrom, readRatchets, METRICS, SOURCES } from '../naming-conventions.js';

const of = (src: string) => countLines(src.split('\n'));

describe('constant casing', () => {
  it('counts a literal constant', () => {
    const c = of("export const MAX_NODES = 500;\nconst LABEL_THROTTLE_MS = 120;\n");
    expect(c.constant.UPPER_SNAKE).toBe(2);
  });

  it('does not count a module-scope singleton as a constant', () => {
    // The distinction the first version missed. Every one of these codebases cases these camelCase.
    const c = of("const saveBtn = document.getElementById('btn-save')!;\nconst parser = new Parser();\n");
    expect(c.constant.camelCase).toBe(0);
  });

  it('counts three.js-style PascalCase API constants separately', () => {
    const c = of("export const DoubleSide = 2;\nexport const FrontSide = 0;\n");
    expect(c.constant.PascalCase).toBe(2);
    expect(c.constant.UPPER_SNAKE).toBe(0);
  });
});

describe('private class members', () => {
  it('only counts inside a file that declares a class', () => {
    const inClass = of('export class Loader {\n  #cache = new Map();\n  _legacy = 1;\n}\n');
    expect(inClass.private['#private']).toBe(1);
    expect(inClass.private._underscore).toBe(1);

    const noClass = of('let _autoSaveTimer = null;\nconst meta = { _format: "x", _version: 1 };\n');
    expect(noClass.private._underscore).toBe(0);
  });
});

describe('module-scope mutable state', () => {
  it('separates prefixed from unmarked, which is a different question from privacy', () => {
    const c = of('let _labelLast = 0;\nlet nodeLabels = [];\n');
    expect(c['module-state']._underscore).toBe(1);
    expect(c['module-state'].unmarked).toBe(1);
  });
});

describe('declaration kind', () => {
  it('counts both forms of an exported shape', () => {
    const c = of('export interface Props { a: string }\nexport type Term = NamedNode | Literal;\n');
    expect(c.declaration.interface).toBe(1);
    expect(c.declaration.type).toBe(1);
  });

  it('ignores a type-only import, which votes for nothing', () => {
    const c = of("import type { Quad } from 'n3';\n");
    expect(c.declaration.type).toBe(0);
  });
});

describe('verdictsFrom', () => {
  it('reports NO EVIDENCE rather than a winner when a source barely speaks', () => {
    // three.js is authored in JavaScript: it has no opinion on interface-versus-type and must not
    // be recorded as holding one. Silence and zero are different facts.
    const counts = { ...of('export interface A { x: 1 }\n') };
    expect(verdictsFrom(counts).declaration).toBeNull();
  });

  it('reports a winner with its share once a source has said enough', () => {
    const counts = of(Array.from({ length: 8 }, (_, i) => `export type T${i} = string;`).join('\n'));
    const v = verdictsFrom(counts).declaration;
    expect(v).not.toBeNull();
    expect(v!.option).toBe('type');
    expect(v!.total).toBe(8);
  });
});

describe('precedence', () => {
  it('ranks the framework we build on above an upstream library', () => {
    const rank = Object.fromEntries(SOURCES.map((s) => [s.id, s.rank]));
    expect(rank.sveltekit).toBeLessThan(rank.threlte);
    expect(rank.threlte).toBeLessThan(rank.three);
  });

  it('asks every question as a set of competing answers, never a single assertion', () => {
    for (const m of METRICS) expect(m.options.length).toBeGreaterThan(1);
  });
});

describe('the extension-point exemption', () => {
  it('does not count an interface a comment marks as deliberate', () => {
    const above = of('// extension point: plugins augment this\nexport interface PluginApi { run(): void }\n');
    expect(above.declaration.interface).toBe(0);
    expect(above._exempt.interface).toBe(1);

    const inline = of('export interface App { } // extension point\n');
    expect(inline.declaration.interface).toBe(0);
  });

  it('counts an ordinary interface, so the ratchet still sees the debt', () => {
    const c = of('export interface Props { a: string }\n');
    expect(c.declaration.interface).toBe(1);
    expect(c._exempt.interface ?? 0).toBe(0);
  });

  it('keeps an exempt declaration out of the verdict, so it cannot vote', () => {
    // An exemption says "this one is deliberate", not "this codebase prefers interface".
    const lines = Array.from({ length: 9 }, () => '// extension point\nexport interface A { }').join('\n');
    expect(verdictsFrom(of(lines)).declaration).toBeNull();
  });
});

describe('readRatchets', () => {
  it('reads a baseline from the standards graph', () => {
    const ttl = 'kstd:declaration-kind kpred:ratchet "declaration/interface/282" ;\n  kpred:ratchet "constant/camelCase/77" .';
    expect(readRatchets(ttl)).toEqual([
      { metric: 'declaration', option: 'interface', max: 282 },
      { metric: 'constant', option: 'camelCase', max: 77 },
    ]);
  });

  it('ignores a malformed baseline rather than tolerating an infinite one', () => {
    // A baseline that parses to NaN would compare false against every count and silently
    // never fail — an enforcement that reports success is worse than one that reports nothing.
    expect(readRatchets('kpred:ratchet "declaration/interface/lots"')).toEqual([]);
    expect(readRatchets('kpred:ratchet "nope"')).toEqual([]);
  });
});
