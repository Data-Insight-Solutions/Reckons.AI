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
  return new Map([
    [
      token,
      {
        token,
        meanings: [],
        occurrences: 0,
        excluded: 0,
        files: new Set<string>(),
        binding: { free: 0, contract: 0, foreign: 0 },
        register: { standards: 0, developer: 0, user: 0 },
        byFile: new Map<string, number>(),
        bindingWhy: new Map<string, number>(),
      },
    ],
  ]);
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
    expect(u.register.developer).toBe(1);
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
