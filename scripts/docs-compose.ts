#!/usr/bin/env npx tsx
/**
 * Composed docs generator (F27.3) — write the pages the website graph designs.
 *
 * `scripts/docs-pages.ts` publishes one page per ENTITY: 269 entities, 269 alphabetical files,
 * no editorial layer. This writes the pages `static/website.ttl` actually designs, each composing
 * the entities its declared datasets contain.
 *
 * BOTH GENERATORS ARE REVERSIBLE AND NEITHER TOUCHES HAND-AUTHORED CONTENT. Every file this
 * writes carries `generated: "docs-composed"`; every file docs-pages.ts writes carries
 * `generated: "docs-kb"`. Each prunes only its OWN tag, so:
 *
 *     npm run docs:compose   composed pages in,  per-entity pages out
 *     npm run docs:pages     per-entity pages back
 *
 * Pages with no `generated` tag (content/docs/welcome.md, content/releases/*) are never touched
 * by either. That is what makes trying this out safe rather than a one-way door.
 *
 * REFUSES TO DROP CONTENT. If the design would leave any entity unclaimed by a page and
 * unexcluded, this exits non-zero and writes nothing. Consolidating 269 pages into 8 is an
 * editorial act; doing it while silently losing entities is data loss with a tidier sidebar. Run
 * `npm run docs:consolidate` to see the orphan list before deciding.
 *
 * Usage: npm run docs:compose [--check] [--keep-per-entity]
 */

import { Parser, type Quad } from 'n3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { composePages, describeComposition, type SourceEntity } from '../src/lib/publish/page-composition';
import { readWebsiteGraph } from '../src/lib/publish/website-graph';
import { contentPath, pageToMarkdown } from '../src/lib/publish/site-export';
import { parsePageFile } from '../src/lib/publish/site-import';
import { type SitePage } from '../src/lib/rdf/page';
import { escapeMdText } from '../src/lib/publish/md-escape';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const STATIC_DIR = join(ROOT, 'static');
const CONTENT_DIR = join(ROOT, 'content');
const SITE_FILE = 'website.ttl';
/** This generator's own prune marker. Distinct from docs-pages.ts's "docs-kb". */
const COMPOSED_TAG = 'docs-composed';
const PER_ENTITY_TAG = 'docs-kb';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const KTYPE_NS = 'urn:kbase:type/';
const NAV_DOCS_NS = 'urn:reckons:docs/nav/';

const CORPUS = [
  'docs-triples-rdf.ttl', 'docs-llm.ttl', 'docs-use-cases.ttl', 'docs-features.ttl',
  'docs-integrations-tech.ttl', 'docs-tips-security.ttl', 'docs-timeline-ecosystem.ttl',
  'docs-architecture.ttl', 'docs-coding-workflow.ttl', 'docs-testing.ttl', 'starter-guide.ttl',
];

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function parseTtl(file: string): Quad[] {
  const path = join(STATIC_DIR, file);
  return existsSync(path) ? new Parser().parse(readFileSync(path, 'utf8')) : [];
}

/** Every publishable entity, one row per (entity, graph) so nothing is lost before composition. */
function readEntities(): SourceEntity[] {
  const out: SourceEntity[] = [];
  for (const graph of CORPUS) {
    const quads = parseTtl(graph);
    const types = new Map<string, string[]>();
    const titles = new Map<string, string>();
    const defs = new Map<string, string>();
    const parents = new Map<string, string>();

    for (const q of quads) {
      const s = q.subject.value;
      if (s.startsWith(NAV_DOCS_NS)) continue;
      if (q.predicate.value === RDF_TYPE && q.object.value.startsWith(KTYPE_NS)) {
        types.set(s, [...(types.get(s) ?? []), q.object.value.slice(KTYPE_NS.length)]);
      } else if (q.predicate.value === RDFS_LABEL) titles.set(s, q.object.value);
      else if (q.predicate.value === SKOS_DEFINITION) defs.set(s, q.object.value);
      else if (q.predicate.value === SKOS_BROADER) parents.set(s, q.object.value);
    }
    for (const [iri, t] of types) {
      out.push({
        iri, graph,
        title: titles.get(iri) ?? iri.split(/[/#]/).pop() ?? iri,
        definition: defs.get(iri) ?? '',
        types: [...t].sort(),
        parent: parents.get(iri),
      });
    }
  }
  // An entity asserted in two graphs is ONE entity on the page. Dedupe keeps the first, which is
  // the sub-graph's fuller definition rather than the hub's summary stub, matching the ownership
  // rule docs-pages.ts already applies via resolveHomeFiles.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.iri) ? false : (seen.add(e.iri), true)));
}

/**
 * Render one composed page's body.
 *
 * The page's PURPOSE leads, because that is the thing 269 auto-generated pages never had — a
 * reader could not tell why any of them existed. Entities are then grouped under the dataset they
 * came from, so a page drawing on several graphs shows where each part originated instead of
 * blending them into an unattributable list.
 */
function renderBody(
  page: { title: string; purpose: string; sections: Array<{ graph: string; entities: SourceEntity[] }> },
  datasetTitles: Map<string, string>,
): string {
  // Every piece of free text is escaped. The docs TTLs are prose written for humans, and the
  // first composed page failed to compile on a definition containing a literal {@html}.
  const out: string[] = [`# ${escapeMdText(page.title)}`, '', escapeMdText(page.purpose), ''];

  for (const section of page.sections) {
    // Only head the group when a page has MORE than one source — a single-source page does not
    // need a heading that repeats what the page already is.
    if (page.sections.length > 1) {
      out.push(`## ${escapeMdText(datasetTitles.get(section.graph) ?? section.graph)}`, '');
    }
    for (const entity of section.entities) {
      out.push(`### ${escapeMdText(entity.title)}`, '');
      if (entity.definition) out.push(escapeMdText(entity.definition), '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Remove every file carrying `tag`, and report how many. Never touches other tags. */
function pruneTagged(tag: string): number {
  let pruned = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const parsed = parsePageFile(readFileSync(full, 'utf8'));
      if (parsed.generated !== tag) continue; // hand-authored or another generator — never touch
      unlinkSync(full);
      pruned++;
    }
  };
  walk(CONTENT_DIR);
  return pruned;
}

/** Remove directories the prune emptied. Never removes CONTENT_DIR itself. */
function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name));
  }
  if (dir !== CONTENT_DIR && readdirSync(dir).length === 0) rmdirSync(dir);
}

