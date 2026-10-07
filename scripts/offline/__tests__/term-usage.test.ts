/**
 * Term usage measurement (F203).
 *
 * These pin the parts that make the report trustworthy rather than merely plausible. The first
 * run of this job claimed 6030 uses of the term `class` and 3748 of them user-facing; almost all
 * were the HTML `class` attribute, which is not our concept at all. A measurement that counts
 * syntax as terminology does not slightly overstate the rename cost, it inverts the ranking, and
 * the ranking is the only thing anyone acts on.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyUsage,
  readTermRatchets,
  checkTermRatchets,
  ratchetFails,
  segmentsOf,
  singular,
  bindingOfLine,
  registerOfLine,
  insideTag,
  isKeywordUse,
  readTerms,
  scanText,
  type TokenUsage,
} from '../term-usage.js';

function usage(token: string): Map<string, TokenUsage> {
  // Built by the production factory on purpose — a second copy of this shape is
  // what let the register split pass its own tests while returning NaN.
  return new Map([[token, emptyUsage(token)]]);
}

describe('segmentsOf', () => {
  it('splits the identifier shapes a rename would actually have to touch', () => {
    expect(segmentsOf('nodeMap')).toEqual(['node', 'map']);
    expect(segmentsOf('MAX_NODES')).toEqual(['max', 'nodes']);
    expect(segmentsOf('KnowledgeGraph2D')).toEqual(['knowledge', 'graph2', 'd']);
    expect(segmentsOf('nodePositionCache')).toEqual(['node', 'position', 'cache']);
  });

  it('splits on punctuation, so a proper noun does not become a fragment', () => {
    // "Node.js" once segmented to ["node.js"], which singularized to the token "node.j" and
    // matched nothing — a term silently measuring zero is worse than a term measuring wrong.
    expect(segmentsOf('Node.js')).toEqual(['node', 'js']);
  });
});

describe('singular', () => {
  it('folds a plural onto its term', () => {
    expect(singular('nodes')).toBe('node');
    expect(singular('entities')).toBe('entity');
  });

  it('leaves words that merely end in s alone', () => {
    expect(singular('status')).toBe('status');
    expect(singular('class')).toBe('class');
  });
});

describe('bindingOfLine', () => {
  it('calls a serialized name contract', () => {
    expect(bindingOfLine("const iri = `urn:kbase:source/${id}`;").binding).toBe('contract');
    expect(bindingOfLine("db.version(2).stores({ notes: 'id' });").binding).toBe('contract');
    expect(bindingOfLine("localStorage.setItem('reckons.kb', id);").binding).toBe('contract');
  });

  it('calls somebody else s API foreign', () => {
    expect(bindingOfLine("import { Parser } from 'n3';").binding).toBe('foreign');
    expect(bindingOfLine('mesh.material.side = THREE.DoubleSide;').binding).toBe('foreign');
  });

  it('calls everything else free', () => {
    expect(bindingOfLine('const nodeMap = new Map();').binding).toBe('free');
  });

  it('prefers contract over foreign, because the expensive mistake is the migration', () => {
    expect(bindingOfLine("parser.parse(`@prefix sh: <...>`)").binding).toBe('contract');
  });
});

describe('registerOfLine and insideTag', () => {
  it('reads a markup attribute as code and the text beside it as copy', () => {
    const line = '<button class="graph-toggle">Graph</button>';
    expect(insideTag(line, line.indexOf('class'))).toBe(true);
    expect(insideTag(line, line.indexOf('>Graph') + 1)).toBe(false);
  });

  it('treats a bound UI string as user register', () => {
    expect(registerOfLine("  title: 'Your graph',", 'src/lib/x.ts')).toBe('user');
  });

  it('treats generated markdown pages as user register', () => {
    expect(registerOfLine('A graph holds your facts.', 'content/docs/welcome.md')).toBe('user');
  });
});

describe('isKeywordUse', () => {
  it('discards syntax that happens to spell one of our terms', () => {
    const attr = '<div class="node-label">';
    expect(isKeywordUse('class', attr, attr.indexOf('class'))).toBe(true);
    const decl = 'export type Term = NamedNode | BlankNode;';
    expect(isKeywordUse('type', decl, decl.indexOf('type'))).toBe(true);
    const builtin = 'const seen = new Set<string>();';
    expect(isKeywordUse('set', builtin, builtin.indexOf('Set'))).toBe(true);
  });

  it('keeps the occurrences that really are our terms', () => {
    const ours = 'const entityType = statement.type;';
    expect(isKeywordUse('type', ours, ours.indexOf('Type'))).toBe(false);
    const set = 'const set = readSets(quads)[0];';
    expect(isKeywordUse('set', set, set.indexOf('set'))).toBe(false);
  });
});

describe('readTerms', () => {
  const ttl = `
    @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
    @prefix kpred: <urn:kbase:predicate/> .
    @prefix kbind: <urn:kbase:type/binding/> .
    @prefix kterm: <urn:kbase:term/> .
    kterm:graph-vertex a skos:Concept ;
      skos:prefLabel "entity" ;
      kpred:user-label "thing" ;
      kpred:binding-class kbind:free ;
      skos:hiddenLabel "node", "vertex" .
    kterm:knowledge-base a skos:Concept ;
      skos:prefLabel "knowledge base" ;
      kpred:user-label "UNDECIDED — see scope note" ;
      kpred:binding-class kbind:contract ;
      skos:hiddenLabel "kb", "kbase" .
  `;

  it('reads the binding class and the words people actually type', () => {
    const terms = readTerms(ttl);
    expect(terms.map((t) => t.id)).toEqual(['graph-vertex', 'knowledge-base']);
    const vertex = terms[0];
    expect(vertex.binding).toBe('free');
    expect(vertex.tokens.sort()).toEqual(['entity', 'node', 'vertex']);
  });

  it('does not invent a token from a multi-word preferred label', () => {
    const kb = readTerms(ttl)[1];
    expect(kb.binding).toBe('contract');
    expect(kb.tokens.sort()).toEqual(['kb', 'kbase']);
  });
});

describe('scanText', () => {
  it('counts identifier segments, not whole words', () => {
    const tokens = usage('node');
    scanText('const nodeMap = new Map();\nconst MAX_NODES = 10;\n', 'src/lib/3d/x.ts', tokens);
    expect(tokens.get('node')!.occurrences).toBe(2);
  });

  it('separates markup copy from markup attributes', () => {
    const tokens = usage('graph');
    scanText('<button class="graph-toggle">Graph</button>\n', 'src/lib/components/X.svelte', tokens);
    const u = tokens.get('graph')!;
    expect(u.occurrences).toBe(2);
    expect(u.register.user).toBe(1);
    // The attribute half is FRONT-END, not undivided developer: a class on a
    // Svelte element is rendering code. Splitting the developer register is what
    // lets this line say which half of the codebase reached for the word.
    expect(u.register.frontend).toBe(1);
    expect(u.register.developer).toBe(0);
  });

  it('splits the developer register by which half of the codebase a line belongs to', () => {
    // NOT a THREE.* line: three.js is foreign, so that would classify as
    // 'standards' and prove nothing about the split.
    const fe = usage('node');
    // A rune store, not a .svelte file: markup lines route to the USER register
    // before the developer split is ever consulted.
    scanText('let nodeHovered = $state(false);\n', 'src/lib/stores/x.svelte.ts', fe);
    expect(fe.get('node')!.register.frontend).toBe(1);

    const be = usage('node');
    // Not `namedNode(...)`: that carries a SECOND `node` segment, and the point
    // here is the register, not the counting.
    scanText('const node = parser.parse(turtle);\n', 'src/lib/rdf/types.ts', be);
    expect(be.get('node')!.register.backend).toBe(1);

    // Neither half — counted as unclassified rather than guessed into one, because
    // the register counts are read as evidence about a rename.
    const neither = usage('node');
    scanText('export const node = 1;\n', 'src/lib/util.ts', neither);
    expect(neither.get('node')!.register.developer).toBe(1);
  });

  it('does not read a script block as copy', () => {
    const tokens = usage('graph');
    scanText('<script lang="ts">\n  const graph = load();\n</script>\n', 'src/lib/components/X.svelte', tokens);
    expect(tokens.get('graph')!.register.user).toBe(0);
  });

  it('counts an exclusion rather than dropping it silently', () => {
    const tokens = usage('class');
    scanText('<div class="node">x</div>\n', 'src/lib/components/X.svelte', tokens);
    expect(tokens.get('class')!.occurrences).toBe(0);
    expect(tokens.get('class')!.excluded).toBe(1);
  });
});

describe('ambiguity ratchet (Matt, 2026-10-07)', () => {
  const meaning = (id: string) => ({ iri: `urn:kbase:term/${id}`, id, prefLabel: id, binding: 'free' as const, tokens: [] });
  const usage = (token: string, free: number, meanings = 2) => {
    const u = emptyUsage(token, Array.from({ length: meanings }, (_, i) => meaning(`${token}-${i}`)));
    u.binding.free = free;
    return u;
  };

  it('reads kpred:term-ratchet baselines and skips malformed ones', () => {
    const ttl = '<s> kpred:term-ratchet "node/free/10" ; kpred:term-ratchet "graph/nope/3" ; kpred:term-ratchet "x/free/1.5" .';
    expect(readTermRatchets(ttl)).toEqual([{ token: 'node', binding: 'free', max: 10 }]);
  });

  it('fails only when an ambiguous word gains bare uses or has no baseline', () => {
    const rows = checkTermRatchets(
      [usage('node', 11), usage('graph', 5), usage('export', 3), usage('share', 9), usage('class', 99, 1)],
      [{ token: 'node', binding: 'free', max: 10 }, { token: 'graph', binding: 'free', max: 6 },
        { token: 'export', binding: 'free', max: 3 }, { token: 'gone', binding: 'free', max: 4 }],
    );
    expect(rows.map((r) => `${r.kind}:${r.token}`)).toEqual(['over:node', 'under:graph', 'at:export', 'unbaselined:share', 'stale:gone']);
    expect(ratchetFails(rows)).toBe(true);
    // A single-meaning word is never ratcheted, however common.
    expect(rows.some((r) => r.token === 'class')).toBe(false);
  });

  it('passes when every ambiguous word is at or below its baseline', () => {
    const rows = checkTermRatchets([usage('node', 9)], [{ token: 'node', binding: 'free', max: 10 }]);
    expect(ratchetFails(rows)).toBe(false);
  });
});

describe('the export keyword is syntax, the export feature is a term', () => {
  it('excludes the module keyword at the occurrence and keeps identifiers on the same line', () => {
    const line = 'export function exportTurtle(statements: Statement[]) {';
    expect(isKeywordUse('export', line, 0)).toBe(true);
    expect(isKeywordUse('export', line, line.indexOf('exportTurtle'))).toBe(false);
    expect(isKeywordUse('export', "export { default } from './separator.svelte';", 0)).toBe(true);
    expect(isKeywordUse('export', '  export default meta;', 2)).toBe(true);
    // Not the keyword: the feature, a property, a string.
    expect(isKeywordUse('export', 'const exported = await exportSpace(id);', 6)).toBe(false);
    expect(isKeywordUse('export', 'settings.export = true;', 9)).toBe(false);
    expect(isKeywordUse('export', "label: 'export this space'", 8)).toBe(false);
  });
});
