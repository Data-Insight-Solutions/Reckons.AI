#!/usr/bin/env npx tsx
/**
 * Docs KB → WebPage generator — F27 Graph Publishing, docs pipeline.
 *
 * The docs knowledge graphs (`static/starter-guide.ttl` + `static/docs-*.ttl`) are the
 * source of truth for the "generated" sections of the /docs site — Guide, Features,
 * Triples & RDF, LLM, Use Cases, Integrations & Tech, Tips, Timeline & Ecosystem,
 * Architecture, Testing. This script parses those TTL files with `n3` (same library
 * `mcp-server/` uses), turns each qualifying entity into a `SitePage`, and writes
 * `content/<section>/<slug>.md` via `pageToMarkdown` (`src/lib/publish/site-export.ts`) —
 * so these files round-trip through `scripts/md-align.ts` exactly like Sveltia-authored
 * pages do.
 *
 * Every page this script writes carries `generated: "docs-kb"` in its frontmatter
 * (`PAGE_GENERATED` in `src/lib/rdf/page.ts`). That tag is both a human signal ("don't
 * hand-edit this, edit the TTL instead") and the prune marker: on each run, any
 * previously-generated file whose entity no longer exists in the TTLs is deleted.
 * Hand-authored content (`content/docs/welcome.md`, `content/releases/*`) has no
 * `generated` tag and is never touched.
 *
 * Determinism is the whole point — the same TTL input must always produce byte-identical
 * markdown, so `scripts/md-align.ts` (which round-trips committed content back through
 * the graph) and CI regeneration (`.github/workflows/kb-watch.yml`) both stay green.
 * Everywhere output depends on iterating a collection, that collection is explicitly
 * sorted first (never relying on object/Map key order or N3 parse order).
 *
 * Entity selection: any subject with an `rdf:type` triple whose object is under
 * `urn:kbase:type/` (Concept, Feature, Person, Organization, Document, KnowledgeBase,
 * Tool, ...), EXCEPT subjects in the `urn:reckons:docs/nav/` namespace (each sub-graph's
 * "back to hub" nav stub — UI wiring, not doc content).
 *
 * Some entities are asserted in *two* files: `starter-guide.ttl` keeps lightweight
 * "summary" stubs of a handful of concepts for its own in-app story/graph view,
 * annotated inline as "kept inline for story highlights", while the full definition
 * lives in the matching `docs-*.ttl` sub-graph. Rather than merge two divergent
 * `skos:definition` values, this script gives the sub-graph file (the fuller
 * definition) ownership of the page and drops the hub's stub entirely — see
 * `resolveHomeFile()`.
 *
 * Usage: npx tsx scripts/docs-pages.ts   (or `npm run docs:pages`)
 */

import { Parser, type Quad } from 'n3';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { slugify, type SitePage } from '../src/lib/rdf/page';
import { escapeMdText } from '../src/lib/publish/md-escape';
import { NAV_ORDER, NAV_NEXT, NAV_PREV, NAV_LAYER } from '../src/lib/rdf/hierarchy';
import { contentPath, pageToMarkdown } from '../src/lib/publish/site-export';
import { parsePageFile } from '../src/lib/publish/site-import';
import { loadCache, diagramKey, diagramFigure } from './lib/mermaid-render.js';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const STATIC_DIR = join(ROOT, 'static');
const CONTENT_DIR = join(ROOT, 'content');
const GENERATED_TAG = 'docs-kb';

// ── Namespaces / predicates ──────────────────────────────────────────────────

const RDF_TYPE        = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL       = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEFINITION  = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_BROADER     = 'http://www.w3.org/2004/02/skos/core#broader';
const SKOS_RELATED     = 'http://www.w3.org/2004/02/skos/core#related';
const HAS_STATUS       = 'urn:kbase:predicate/has-status';
const KTYPE_NS          = 'urn:kbase:type/';
const NAV_DOCS_NS       = 'urn:reckons:docs/nav/'; // per-sub-graph "back to hub" stub namespace
const DIAGRAM           = 'urn:kbase:predicate/diagram';
const DIAGRAM_CAPTION   = 'urn:kbase:predicate/diagram-caption';
const STEP_ORDER        = 'urn:kbase:predicate/step-order';
const PART_OF           = 'urn:kbase:predicate/part-of';

/** Literal-valued predicates that are structural/technical, not doc content — never
 *  rendered in the "Details" body section. */