function main(): void {
  const check = process.argv.includes('--check');
  const keepPerEntity = process.argv.includes('--keep-per-entity');

  const website = readWebsiteGraph(parseTtl(SITE_FILE));
  const entities = readEntities();
  // A page with no declared source is HAND-AUTHORED: the design says it exists so alignment can
  // see it, but nothing generates it and this must not overwrite what a person wrote.
  const composable = website.pages.filter((p) => p.sources.length > 0);
  const handAuthored = website.pages.filter((p) => p.sources.length === 0);
  const report = composePages(composable, entities, website.exclusions);

  console.log('');
  console.log(C.bold('compose docs') + C.dim(` — static/${SITE_FILE}`));
  console.log(`  ${describeComposition(report)}`);
  if (handAuthored.length > 0) {
    console.log(C.dim(`  ${handAuthored.length} hand-authored page(s) declared but not generated: `
      + handAuthored.map((p) => p.title).join(', ')));
  }

  if (website.problems.length > 0) {
    for (const p of website.problems) console.log(C.red(`  ${p}`));
  }

  // The guard that makes this safe to try: consolidation must not lose content.
  if (report.orphans.length > 0) {
    console.error('');
    console.error(C.red(C.bold(
      `  REFUSING: ${report.orphans.length} entities are claimed by no page and not excluded.`,
    )));
    console.error(C.dim('  Run `npm run docs:consolidate` for the list. Claim them or exclude them.'));
    process.exit(1);
  }

  const datasetTitles = new Map(website.datasets.map((d) => [d.file, d.title]));
  const files: Array<{ path: string; markdown: string }> = [];

  for (const composed of report.pages) {
    const page: SitePage = {
      iri: `https://reckons.ai/${composed.slug}`,
      title: composed.title,
      slug: composed.slug,
      section: composed.section,
      order: composed.order,
      parent: null,
      template: 'doc',
      status: 'published',
      nav: 'sidebar',
      excerpt: composed.purpose,
      body: renderBody(composed, datasetTitles),
      related: [], next: null, prev: null, date: null,
      generated: COMPOSED_TAG,
    };
    files.push({ path: contentPath(page), markdown: pageToMarkdown(page, new Map()) });
  }

  console.log('');
  for (const f of files) console.log(C.dim(`  ${f.path}`));

  if (check) {
    console.log('');
    console.log(C.dim('  --check: nothing written.'));
    return;
  }

  const prunedPerEntity = keepPerEntity ? 0 : pruneTagged(PER_ENTITY_TAG);
  const prunedComposed = pruneTagged(COMPOSED_TAG);
  // Emptied section folders are debris from the old one-page-per-entity layout; left behind they
  // make the content tree read as if those sections still exist.
  pruneEmptyDirs(CONTENT_DIR);

  for (const f of files) {
    const abs = join(ROOT, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.markdown, 'utf8');
  }

  console.log('');
  console.log(C.green(`  wrote ${files.length} composed pages`));
  console.log(C.dim(`  pruned ${prunedComposed} previously composed, ${prunedPerEntity} per-entity`));
  console.log(C.dim('  reverse with: npm run docs:pages   (hand-authored pages were never touched)'));
}

main();
