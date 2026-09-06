/**
 * The diagram pipeline's contract, which is mostly about DETERMINISM.
 *
 * `scripts/docs-pages.ts` must produce byte-identical markdown from identical TTL on every machine
 * — `scripts/md-align.ts` round-trips the committed content back through the graph and CI
 * regenerates and diffs. Mermaid is the one part of that pipeline that cannot honour it: layout
 * depends on the fonts installed on the box doing the rendering. So rendering was moved out of the
 * generator into a committed cache, and these tests pin the seams that make that split safe.
 *
 * Nothing here launches a browser. `renderDiagrams` is the only function that does, and it is
 * exercised by actually running `npm run docs:diagrams` — a unit test that starts Chromium would
 * make the suite slow and machine-dependent, which is the very thing being designed out.
 */
import { describe, it, expect } from 'vitest';
import { diagramKey, normalizeSvg, diagramFigure } from '../lib/mermaid-render';
import { collectDiagramSources, DIAGRAM_PREDICATE } from '../docs-diagrams';
import { writeFileSync, mkdtempSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolve } from 'path';

const STATIC_DIR = resolve(import.meta.dirname ?? '.', '..', '..', 'static');

describe('diagramKey', () => {
  it('is stable for the same source', () => {
    const src = 'flowchart LR\n  A --> B';
    expect(diagramKey(src)).toBe(diagramKey(src));
  });

  it('ignores surrounding whitespace, so reindenting a TTL block does not orphan the cache', () => {
    expect(diagramKey('flowchart LR\n  A --> B')).toBe(diagramKey('\n  flowchart LR\n  A --> B\n\n'));
  });

  it('changes when the diagram changes', () => {
    expect(diagramKey('flowchart LR\n  A --> B')).not.toBe(diagramKey('flowchart LR\n  A --> C'));
  });
});

describe('normalizeSvg', () => {
  // Mermaid mints ids from a global counter, so the same diagram rendered in a different order
  // within one browser session comes out with different ids. Left alone, that alone would make the
  // committed cache churn on every re-render.
  it('rewrites mermaid-minted ids to ones derived from the content hash', () => {
    const svg = '<svg id="mermaid-17"><g id="mermaid-17-node"/></svg>';
    const out = normalizeSvg(svg, 'abc123');
    expect(out).not.toContain('mermaid-17');
    expect(out).toContain('dabc123-');
  });

  it('rewrites a marker REFERENCE to match its definition — a half-rename loses the arrowheads', () => {
    // This is the failure that would look fine in a diff and wrong on the page: `url(#…)` pointing
    // at an id that no longer exists renders an edge with no arrowhead, silently.
    const svg = '<svg id="mermaid-1"><marker id="mermaid-1-arrow"/><path marker-end="url(#mermaid-1-arrow)"/></svg>';
    const out = normalizeSvg(svg, 'k9');
    const definedId = /marker id="([^"]+)"/.exec(out)?.[1];
    const referencedId = /marker-end="url\(#([^)]+)\)"/.exec(out)?.[1];
    expect(definedId).toBeTruthy();
    expect(referencedId).toBe(definedId);
  });

  it('is idempotent — normalising twice changes nothing the second time', () => {
    const svg = '<svg id="mermaid-3" style="max-width:120px" width="120" height="80"><g/></svg>';
    const once = normalizeSvg(svg, 'zz');
    expect(normalizeSvg(once, 'zz')).toBe(once);
  });

  it('drops the baked pixel width mermaid computed from its own headless viewport', () => {
    // A width baked from the render viewport both fights the docs stylesheet and varies with the
    // window size, which would be non-determinism smuggled in as layout.
    const out = normalizeSvg('<svg width="1024" height="300" style="max-width:1024px"><g/></svg>', 'q1');
    expect(out).not.toMatch(/width="1024"/);
    expect(out).not.toContain('max-width');
  });

  it('maps mermaid’s baked palette onto the site’s theme variables', () => {
    // A diagram carrying mermaid's purple is legible in whichever theme the author happened to use
    // and wrong in the other — a documentation bug only some readers ever see.
    const out = normalizeSvg('<svg><rect fill="#ECECFF" stroke="#9370DB"/><text fill="#333333"/></svg>', 'p');
    expect(out).toContain('var(--diagram-node-bg)');
    expect(out).toContain('var(--diagram-node-border)');
    expect(out).toContain('var(--diagram-line)');
    expect(out).not.toMatch(/#ECECFF/i);
  });
});

