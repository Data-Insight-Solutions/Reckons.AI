/**
 * Mermaid → inline SVG, at BUILD TIME. Diagrams for the /docs site.
 *
 * WHY BUILD TIME AND NOT THE BROWSER. `src/routes/docs/+layout.ts` sets `csr = false`: the docs
 * route ships ZERO client JavaScript on purpose, so a doc page costs a reader nothing to open and
 * still renders with scripting disabled. Mermaid is a ~500 KB browser library. Loading it would
 * reverse that decision for decoration. So mermaid runs HERE, once, against a headless Chromium
 * this repo already has for Playwright, and the docs ship the finished SVG as markup.
 *
 * WHY THE OUTPUT IS CACHED IN A COMMITTED FILE. `scripts/docs-pages.ts` must be deterministic —
 * `scripts/md-align.ts` round-trips committed content back through the graph and CI regenerates
 * and diffs, so the same TTL has to produce byte-identical markdown on every machine. Mermaid's
 * layout depends on TEXT METRICS, which depend on the fonts installed on the box doing the
 * rendering. A CI runner and a laptop measure the same label differently, so re-rendering in CI
 * would produce a diff nobody wrote. The rendered SVG is therefore committed, keyed by a hash of
 * its own mermaid source, and CI only ever READS it: a cache miss is a loud failure telling you to
 * run `npm run docs:diagrams`, never a silent re-render.
 *
 * WHY THE COLOURS ARE REWRITTEN. Mermaid bakes a palette into the SVG as hex literals. The docs
 * site is themed with CSS custom properties and follows the reader's light/dark preference, so a
 * baked palette is wrong in one of the two themes — and diagrams that are legible in the theme the
 * author happened to use are a documentation bug that only some readers see. Every colour mermaid
 * emits is mapped onto the site's own variables, so a diagram inherits the page it sits on.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
const MERMAID_DIST = join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');

/** The committed render cache: sha256(source + config) -> finished SVG markup. */
export const CACHE_FILE = join(ROOT, 'static', 'diagram-cache.json');

/**
 * Bumped by hand when the rendering CONTRACT changes — a new colour mapping, a different mermaid
 * config, an upgrade that moves layout. It is part of every cache key, so bumping it invalidates
 * every entry at once instead of leaving a mix of old and new output that nobody can tell apart.
 */
const RENDER_CONTRACT = 'v1';

export type DiagramCache = Record<string, string>;

export function loadCache(): DiagramCache {
  if (!existsSync(CACHE_FILE)) return {};
  return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as DiagramCache;
}

