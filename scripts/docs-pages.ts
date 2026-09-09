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
import { loadSceneCache, sceneKey, sceneFigure, sceneIframe } from './lib/scene-render.js';

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
/* F190 — a three.js scene, rendered to a still at build time (kpred:scene) or embedded as an
 * iframe island when it must react to a pointer (kpred:scene-live). Both keep `csr = false`. */
const SCENE             = 'urn:kbase:predicate/scene';
const SCENE_CAPTION     = 'urn:kbase:predicate/scene-caption';
const SCENE_ALT         = 'urn:kbase:predicate/scene-alt';
const SCENE_LIVE        = 'urn:kbase:predicate/scene-live';
/* A KB Leap: in the app it switches graphs, on the site it must become a web link. The value is
 * the TARGET graph's stable id, which every docs graph declares, so the mapping is derivable. */
/* How an entity's children should be PRESENTED. The transformation is a fact in the graph, so it
 * is reproducible and reviewable rather than a decision buried in the generator. */
const RENDER_AS         = 'urn:kbase:predicate/render-as';
const LEAP              = 'urn:reckons:leap';
const KB_STABLE_ID      = 'urn:reckons:meta/kbStableId';
const STEP_ORDER        = 'urn:kbase:predicate/step-order';
const PART_OF           = 'urn:kbase:predicate/part-of';
const THESIS_IRI        = 'urn:kbase:concept/thesis';
const RENDER_INLINE     = 'urn:kbase:predicate/render-inline';
const CHILDREN_LABEL    = 'urn:kbase:predicate/children-label';
const SHOW_ON_LANDING   = 'urn:kbase:predicate/show-on-landing';
const TENET_STATUS      = 'urn:kbase:predicate/tenet-status';

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

/**
 * Structural predicates that are READ by the generator but never SHOWN to a reader.
 *
 * They cannot be dropped at extraction time the way EXCLUDED_* are — `part-of` is how a child
 * finds its parent and `step-order` is how the steps are sorted, so removing them from the data
 * silently unbuilds the hierarchy while every gate still passes. (It did, for one run, on
 * 2026-09-06.) Excluded here, at the point of rendering, and only there.
 */
const RENDER_ONLY_STRUCTURAL = new Set<string>([
  PART_OF, STEP_ORDER, RENDER_INLINE, CHILDREN_LABEL,
  // Which surface a tenet appears on is a routing flag, not something to print at a reader.
  SHOW_ON_LANDING,
]);

// ── Section map — file → display title. Order here is the processing order used to
// resolve which file "owns" an entity asserted in more than one file (see
// resolveHomeFile): starter-guide.ttl is listed last on purpose, so a sub-graph's
// fuller definition always wins over the hub's summary stub. `slugify(title)` is
// what `contentPath()` turns into the content/<folder>/ name, so titles are chosen so
// their slug matches the intended folder (e.g. "Tips" -> content/tips/).
/**
 * `only` publishes a SUBSET of a graph.
 *
 * reckons-roadmap.ttl is the plan, not documentation, and publishing it wholesale would put 255
 * feature entities on the public site. But the tenets live there — they are the source the landing
 * page is generated from — and they are exactly the thing a reader should be able to read in full.
 * So the thesis subtree is published and nothing else from that file is. One source, two surfaces:
 * the landing page shows a headline and one sentence, /docs/principles carries the argument.
 */