const EXCLUDED_LITERAL_PREDICATES = new Set<string>([
  RDFS_LABEL, SKOS_DEFINITION, NAV_ORDER, NAV_LAYER,
  'urn:reckons:leap', 'urn:reckons:leap/label',
  'urn:kbase:meta/glbModel', 'urn:kbase:predicate/icon2d',
  // Rendered as an SVG figure by renderBody — dumping the mermaid source into a
  // "Details" bullet would show a reader the code instead of the picture.
  DIAGRAM, DIAGRAM_CAPTION,
]);

/** IRI-valued predicates handled elsewhere (type, parent, sibling chain) — never
 *  rendered in the generic "Related" body section. */
const EXCLUDED_IRI_PREDICATES = new Set<string>([RDF_TYPE, SKOS_BROADER, NAV_NEXT, NAV_PREV]);

// ── Section map — file → display title. Order here is the processing order used to
// resolve which file "owns" an entity asserted in more than one file (see
// resolveHomeFile): starter-guide.ttl is listed last on purpose, so a sub-graph's
// fuller definition always wins over the hub's summary stub. `slugify(title)` is
// what `contentPath()` turns into the content/<folder>/ name, so titles are chosen so
// their slug matches the intended folder (e.g. "Tips" -> content/tips/).
const SOURCES: ReadonlyArray<{ file: string; section: string }> = [
  { file: 'docs-triples-rdf.ttl', section: 'Triples & RDF' },
  { file: 'docs-llm.ttl', section: 'LLM' },
  { file: 'docs-use-cases.ttl', section: 'Use Cases' },
  { file: 'docs-features.ttl', section: 'Features' },
  { file: 'docs-integrations-tech.ttl', section: 'Integrations & Tech' },
  { file: 'docs-tips-security.ttl', section: 'Tips' },
  { file: 'docs-timeline-ecosystem.ttl', section: 'Timeline & Ecosystem' },
  { file: 'docs-architecture.ttl', section: 'Architecture' },
  { file: 'docs-coding-workflow.ttl', section: 'Coding Workflow' },
  { file: 'docs-testing.ttl', section: 'Testing' },
  { file: 'docs-user-paths.ttl', section: 'User Paths' },
  { file: 'starter-guide.ttl', section: 'Guide' },
];

// ── String helpers ───────────────────────────────────────────────────────────