describe('diagramFigure', () => {
  it('carries the caption as an accessible label as well as visible text', () => {
    const out = diagramFigure('<svg/>', 'How a note becomes facts');
    expect(out).toContain('aria-label="How a note becomes facts"');
    expect(out).toContain('<figcaption>How a note becomes facts</figcaption>');
  });

  it('escapes a caption that would otherwise break out of the attribute', () => {
    const out = diagramFigure('<svg/>', 'A "quoted" <thing> & more');
    expect(out).toContain('&quot;quoted&quot;');
    expect(out).toContain('&lt;thing&gt;');
    expect(out).not.toMatch(/aria-label="[^"]*"[^>]*thing/);
  });

  it('omits the figcaption entirely when there is no caption', () => {
    expect(diagramFigure('<svg/>')).not.toContain('figcaption');
  });
});

describe('collectDiagramSources', () => {
  const ttl = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'diagram-src-'));
    const file = join(dir, 'g.ttl');
    writeFileSync(file, `@prefix kpred: <urn:kbase:predicate/> .\n${body}\n`, 'utf8');
    return file;
  };

  it('finds every diagram declared across the graphs', () => {
    const f = ttl(`<urn:a> kpred:diagram "flowchart LR\\n  A --> B" .
<urn:b> kpred:diagram "flowchart TB\\n  C --> D" .`);
    expect(collectDiagramSources([f])).toHaveLength(2);
  });

  it('deduplicates an identical diagram used on two pages — one render, one cache entry', () => {
    const f = ttl(`<urn:a> kpred:diagram "flowchart LR\\n  A --> B" .
<urn:b> kpred:diagram "flowchart LR\\n  A --> B" .`);
    expect(collectDiagramSources([f])).toHaveLength(1);
  });

  it('returns sources sorted, so the render order cannot vary between machines', () => {
    const f = ttl(`<urn:a> kpred:diagram "zebra" .
<urn:b> kpred:diagram "alpha" .`);
    expect(collectDiagramSources([f])).toEqual(['alpha', 'zebra']);
  });

  it('skips a TTL that does not parse rather than crashing the docs build', () => {
    // A broken graph is graph-lint's failure to report with a useful message; this script
    // crashing on it would just hide that behind a stack trace.
    const dir = mkdtempSync(join(tmpdir(), 'diagram-bad-'));
    const bad = join(dir, 'bad.ttl');
    writeFileSync(bad, 'this is not turtle at all <<<', 'utf8');
    expect(() => collectDiagramSources([bad])).not.toThrow();
    expect(collectDiagramSources([bad])).toEqual([]);
  });

  it('names the predicate the docs graphs actually use', () => {
    expect(DIAGRAM_PREDICATE).toBe('urn:kbase:predicate/diagram');
  });
});

describe('no HTML entity reaches a diagram label', () => {
  /**
   * A REAL BUG, CAUGHT BY EYE ON THE PUBLISHED PAGE (2026-09-06). The user-paths stage labels were
   * written `"1 &middot; Capture"`, and mermaid escapes the ampersand when it builds the SVG text
   * node — so the finished page rendered the literal string `1 &middot; Capture` to every reader.
   *
   * Nothing caught it: the TTL parses, the diagram renders, the cache hits, and all six align gates
   * pass, because an entity is perfectly valid text. Only a person looking at the picture could
   * see it, and that is exactly the kind of check worth demoting to a rule (F74.3). The fix is to
   * write the character itself — TTL is UTF-8 and mermaid draws it correctly.
   */
  const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;

  it('flags an entity in a diagram source', () => {
    expect(ENTITY.test('subgraph s1["1 &middot; Capture"]')).toBe(true);
    expect(ENTITY.test('S --> D["Agreements &amp; conflicts"]')).toBe(true);
  });

  it('leaves a bare ampersand and mermaid\'s own markup alone', () => {
    // `A & B` is valid mermaid (a node list), and <br/> is the line break mermaid documents.
    expect(ENTITY.test('flowchart LR\n  A & B --> C')).toBe(false);
    expect(ENTITY.test('D["Agreements · conflicts<br/>· only-in-one"]')).toBe(false);
  });

  it('every diagram declared in the real graphs is entity-free', () => {
    const graphs = readdirSync(STATIC_DIR)
      .filter((f) => f.endsWith('.ttl'))
      .map((f) => join(STATIC_DIR, f));
    const offenders = collectDiagramSources(graphs)
      .filter((src) => ENTITY.test(src))
      .map((src) => src.slice(0, 80));
    expect(offenders).toEqual([]);
  });
});