const SOURCES: ReadonlyArray<{
  file: string; section: string; only?: (iri: string, quads: Quad[]) => boolean;
}> = [
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
  {
    file: 'reckons-roadmap.ttl',
    section: 'Principles',
    // Membership, not rdf:type. kb:design-observed-archive is typed ktype:Tenet but is an
    // internal design paradigm with no tenet-body and no place in the thesis — filtering by type
    // published it. `part-of kb:thesis` is what actually makes something a tenet of the thesis.
    only: (iri, quads) => iri === THESIS_IRI || quads.some((q) =>
      q.subject.value === iri && q.predicate.value === PART_OF && q.object.value === THESIS_IRI),
  },
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
  for (const { file, only } of SOURCES) {
    const quads = fileQuads.get(file)!;
    for (const iri of candidateIris(quads)) {
      if (only && !only(iri, quads)) continue;
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
  scene: string | null;
  sceneCaption: string | null;
  sceneAlt: string | null;
  sceneLive: string | null;
  /** Stable id of the graph this entity leaps to, if it is a leap node. */
  leapTo: string | null;
  /** "accordion" | "gallery" | null (a plain list). Declared by kpred:render-as. */
  renderAs: string | null;
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
  let scene: string | null = null;
  let sceneCaption: string | null = null;
  let sceneAlt: string | null = null;
  let sceneLive: string | null = null;
  let leapTo: string | null = null;
  let renderAs: string | null = null;

  for (const q of own) {
    const p = q.predicate.value;
    if (p === RDF_TYPE && q.object.termType === 'NamedNode' && q.object.value.startsWith(KTYPE_NS)) {
      types.push(humanize(localName(q.object.value)));
      continue;
    }
    if (p === RDFS_LABEL && q.object.termType === 'Literal') { title = q.object.value; continue; }
    if (p === SKOS_DEFINITION && q.object.termType === 'Literal') { definition = q.object.value; continue; }
    if (p === SCENE && q.object.termType === 'Literal') { scene = q.object.value; continue; }
    if (p === SCENE_CAPTION && q.object.termType === 'Literal') { sceneCaption = q.object.value; continue; }
    if (p === SCENE_ALT && q.object.termType === 'Literal') { sceneAlt = q.object.value; continue; }
    if (p === SCENE_LIVE && q.object.termType === 'Literal') { sceneLive = q.object.value; continue; }
    if (p === LEAP && q.object.termType === 'Literal') { leapTo = q.object.value; continue; }
    if (p === RENDER_AS && q.object.termType === 'Literal') { renderAs = q.object.value.trim(); continue; }
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
    scene, sceneCaption, sceneAlt, sceneLive, leapTo, renderAs,
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
  // Set when the child was too thin to earn its own page: it is rendered inline here instead,
  // in full, at the position it would have occupied as a link.
  folded: Entity | null;
}

/**
 * Reading order for the prose predicates, and the section each belongs under.
 *
 * WHY THIS EXISTS. Everything below the definition used to be sorted ALPHABETICALLY BY PREDICATE
 * NAME and dumped under one heading called "Details". So a page whose author had written
 * `kpred:read-first` — literally "read this first" — rendered it below `kpred:principle`, because
 * P sorts before R. The most important sentence on a page was positioned by an accident of the
 * English word someone chose for the predicate, and filed under the least informative heading
 * available in the language.
 *
 * `rank` is reading order; `band` is the section heading it appears under, and an empty band means
 * no heading at all — the page speaking in its own voice, straight after its definition. Anything
 * unlisted still renders: it lands in the final band alphabetically, so a newly minted predicate
 * degrades to the old behaviour rather than vanishing.
 */
interface PredicateStyle { band: string; rank: number }

const PREDICATE_STYLE: Record<string, PredicateStyle> = {
  'read-first':    { band: '', rank: 10 },
  'tenet-body':    { band: '', rank: 15 },
  'tenet-status':  { band: '', rank: 12 },   // rendered as a banner, see renderProse
  'description':   { band: '', rank: 20 },
  'summary':       { band: '', rank: 30 },

  // A path's shape, in the order a reader needs it: who it is for, where it begins, where it
  // lands. Alphabetically these came out audience / ends-with / starts-with — the journey
  // described backwards, under a heading called "Detail".
  'audience':      { band: 'At a glance', rank: 40 },
  'starts-with':   { band: 'At a glance', rank: 50 },
  'ends-with':     { band: 'At a glance', rank: 60 },

  'decided':       { band: 'Why it is this way', rank: 100 },
  'principle':     { band: 'Why it is this way', rank: 110 },
  'constraint':    { band: 'Why it is this way', rank: 120 },
  'tenet':         { band: 'Why it is this way', rank: 130 },
  'honest-note':   { band: 'Why it is this way', rank: 140 },
  'note':          { band: 'Why it is this way', rank: 150 },

  'measured':      { band: 'What we found', rank: 200 },
  'evidence':      { band: 'What we found', rank: 210 },
  'proof':         { band: 'What we found', rank: 220 },
  'example':       { band: 'What we found', rank: 230 },

  'known-issue':   { band: 'What is not done', rank: 300 },
  'open-question': { band: 'What is not done', rank: 310 },
  'remaining':     { band: 'What is not done', rank: 320 },
  'done':          { band: 'What is not done', rank: 330 },
};

const FALLBACK_BAND = 'Detail';

function styleFor(predicateIri: string): PredicateStyle {
  return PREDICATE_STYLE[localName(predicateIri)] ?? { band: FALLBACK_BAND, rank: 1000 };
}

/**
 * One entity's prose: bands in reading order, values as PARAGRAPHS.
 *
 * Values used to be bullets. A bullet list of four-sentence paragraphs reads as a checklist nobody
 * intends to tick, and a single-valued predicate became a one-item list — the least useful list
 * there is. Several values under one predicate still list, because then it really is a list.
 *
 * `depth` lets the same renderer serve a page (h2 bands) and an entity folded into its parent
 * (h4 bands), so a folded section cannot outrank the page it sits inside.
 */
function renderProse(e: Entity, depth: number): string[] {
  const hash = '#'.repeat(Math.min(6, depth));
  const keys = [...e.literalProps.keys()]
    .filter((k) => k !== HAS_STATUS && !RENDER_ONLY_STRUCTURAL.has(k))
    .sort((a, b) => {
      const sa = styleFor(a), sb = styleFor(b);
      return sa.rank - sb.rank || humanize(localName(a)).localeCompare(humanize(localName(b)));
    });

  const lines: string[] = [];
  let openBand: string | null = null;
  for (const k of keys) {
    const { band } = styleFor(k);
    if (band !== openBand) {
      if (band) lines.push(`${hash} ${escapeMdText(band)}`, '');
      openBand = band;
    }
    const values = e.literalProps.get(k)!;
    // The built/belief distinction is the whole point of kb:honest-status on this page, so it
    // reads as a marker rather than as "Tenet Status: belief" in a properties list.
    if (k === TENET_STATUS) {
      const v = values[0];
      lines.push(v === 'built'
        ? '> **Enforced in code** — there is a mechanism, and it runs.'
        : '> **What we believe** — a commitment, not a control. Nothing enforces this.', '');
      continue;
    }
    if (band) lines.push(`**${escapeMdText(humanize(localName(k)))}**`, '');
    if (values.length === 1) lines.push(escapeMdText(values[0]), '');
    else { for (const v of values) lines.push(`- ${escapeMdText(v)}`); lines.push(''); }
  }
  return lines;
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
const SCENES = loadSceneCache();
/** stable id -> the page a leap should land on. Filled in main(), read by the renderers. */
const LEAP_TARGETS = new Map<string, { section: string; slug: string; title: string }>();

/**
 * stable graph id -> section title, read from each source's own `kbStableId`.
 *
 * A KB Leap names its target by stable id because in the app it switches graphs. On the site the
 * same id has to become a URL, and every docs graph already declares its id — so the mapping is
 * DERIVED rather than kept in a table that would drift from the graphs it describes.
 */
function sectionsByStableId(fileQuads: Map<string, Quad[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { file, section } of SOURCES) {
    for (const q of fileQuads.get(file) ?? []) {
      if (q.predicate.value === KB_STABLE_ID && q.object.termType === 'Literal') {
        out.set(q.object.value, section);
      }
    }
  }
  return out;
}

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
 * A three.js scene, as a still or as an iframe island — never as script in the document.
 *
 * The still is looked up by hash and NEVER rendered here, exactly as diagrams are: rendering needs
 * a GPU and a browser, so it happens once in `npm run docs:scenes` and its output is committed and
 * reviewed. A miss is a loud failure naming the command, not a silent blank.
 */
/**
 * The link a leap should be, or null if its target graph is not published.
 *
 * A leap whose target does not resolve renders as ordinary prose rather than a broken link. That
 * is deliberate: a graph can be present in the app and absent from the site, and inventing a URL
 * for it would send a reader to a 404 that looks like our mistake rather than an absent section.
 */
function leapLink(e: Entity): { href: string; title: string } | null {
  if (!e.leapTo) return null;
  const t = LEAP_TARGETS.get(e.leapTo);
  return t ? { href: `../${slugify(t.section)}/${t.slug}`, title: t.title } : null;
}

function renderSceneFor(e: Entity): string[] {
  const out: string[] = [];
  if (e.scene) {
    const key = sceneKey(e.scene);
    const size = SCENES[key];
    if (!size) {
      throw new Error(
        `No rendered scene for <${e.iri}> (key ${key}).\n` +
        `Scenes are rendered ahead of time so this generator stays deterministic and JS-free.\n` +
        `Fix: npm run docs:scenes`,
      );
    }
    // Alt text is required, not defaulted: a generated page cannot be asked for it later.
    if (!e.sceneAlt) {
      throw new Error(`<${e.iri}> declares kpred:scene with no kpred:scene-alt. A picture with no alt text is a picture some readers do not get.`);
    }
    out.push(sceneFigure(key, size, e.sceneAlt, e.sceneCaption ?? undefined), '');
  }
  if (e.sceneLive) {
    out.push(sceneIframe(e.sceneLive, e.sceneAlt ?? e.title, { width: 1200, height: 600 }, e.sceneCaption ?? undefined), '');
  }
  return out;
}

/**
 * How much prose an entity actually carries — the number that decides whether it is a page.
 *
 * Counts the definition plus every content predicate. Structural values are already excluded from
 * literalProps, so this is what a reader would actually read.
 */
function proseWeight(e: Entity): number {
  let words = e.definition ? e.definition.split(/\s+/).length : 0;
  for (const [k, values] of e.literalProps) {
    if (k === HAS_STATUS) continue;
    for (const v of values) words += v.split(/\s+/).length;
  }
  return words;
}

/** Below this many words, an entity is a paragraph and is folded into its parent. */
const PAGE_THRESHOLD_WORDS = 45;

/**
 * Does this entity deserve a page of its own?
 *
 * MEASURED, WHICH IS WHY THE RULE EXISTS: 138 of 316 generated pages — 43% — carried under 40
 * words of prose, and nine carried under 20. `content/features/entity-types.md` was a title and
 * one sentence. That is not a short page, it is a paragraph that has been given a URL, a sidebar
 * entry, a heading and a back-link, and the reader pays a navigation step to reach one line.
 *
 * A thin entity is folded into its parent as a section instead, which fixes the same problem from
 * the other end: the parent stops being a table of contents and becomes a page worth reading.
 *
 * An entity with children always earns a page whatever its length — it is a junction, and folding
 * it would strand everything beneath it.
 */
function earnsPage(e: Entity, hasChildren: boolean, hasParentPage: boolean, hostInlines = false): boolean {
  // The parent said so. Some sets read as ONE document and are actively worse split up: the ten
  // tenets are an argument, and ten pages of seventy words each is the table-of-contents failure
  // this generator already folds thin entities to avoid. Declared on the parent
  // (kpred:render-inline) rather than inferred, so it is visible in the graph and reviewable.
  if (hostInlines) return false;
  if (hasChildren) return true;
  if (!hasParentPage) return true;      // nothing to fold into
  if (e.diagram) return true;           // a picture is worth the page
  return proseWeight(e) >= PAGE_THRESHOLD_WORDS;
}

/**
 * A hub's route through what sits underneath it.
 *
 * WHY THIS EXISTS. Relations in the body only ever pointed OUTWARD (`kpred:uses`, `skos:related`)
 * and `skos:broader` points UP, so a parent page rendered with no route to its own children — the
 * /docs/user-paths hub described nine journeys and linked to none of them, which is a table of
 * contents with the contents missing.
 *
 * A child that earned its own page gets a link and its first sentence. A child that did not is
 * rendered INLINE, in full, at the same position — so the sequence a reader follows is the same
 * either way, and the thin ones stop being a click that leads to one line.
 *
 * A child's status travels with it, so a hub cannot quietly present a step that is not built as
 * though it were finished (kb:honest-status) — the gap is visible before the reader clicks.
 */
/**
 * How a set of children is PRESENTED, declared in the graph by kpred:render-as.
 *
 * Matt, 2026-09-08: "more dynamic elements for lists of things, like a filterable gallery of
 * cards. Or, maybe accordion for shorter lists. These transformations should be noted in triples,
 * and reproducible." So the choice is a fact on the parent, not a decision in this file — the same
 * declaration always produces the same page, and changing the presentation is a graph edit that
 * goes through review like any other.
 *
 * BOTH SHIP ZERO JAVASCRIPT, which is why they can exist at all on a route with csr = false.
 * An accordion is <details>/<summary>, which every browser has had for years and which is
 * keyboard-accessible and findable by the browser's own find-in-page when open. A gallery is CSS
 * grid. Neither needs the search island's treatment.
 *
 * FILTERING IS NOT HERE YET, and it is the one part that would. A filter over a fixed, small set
 * of facets can be done with radio inputs and :has() and still ship no script; an open text filter
 * cannot. Deferred deliberately rather than quietly turned into a reason to enable csr.
 */
function renderChildren(children: ChildRef[], heading: string, renderAs: string | null = null): string[] {
  if (!children.length) return [];
  const lines = [`## ${escapeMdText(heading)}`, ''];

  if (renderAs === 'gallery') {
    /*
     * WHERE A CARD POINTS, and getting this wrong shipped 22 dead links on one page.
     *
     * The first version linked every child to `../section/slug`, which is only correct for a
     * child that EARNED A PAGE. A folded child has no page — that is what folded means — and a
     * leap node's destination is another section entirely. So a gallery must resolve three cases,
     * and it must also not silently drop the folded children's content the way the first version
     * did: in list mode they render inline, so in gallery mode they have to render below the
     * cards and be reachable by anchor.
     */
    const inlineAfter: ChildRef[] = [];
    lines.push('<div class="card-grid">', '');
    for (const c of children) {
      const leap = c.folded ? leapLink(c.folded) : null;
      let href: string;
      if (leap) href = leap.href;                       // a leap goes where it leaps to
      else if (!c.folded) href = `../${slugify(c.section)}/${c.slug}`;   // it has its own page
      else { href = `#${c.slug}`; inlineAfter.push(c); } // no page: anchor, rendered below
      const flag = c.status && c.status !== 'functional' && c.status !== 'production'
        ? `<span class="card-status">${escapeMdText(c.status)}</span>` : '';
      lines.push(
        `<a class="card" href="${href}"><span class="card-title">${escapeMdText(c.title)}</span>${flag}`
        + `<span class="card-text">${escapeMdText(c.excerpt ?? '')}</span></a>`,
      );
    }
    lines.push('', '</div>', '');
    // The folded content itself, so a gallery never costs a reader the text a list would show.
    for (const c of inlineAfter) {
      lines.push(`<h3 id="${c.slug}">${escapeMdText(c.title)}</h3>`, '');
      if (c.folded?.definition) lines.push(escapeMdText(c.folded.definition), '');
      lines.push(...renderDiagramFor(c.folded!));
      lines.push(...renderSceneFor(c.folded!));
      lines.push(...renderProse(c.folded!, 4));
    }
    return lines;
  }

  if (renderAs === 'accordion') {
    for (const c of children) {
      const flag = c.status && c.status !== 'functional' && c.status !== 'production'
        ? ` — **${escapeMdText(c.status)}**` : '';
      const body = c.folded?.definition ?? c.excerpt ?? '';
      const more = c.folded ? '' : `\n\n[Read more](../${slugify(c.section)}/${c.slug})`;
      lines.push(
        `<details class="accordion"><summary>${escapeMdText(c.title)}${flag}</summary>`,
        '',
        `${escapeMdText(body)}${more}`,
        '',
        '</details>',
        '',
      );
    }
    return lines;
  }

  for (const c of children) {
    const flag = c.status && c.status !== 'functional' && c.status !== 'production'
      ? ` — **${escapeMdText(c.status)}**`
      : '';
    if (c.folded) {
      // A leap is a link by DEFAULT, from its type, not by a per-page decision. In the app it
      // switches graphs; here the same node has to be somewhere a reader can actually go, and
      // before this it rendered as a heading saying "Click to explore" with nothing to click.
      const leap = leapLink(c.folded);
      lines.push(leap
        ? `### [${escapeMdText(c.title)}](${leap.href})${flag}`
        : `### ${escapeMdText(c.title)}${flag}`, '');
      if (c.folded.definition) lines.push(escapeMdText(c.folded.definition), '');
      lines.push(...renderDiagramFor(c.folded));
      lines.push(...renderSceneFor(c.folded));
      lines.push(...renderProse(c.folded, 4));
    } else {
      lines.push(`**[${escapeMdText(c.title)}](../${slugify(c.section)}/${c.slug})**${flag}`, '');
      if (c.excerpt) lines.push(escapeMdText(c.excerpt), '');
    }
  }
  return lines;
}

function renderBody(
  e: Entity,
  refs: Map<string, PageRef>,
  children: ChildRef[] = [],
  childHeading = 'Where to go next',
): string {
  const lines: string[] = [`# ${escapeMdText(e.title)}`, ''];

  // Status first — before the prose that would otherwise imply the thing exists.
  const status = e.literalProps.get(HAS_STATUS)?.[0];
  if (status && STATUS_BANNER[status]) lines.push(STATUS_BANNER[status], '');

  if (e.definition) { lines.push(escapeMdText(e.definition), ''); }

  // The picture goes directly under the sentence that introduces it, not at the bottom.
  lines.push(...renderDiagramFor(e));
  lines.push(...renderSceneFor(e));
  const ownLeap = leapLink(e);
  if (ownLeap) lines.push(`**[Open ${escapeMdText(ownLeap.title)} →](${ownLeap.href})**`, '');

  // The page's own prose, in reading order, BEFORE the route onward: a reader arriving here came
  // for this page, not for its table of contents.
  lines.push(...renderProse(e, 2));

  lines.push(...renderChildren(children, childHeading, e.renderAs));

  const iriKeys = [...e.iriProps.keys()]
    .filter((k) => !RENDER_ONLY_STRUCTURAL.has(k))
    .sort((a, b) =>
    humanize(localName(a)).localeCompare(humanize(localName(b))));
  const relatedBlocks: string[] = [];
  for (const p of iriKeys) {
    const targets = e.iriProps.get(p)!
      .map((t) => refs.get(t))
      .filter((r): r is PageRef => !!r)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!targets.length) continue;
    const label = humanize(localName(p));
    // "## Related" followed by "**Related**" was printing the same word twice on 87 pages.
    if (label !== 'Related') relatedBlocks.push(`**${escapeMdText(label)}**`, '');
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
  const parentOf = new Map<string, string>();
  const viaPartOf = new Set<string>();
  for (const e of entities) {
    const partOf = e.iriProps.get(PART_OF)?.find((t) => refs.has(t)) ?? null;
    const parent = (e.parent && refs.has(e.parent)) ? e.parent : partOf;
    if (!parent || parent === e.iri) continue;
    parentOf.set(e.iri, parent);
    if (parent === partOf && !e.parent) viaPartOf.add(parent);
  }
  const hasChildren = new Set([...parentOf.values()]);

  // WHICH ENTITIES ARE PAGES. Everything with children is (folding a junction would strand what
  // hangs off it), and everything else must carry enough prose to be worth a click. Because a
  // parent always has a child, a folded entity's parent always earns a page — so nothing can fold
  // into something that is not there.
  const byIriEarly = new Map(entities.map((e) => [e.iri, e]));
  const isPage = new Map<string, boolean>();
  for (const e of entities) {
    const host = parentOf.get(e.iri);
    const hostInlines = !!host && (byIriEarly.get(host)?.literalProps.get(RENDER_INLINE)?.[0] === 'true');
    isPage.set(e.iri, earnsPage(e, hasChildren.has(e.iri), parentOf.has(e.iri), hostInlines));
  }

  /*
   * Resolve every leap to the LEAD page of the graph it names — the lowest-ordered page in that
   * section, which is the section's own hub. In the app a leap switches graphs; on the site the
   * equivalent act is arriving at the top of that subject, not at an arbitrary page inside it.
   */
  const bySid = sectionsByStableId(fileQuads);
  const leadOf = new Map<string, Entity>();
  for (const e of entities) {
    // ONLY A PAGE CAN BE A LEAP TARGET. The first version took the lowest-ordered ENTITY, which
    // in Timeline & Ecosystem is a folded milestone with no page of its own — so the leap linked
    // to a URL that 404s. A folded entity is content on someone else's page, never a destination.
    if (!isPage.get(e.iri)) continue;
    const cur = leadOf.get(e.section);
    if (!cur || (order.get(e.iri) ?? 0) < (order.get(cur.iri) ?? 0)) leadOf.set(e.section, e);
  }
  for (const [sid, section] of bySid) {
    const lead = leadOf.get(section);
    if (lead) LEAP_TARGETS.set(sid, { section, slug: slugs.get(lead.iri)!, title: lead.title });
  }

  // A link to a folded entity must still go somewhere: it resolves to the page that now CONTAINS
  // it. Dropping the link instead would quietly delete a cross-reference the author wrote.
  const byIri = new Map(entities.map((e) => [e.iri, e]));
  for (const e of entities) {
    if (isPage.get(e.iri)) continue;
    const host = parentOf.get(e.iri);
    const hostRef = host ? refs.get(host) : undefined;
    if (hostRef) refs.set(e.iri, hostRef);
  }

  const childrenOf = new Map<string, ChildRef[]>();
  for (const e of entities) {
    const parent = parentOf.get(e.iri);
    if (!parent) continue;
    const stepRaw = e.literalProps.get(STEP_ORDER)?.[0];
    const step = stepRaw !== undefined ? parseInt(stepRaw, 10) : NaN;
    const arr = childrenOf.get(parent) ?? [];
    arr.push({
      slug: slugs.get(e.iri)!, section: e.section, title: e.title,
      excerpt: e.definition ? firstSentence(e.definition) : '',
      status: e.literalProps.get(HAS_STATUS)?.[0] ?? null,
      order: Number.isFinite(step) ? step : (e.navOrder ?? Number.MAX_SAFE_INTEGER),
      folded: isPage.get(e.iri) ? null : (byIri.get(e.iri) ?? null),
    });
    childrenOf.set(parent, arr);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  // The heading names the relation the author used: kpred:part-of is a sequence ("Steps"),
  // skos:broader is a taxonomy ("In this section"). Calling a section's pages "Steps" told a
  // reader they were following a procedure when they were browsing a category.
  const childHeadingFor = (iri: string) =>
    byIriEarly.get(iri)?.literalProps.get(CHILDREN_LABEL)?.[0]
    ?? (viaPartOf.has(iri) ? 'Steps' : 'In this section');

  /** The page a reference should land on: the entity itself, or the page that absorbed it. */
  const hostPageOf = (iri: string): string | null => {
    if (isPage.get(iri)) return iri;
    const host = parentOf.get(iri);
    return host && isPage.get(host) ? host : null;
  };

  // Only entities that earned a page become files. A folded entity's content is not lost — it is
  // rendered inside its parent by renderChildren, in the position it would have linked from.
  const pages: SitePage[] = entities.filter((e) => isPage.get(e.iri)).map((e) => ({
    iri: e.iri,
    title: e.title,
    slug: slugs.get(e.iri)!,
    section: e.section,
    order: order.get(e.iri)!,
    parent: (() => { const par = parentOf.get(e.iri); return par && isPage.get(par) ? par : null; })(),
    template: 'doc',
    status: 'published',
    nav: 'sidebar',
    excerpt: e.definition ? firstSentence(e.definition) : '',
    body: renderBody(e, refs, childrenOf.get(e.iri) ?? [], childHeadingFor(e.iri)),
    // Sorted by slug (not source IRI): `md-align`'s round trip reconstructs `related`
    // via synthetic `urn:kbase:concept/<slug>` IRIs and re-sorts alphabetically, so the
    // frontmatter list must already be in that order for the output to be stable.
    // Resolved through the fold: a `related` pointing at an entity that is now a SECTION of some
    // page must name that page, or the frontmatter links to a file that no longer exists. Deduped
    // (two folded siblings resolve to the same host) and self-references dropped.
    related: [...new Set(
      (e.iriProps.get(SKOS_RELATED) ?? [])
        .map((r) => hostPageOf(r))
        .filter((r): r is string => !!r && r !== e.iri),
    )].sort((a, b) => refs.get(a)!.slug.localeCompare(refs.get(b)!.slug)),
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