function localName(iri: string): string {
  const m = /[/#]([^/#]+)$/.exec(iri);
  return m ? m[1] : iri;
}

/** PascalCase/camelCase local name -> kebab-case, e.g. "TTLExport" -> "ttl-export",
 *  "KBGroundedAccuracy" -> "kb-grounded-accuracy". Fed through `slugify()` afterwards. */
function kebabLocal(local: string): string {
  const spaced = local
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
  return slugify(spaced);
}

/** predicate/type local name -> "Human Readable" label, e.g. "createdBy" -> "Created By",
 *  "has-tool" -> "Has Tool", "KnowledgeBase" -> "Knowledge Base". */
function humanize(local: string): string {
  const spaced = local
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** First sentence of a definition (up to the first `.`/`!`/`?` followed by whitespace
 *  or end-of-string) — used for the frontmatter excerpt. Non-greedy so abbreviations
 *  like "etc." followed by more text (not a space) don't end the match early. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed);
  return (m ? m[0] : trimmed).trim();
}



// ── Parse ─────────────────────────────────────────────────────────────────────

function parseTtl(path: string): Quad[] {
  const text = readFileSync(path, 'utf8');
  return new Parser({ baseIRI: undefined }).parse(text);
}

/** For each TTL file, the set of subject IRIs that qualify as a page: has an
 *  `rdf:type` triple whose object is under `urn:kbase:type/`, and isn't a
 *  `urn:reckons:docs/nav/` "back to hub" stub. */
function candidateIris(quads: Quad[]): Set<string> {
  const out = new Set<string>();
  for (const q of quads) {
    if (
      q.predicate.value === RDF_TYPE &&
      q.object.termType === 'NamedNode' &&
      q.object.value.startsWith(KTYPE_NS) &&
      q.subject.termType === 'NamedNode' &&
      !q.subject.value.startsWith(NAV_DOCS_NS)
    ) {
      out.add(q.subject.value);
    }
  }
  return out;
}

/**
 * Resolve which file "owns" each candidate entity across the whole corpus. `SOURCES`
 * lists sub-graphs before `starter-guide.ttl` on purpose: if an IRI is asserted in a
 * sub-graph AND in the hub (the hub's lightweight "summary" stub — see module doc),
 * the sub-graph's fuller definition wins and the hub's copy is dropped entirely
 * rather than merged.
 */
function resolveHomeFiles(fileQuads: Map<string, Quad[]>): Map<string, string> {
  const home = new Map<string, string>();
  for (const { file } of SOURCES) {
    const quads = fileQuads.get(file)!;
    for (const iri of candidateIris(quads)) {
      if (!home.has(iri)) home.set(iri, file);
    }
  }
  return home;
}

// ── Entity extraction ────────────────────────────────────────────────────────

interface Entity {
  iri: string;
  section: string;
  title: string;
  types: string[];               // humanized ktype local names, sorted
  definition: string;
  parent: string | null;         // skos:broader target IRI (may or may not be a page)
  navOrder: number | null;       // explicit nav:order, if present
  literalProps: Map<string, string[]>; // predicate IRI -> sorted literal values
  iriProps: Map<string, string[]>;     // predicate IRI -> target IRIs (may or may not be pages)
  // Held apart from literalProps on purpose: the mermaid SOURCE is not prose and must never reach
  // the "Details" list, but renderBody still needs it to look the finished SVG up in the cache.
  diagram: string | null;
  diagramCaption: string | null;
}

function extractEntity(iri: string, section: string, quads: Quad[]): Entity {
  const own = quads.filter((q) => q.subject.value === iri);
  const types: string[] = [];
  let title = '';
  let definition = '';
  let parent: string | null = null;
  let navOrder: number | null = null;
  const literalProps = new Map<string, string[]>();
  const iriProps = new Map<string, string[]>();
  let diagram: string | null = null;
  let diagramCaption: string | null = null;

  for (const q of own) {
    const p = q.predicate.value;
    if (p === RDF_TYPE && q.object.termType === 'NamedNode' && q.object.value.startsWith(KTYPE_NS)) {
      types.push(humanize(localName(q.object.value)));
      continue;
    }
    if (p === RDFS_LABEL && q.object.termType === 'Literal') { title = q.object.value; continue; }
    if (p === SKOS_DEFINITION && q.object.termType === 'Literal') { definition = q.object.value; continue; }
    if (p === SKOS_BROADER && q.object.termType === 'NamedNode') { parent = parent ?? q.object.value; continue; }
    if (p === NAV_ORDER && q.object.termType === 'Literal') { navOrder = parseInt(q.object.value, 10); continue; }
    if (p === DIAGRAM && q.object.termType === 'Literal') { diagram = diagram ?? q.object.value; continue; }
    if (p === DIAGRAM_CAPTION && q.object.termType === 'Literal') { diagramCaption = diagramCaption ?? q.object.value; continue; }

    if (q.object.termType === 'Literal') {
      if (EXCLUDED_LITERAL_PREDICATES.has(p)) continue;
      const arr = literalProps.get(p) ?? [];
      arr.push(q.object.value);
      literalProps.set(p, arr);
    } else if (q.object.termType === 'NamedNode') {
      if (EXCLUDED_IRI_PREDICATES.has(p)) continue;
      const arr = iriProps.get(p) ?? [];
      arr.push(q.object.value);
      iriProps.set(p, arr);
    }
  }

  types.sort();
  for (const arr of literalProps.values()) arr.sort();
  for (const arr of iriProps.values()) { arr.sort(); }

  return {
    iri, section, title: title || localName(iri), types, definition, parent, navOrder,
    literalProps, iriProps, diagram, diagramCaption,
  };
}

// ── Slug assignment (globally unique — parent/related resolve by bare slug) ────

function assignSlugs(entities: Entity[]): Map<string, string> {
  const base = new Map<string, string>();
  for (const e of entities) base.set(e.iri, kebabLocal(localName(e.iri)));

  const byBase = new Map<string, Entity[]>();
  for (const e of entities) {
    const b = base.get(e.iri)!;
    const arr = byBase.get(b) ?? [];
    arr.push(e);
    byBase.set(b, arr);
  }

  const final = new Map<string, string>();
  for (const [b, group] of byBase) {
    if (group.length === 1) {
      final.set(group[0].iri, b);
      continue;
    }
    // Collision: same base slug, different entities (different IRIs asserted in
    // different sections that happen to share a local name) — disambiguate every
    // member of the group by appending its section slug.
    for (const e of group.sort((a, b) => a.iri.localeCompare(b.iri))) {
      final.set(e.iri, `${b}-${slugify(e.section)}`);
    }
  }

  // Final safety net: if section-suffixed slugs still collide (two entities, same
  // base name, same section — none in the current corpus), append a stable numeric
  // suffix ordered by IRI.
  const bySlug = new Map<string, string[]>();
  for (const [iri, slug] of final) {
    const arr = bySlug.get(slug) ?? [];
    arr.push(iri);
    bySlug.set(slug, arr);
  }
  for (const [slug, iris] of bySlug) {
    if (iris.length <= 1) continue;
    iris.sort();
    iris.forEach((iri, i) => { if (i > 0) final.set(iri, `${slug}-${i + 1}`); });
  }

  return final;
}

// ── Body rendering ───────────────────────────────────────────────────────────

interface PageRef { slug: string; section: string; title: string }

/** One child in a hub's walkthrough: enough to summarise it without opening it. */
interface ChildRef {
  slug: string; section: string; title: string;
  excerpt: string;      // first sentence of the child's definition
  status: string | null; // so a hub can say which of its steps are not built
  order: number;         // step-order, then nav:order, then alphabetical
}

/**
 * Lifecycle status banner (kb:honest-status).
 *
 * Published docs that describe a PLANNED feature in confident prose read as though the
 * feature exists. That is the overclaiming failure, at documentation scale — a reader
 * lands on /docs/features/x, sees a fluent description, and reasonably concludes they
 * can go use it. So the status leads the page, before the description, rather than
 * being buried in a Details list at the bottom where nobody reads it.
 */
const STATUS_BANNER: Record<string, string> = {
  speculative: '> **Speculative** — an idea under consideration. Not planned, not built.',
  planned: '> **Planned** — on the roadmap, **not yet built**. Described here as intended, not as shipped.',
  'in-progress': '> **In progress** — actively being built. Parts of what follows may not work yet.',
  scaffolded: '> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.',
  functional: '> **Functional** — built and working, with rough edges still being smoothed.',
  production: '> **Production** — built, tested, and in use.',
};

/**
 * The committed diagram cache, read once per run.
 *
 * This script NEVER renders. Mermaid lays text out with the fonts of whatever machine runs it, so
 * rendering here would make the generator non-deterministic and CI's regenerate-and-diff check
 * would report changes nobody made. `scripts/docs-diagrams.ts` owns rendering; a miss here is a
 * loud failure naming the fix, never a silently missing picture.
 */
const DIAGRAMS = loadCache();

function renderDiagramFor(e: Entity): string[] {
  const source = e.diagram;
  if (!source) return [];
  const key = diagramKey(source);
  const svg = DIAGRAMS[key];
  if (!svg) {
    throw new Error(
      `No cached diagram for <${e.iri}> (key ${key}).\n` +
      `Diagrams are rendered ahead of time so this generator stays deterministic.\n` +
      `Fix: npm run docs:diagrams`,
    );
  }
  return [diagramFigure(svg, e.diagramCaption ?? undefined), ''];
}

/**
 * A hub page's walkthrough of what sits underneath it.
 *
 * WHY THIS EXISTS. Relations in the body only ever pointed OUTWARD (`kpred:uses`, `skos:related`)
 * and `skos:broader` points UP, so a parent page rendered with no route to its own children — the
 * /docs/user-paths hub described five journeys and linked to none of them, which is a table of
 * contents with the contents missing. Children are indexed here so any hub becomes a walkthrough
 * automatically, in the order the author actually meant.
 *
 * The child's own status travels with it, so a hub cannot quietly present a step that is not built
 * as though it were finished (kb:honest-status) — the reader sees the gap in the list, before they
 * click.
 */
function renderChildren(children: ChildRef[], heading: string): string[] {
  if (!children.length) return [];
  const lines = [`## ${heading}`, ''];
  for (const c of children) {
    const flag = c.status && c.status !== 'functional' && c.status !== 'production'
      ? ` — **${escapeMdText(c.status)}**`
      : '';
    lines.push(`**[${escapeMdText(c.title)}](../${slugify(c.section)}/${c.slug})**${flag}`, '');
    if (c.excerpt) lines.push(escapeMdText(c.excerpt), '');
  }
  return lines;
}

function renderBody(e: Entity, refs: Map<string, PageRef>, children: ChildRef[] = []): string {
  const lines: string[] = [`# ${escapeMdText(e.title)}`, ''];
  if (e.types.length) { lines.push(`*${escapeMdText(e.types.join(', '))}*`, ''); }

  // Status first — before the prose that would otherwise imply the thing exists.
  const status = e.literalProps.get(HAS_STATUS)?.[0];
  if (status && STATUS_BANNER[status]) lines.push(STATUS_BANNER[status], '');

  if (e.definition) { lines.push(escapeMdText(e.definition), ''); }

  // The picture goes directly under the sentence that introduces it, not at the bottom.
  lines.push(...renderDiagramFor(e));

  // Then the route onward. A reader who wants the next page should not have to scroll past
  // every property of this one to find it, so children come before Details.
  lines.push(...renderChildren(children, e.parent ? 'Steps' : 'Where to go next'));

  // has-status is rendered as the banner above; don't repeat it in Details.
  const literalKeys = [...e.literalProps.keys()]
    .filter((p) => p !== HAS_STATUS)
    .sort((a, b) => humanize(localName(a)).localeCompare(humanize(localName(b))));
  if (literalKeys.length) {
    lines.push('## Details', '');
    for (const p of literalKeys) {
      lines.push(`**${escapeMdText(humanize(localName(p)))}**`, '');
      for (const v of e.literalProps.get(p)!) lines.push(`- ${escapeMdText(v)}`);
      lines.push('');
    }
  }

  const iriKeys = [...e.iriProps.keys()].sort((a, b) =>
    humanize(localName(a)).localeCompare(humanize(localName(b))));
  const relatedBlocks: string[] = [];
  for (const p of iriKeys) {
    const targets = e.iriProps.get(p)!
      .map((t) => refs.get(t))
      .filter((r): r is PageRef => !!r)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!targets.length) continue;
    relatedBlocks.push(`**${escapeMdText(humanize(localName(p)))}**`, '');
    for (const t of targets) {
      relatedBlocks.push(`- [${escapeMdText(t.title)}](../${slugify(t.section)}/${t.slug})`);
    }
    relatedBlocks.push('');
  }
  if (relatedBlocks.length) { lines.push('## Related', '', ...relatedBlocks); }

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

// ── content/ tree walk (for pruning stale generated pages) ──────────────────

function walkMd(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Remove now-empty directories under content/ (bottom-up), leaving content/ itself. */
function pruneEmptyDirs(dir: string): void {
  if (dir === CONTENT_DIR || !existsSync(dir)) return;
  const entries = readdirSync(dir);
  if (entries.length === 0) {
    rmdirSync(dir);
    pruneEmptyDirs(dirname(dir));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const fileQuads = new Map<string, Quad[]>();
  for (const { file } of SOURCES) fileQuads.set(file, parseTtl(join(STATIC_DIR, file)));

  const home = resolveHomeFiles(fileQuads);
  const sectionOf = new Map(SOURCES.map((s) => [s.file, s.section]));

  const entities: Entity[] = [...home.entries()]
    .map(([iri, file]) => extractEntity(iri, sectionOf.get(file)!, fileQuads.get(file)!))
    .sort((a, b) => a.iri.localeCompare(b.iri));

  const slugs = assignSlugs(entities);

  // order: explicit nav:order kept as-is; everything else gets a deterministic
  // alphabetical index starting at 1000 (so explicit sequences like the Guide's
  // 9 leap nodes, nav:order 1-9, always sort first within their section).
  const order = new Map<string, number>();
  const bySection = new Map<string, Entity[]>();
  for (const e of entities) {
    const arr = bySection.get(e.section) ?? [];
    arr.push(e);
    bySection.set(e.section, arr);
  }
  for (const group of bySection.values()) {
    const withOrder = group.filter((e) => e.navOrder !== null);
    const withoutOrder = group.filter((e) => e.navOrder === null).sort((a, b) => a.title.localeCompare(b.title));
    for (const e of withOrder) order.set(e.iri, e.navOrder!);
    withoutOrder.forEach((e, i) => order.set(e.iri, 1000 + i));
  }

  // Reverse-lookup table for body relation links: only entities that ended up as
  // pages resolve to a link; everything else is silently dropped (matches
  // pageToMarkdown's own handling of unresolvable parent/related IRIs).
  const refs = new Map<string, PageRef>();
  for (const e of entities) refs.set(e.iri, { slug: slugs.get(e.iri)!, section: e.section, title: e.title });

  // Children, indexed by parent, so a hub page can render the route through what it contains.
  // Sort key: explicit kpred:step-order first (a numbered sequence the author wrote), then
  // nav:order, then title — deterministic in every case, which the regeneration check requires.
  //
  // A child declares its parent EITHER as skos:broader (the taxonomy edge, used between hubs and
  // the journeys under them) OR as kpred:part-of (the composition edge, used by the numbered steps
  // inside one journey). Both mean "this page lives under that one" for navigation purposes, and
  // indexing only the first is why every path page rendered without its own steps.
  const childrenOf = new Map<string, ChildRef[]>();
  for (const e of entities) {
    const partOf = e.iriProps.get(PART_OF)?.find((t) => refs.has(t)) ?? null;
    const parent = (e.parent && refs.has(e.parent)) ? e.parent : partOf;
    if (!parent) continue;
    const stepRaw = e.literalProps.get(STEP_ORDER)?.[0];
    const step = stepRaw !== undefined ? parseInt(stepRaw, 10) : NaN;
    const arr = childrenOf.get(parent) ?? [];
    arr.push({
      slug: slugs.get(e.iri)!, section: e.section, title: e.title,
      excerpt: e.definition ? firstSentence(e.definition) : '',
      status: e.literalProps.get(HAS_STATUS)?.[0] ?? null,
      order: Number.isFinite(step) ? step : (e.navOrder ?? Number.MAX_SAFE_INTEGER),
    });
    childrenOf.set(parent, arr);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  const pages: SitePage[] = entities.map((e) => ({
    iri: e.iri,
    title: e.title,
    slug: slugs.get(e.iri)!,
    section: e.section,
    order: order.get(e.iri)!,
    parent: e.parent && refs.has(e.parent) ? e.parent : null,
    template: 'doc',
    status: 'published',
    nav: 'sidebar',
    excerpt: e.definition ? firstSentence(e.definition) : '',
    body: renderBody(e, refs, childrenOf.get(e.iri) ?? []),
    // Sorted by slug (not source IRI): `md-align`'s round trip reconstructs `related`
    // via synthetic `urn:kbase:concept/<slug>` IRIs and re-sorts alphabetically, so the
    // frontmatter list must already be in that order for the output to be stable.
    related: (e.iriProps.get(SKOS_RELATED) ?? [])
      .filter((r) => refs.has(r))
      .sort((a, b) => refs.get(a)!.slug.localeCompare(refs.get(b)!.slug)),
    next: null,
    prev: null,
    date: null,
    generated: GENERATED_TAG,
  }));

  pages.sort((a, b) => contentPath(a).localeCompare(contentPath(b)));

  const newFiles = new Map<string, string>();
  for (const page of pages) newFiles.set(contentPath(page), pageToMarkdown(page, slugs));

  // ── Prune stale generated files (never touches files without generated: "docs-kb") ──
  const existingMd = walkMd(CONTENT_DIR);
  let pruned = 0;
  for (const abs of existingMd) {
    const rel = `content/${abs.slice(CONTENT_DIR.length + 1).split('\\').join('/')}`;
    if (newFiles.has(rel)) continue;
    const parsed = parsePageFile(readFileSync(abs, 'utf8'));
    if (parsed.generated !== GENERATED_TAG) continue; // hand-authored — never touch
    unlinkSync(abs);
    pruned++;
    pruneEmptyDirs(dirname(abs));
  }

  // ── Write new/changed files ──────────────────────────────────────────────────
  let written = 0;
  let unchanged = 0;
  for (const [rel, content] of newFiles) {
    const abs = join(ROOT, rel);
    // Read-and-catch rather than existsSync-then-read: the check-then-use pair is a race
    // (the file can vanish between the two calls) and CodeQL flags it as js/file-system-race.
    // Attempting the read directly is both correct and one syscall cheaper.
    let existing: string | null = null;
    try { existing = readFileSync(abs, 'utf8'); } catch { /* missing → write it */ }
    if (existing === content) { unchanged++; continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    written++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const perSection = new Map<string, number>();
  for (const page of pages) perSection.set(page.section, (perSection.get(page.section) ?? 0) + 1);

  console.log(`Docs KB pages: ${pages.length} total (${written} written, ${unchanged} unchanged, ${pruned} pruned)`);
  for (const [section, count] of [...perSection.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${section}: ${count}`);
  }
}

main();