export function saveCache(cache: DiagramCache): void {
  // Sorted keys so the committed file has a stable diff and two people adding diagrams in
  // parallel produce a conflict git can actually show, rather than a whole-file rewrite.
  const sorted: DiagramCache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  writeFileSync(CACHE_FILE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/** The cache key for one diagram. Exported so docs-pages.ts can look up without rendering. */
export function diagramKey(source: string): string {
  return createHash('sha256')
    .update(`${RENDER_CONTRACT}\n${source.trim()}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Mermaid's default palette, mapped onto the docs site's own custom properties.
 *
 * Hex is matched case-insensitively and both the `fill="#fff"` presentation-attribute form and the
 * `style="fill:#fff"` form are rewritten, because mermaid emits both depending on the element.
 */
const COLOR_MAP: ReadonlyArray<[RegExp, string]> = [
  // Node bodies and clusters.
  [/#ececff/gi, 'var(--diagram-node-bg)'],
  [/#eceffb/gi, 'var(--diagram-node-bg)'],
  [/#ffffde/gi, 'var(--diagram-note-bg)'],
  [/#fff5ad/gi, 'var(--diagram-note-bg)'],
  // Borders.
  [/#9370db/gi, 'var(--diagram-node-border)'],
  [/#9370d8/gi, 'var(--diagram-node-border)'],
  [/#aaaa33/gi, 'var(--diagram-note-border)'],
  // Edges and arrowheads.
  [/#333333/gi, 'var(--diagram-line)'],
  [/#333\b/gi, 'var(--diagram-line)'],
  // Text.
  [/#000000/gi, 'var(--diagram-ink)'],
  [/#000\b/gi, 'var(--diagram-ink)'],
  // Plain white fills (subgraph backgrounds).
  [/#ffffff/gi, 'var(--diagram-surface)'],
  [/#fff\b/gi, 'var(--diagram-surface)'],
];

/**
 * Make one rendered SVG deterministic and theme-aware.
 *
 * Mermaid mints ids from a global counter and, for some diagram types, from `Date.now()`. Those
 * ids appear in `id=`, in `url(#…)` marker references and in generated CSS, so they must be
 * rewritten CONSISTENTLY rather than merely stripped — a half-renamed marker reference produces a
 * diagram with no arrowheads, which still looks plausible.
 */
export function normalizeSvg(svg: string, stableId: string): string {
  let out = svg;

  // 1. Rewrite every mermaid-minted id to one derived from the diagram's own content hash.
  const ids = new Set<string>();
  for (const m of out.matchAll(/\b(?:id="|url\(#)((?:mermaid|flowchart|graph|my-svg)[A-Za-z0-9_-]*)/g)) {
    ids.add(m[1]);
  }
  let n = 0;
  for (const id of [...ids].sort()) {
    // Word-boundary-anchored so `foo` never rewrites the prefix of `foobar`.
    out = out.replaceAll(id, `d${stableId}-${n++}`);
  }

  // 2. Drop the inline max-width mermaid computes from the viewport it happened to render in.
  //    The docs stylesheet sizes the figure; a baked pixel width would fight it and would also
  //    vary with the headless window size, which is exactly the non-determinism we are removing.
  out = out.replace(/\s*style="[^"]*max-width:[^"]*"/gi, '');
  out = out.replace(/\swidth="[\d.]+(?:px)?"/gi, '');
  out = out.replace(/\sheight="[\d.]+(?:px)?"/gi, ' height="100%"');

  // 3. Theme the palette.
  for (const [re, cssVar] of COLOR_MAP) out = out.replace(re, cssVar);

  // 4. Collapse whitespace runs that differ between mermaid versions without changing rendering.
  out = out.replace(/>\s+</g, '><').trim();

  return out;
}

/**
 * Render many diagrams in ONE browser. Launching Chromium costs ~300ms and rendering costs ~30ms,
 * so a per-diagram browser would dominate the build for no reason.
 *
 * Playwright is imported lazily: `docs-pages.ts` reads the cache on every run and must not pay for
 * a browser binary it will not use.
 */
export async function renderDiagrams(sources: string[]): Promise<Map<string, string>> {
  if (!sources.length) return new Map();
  if (!existsSync(MERMAID_DIST)) {
    throw new Error(
      `mermaid is not installed (${MERMAID_DIST} missing). It is a devDependency — run \`npm install\`.`,
    );
  }

  const { chromium } = await import('@playwright/test');
  const mermaidJs = readFileSync(MERMAID_DIST, 'utf8');
  const browser = await chromium.launch();
  const out = new Map<string, string>();

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    // A real document with a settled font stack. `about:blank` works, but giving the page an
    // explicit font-family keeps text metrics as close to reproducible as this approach allows.
    await page.setContent(
      '<!doctype html><html><head><style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif}</style></head><body></body></html>',
    );
    await page.addScriptTag({ content: mermaidJs });
    await page.evaluate(() => {
      // @ts-expect-error — mermaid is injected into the page, not the Node scope.
      window.mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        flowchart: { htmlLabels: false, curve: 'basis' },
        sequence: { useMaxWidth: true },
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      });
    });

    for (const source of sources) {
      const key = diagramKey(source);
      const svg = await page.evaluate(async ([src, id]) => {
        // @ts-expect-error — injected.
        const { svg } = await window.mermaid.render(id, src);
        return svg as string;
      }, [source.trim(), `m${key}`] as const);
      out.set(key, normalizeSvg(svg, key));
    }
  } finally {
    await browser.close();
  }

  return out;
}

/** Wrap a finished SVG for the page: a figure with an accessible caption. */
export function diagramFigure(svg: string, caption?: string): string {
  const fig = caption
    ? `<figure class="diagram" role="group" aria-label="${escapeAttr(caption)}">${svg}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
    : `<figure class="diagram">${svg}</figure>`;
  return fig;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
