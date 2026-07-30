#!/usr/bin/env npx tsx
/**
 * Website alignment (F111) — observe the docs site, write its status graph, compare to the design.
 *
 * SCRIPT TIER: deterministic, zero tokens, no model. Three steps, in this order:
 *
 *   1. OBSERVE  read every content/**\/*.md through the same frontmatter parser the site uses
 *   2. RECORD   write static/website-status.ttl — the observed state, GENERATED, never hand-edited
 *   3. COMPARE  align it against static/website.ttl (the design) and report each divergence kind
 *
 * WHY A SEPARATE STATUS GRAPH rather than a report: it makes the site's actual state a queryable
 * thing that sits beside the design, exactly as reckons-production.ttl sits beside
 * reckons-roadmap.ttl. Two graphs you can diff beat two documents you have to read.
 *
 * ── THE HONEST LIMIT OF THIS OBSERVATION ────────────────────────────────────────────────────
 * This observes the CONTENT LAYER — the files the site is built from — not the rendered DOM. It
 * can tell you a page exists, where it is served, and what it claims to be. It CANNOT tell you
 * what a browser actually painted, so it does not satisfy F111 phase 2 and does not claim to.
 * The distinction matters: a page can exist, be correctly declared, and render broken.
 *
 * Every page carries its resolvable schema:url, so a reviewer reading the status graph can open
 * the live page. A site graph whose links you cannot follow is a site graph nobody checks.
 *
 * Usage: npm run website:align  [--write]   (--write updates the status graph; default reports only)
 */

import { Parser, type Quad } from 'n3';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parsePageFile } from '../../src/lib/publish/site-import';
import { readWebsiteGraph } from '../../src/lib/publish/website-graph';
import {
  alignWebsite, describeAlignment,
  type IntendedPage, type ObservedPage,
} from '../../src/lib/publish/website-alignment';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const CONTENT_DIR = join(ROOT, 'content');
const STATIC_DIR = join(ROOT, 'static');
const DESIGN_FILE = 'website.ttl';
const STATUS_FILE = join(STATIC_DIR, 'website-status.ttl');
/** Where the docs site actually serves from. Matches src/routes/docs/[...slug]. */
const SITE_BASE = 'https://reckons.ai/docs';

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Read the site as it actually is. The file path decides the URL — nothing is taken on trust. */
function observe(): ObservedPage[] {
  const pages: ObservedPage[] = [];
  for (const file of walk(CONTENT_DIR)) {
    const relPath = relative(ROOT, file).split('\\').join('/');
    // parsePageFile returns a typed page, not raw frontmatter — so the observation runs through
    // exactly the same reader the site itself uses rather than a second, drifting parse.
    const parsed = parsePageFile(readFileSync(file, 'utf8'));

    // The route param is the content-relative path (see routes/docs/_content/docs.ts), so the URL
    // is DERIVED from where the file actually sits rather than from what its frontmatter claims.
    const routePath = relPath.replace(/^content\//, '').replace(/\.md$/, '');

    pages.push({
      path: relPath,
      slug: parsed.slug || routePath.split('/').pop() || '',
      section: parsed.section,
      title: parsed.title,
      template: parsed.template,
      status: parsed.status,
      nav: parsed.nav,
      generated: parsed.generated || undefined,
      url: `${SITE_BASE}/${routePath}`,
    });
  }
  return pages;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Serialize the observed state as a graph, using the same standard terms as the design. */
function statusTurtle(pages: ObservedPage[]): string {
  const header = `@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix schema:  <https://schema.org/> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix status:  <https://reckons.ai/status/> .

# =============================================================================
# website-status.ttl — the docs site AS OBSERVED. GENERATED; do not hand-edit.
#
# Regenerate with: npm run website:align -- --write
#
# This is the "actual" half of F111, standing to static/website.ttl exactly as
# reckons-production.ttl stands to reckons-roadmap.ttl. It is DERIVED FROM THE OUTPUT: every
# page below was found by walking content/ and reading its frontmatter through the same parser
# the site uses, and every schema:url is derived from where the file actually sits rather than
# from what its frontmatter claims about itself.
#
# HONEST LIMIT: this observes the CONTENT LAYER, not the rendered DOM. It records that a page
# exists, where it is served, and what it claims to be. It does NOT record what a browser
# painted, so it does not satisfy F111 phase 2. A page can appear here, be correctly declared,
# and still render broken.
#
# Pages carry prov:wasDerivedFrom "docs-kb" when the docs generator produced them, and carry
# nothing when a human wrote them — which is the difference between a generated mess and pages
# somebody meant.
# =============================================================================

status:docs a schema:WebSite ;
    schema:name "Reckons.AI documentation (observed)" ;
    schema:url <${SITE_BASE}> ;
    dcterms:extent "${pages.length}" .

`;

  const body = pages.map((p) => {
    const id = p.path.replace(/^content\//, '').replace(/\.md$/, '').replace(/[^a-zA-Z0-9]+/g, '-');
    const lines = [
      `status:${id} a schema:WebPage ;`,
      `    schema:isPartOf status:docs ;`,
      `    schema:name "${esc(p.title)}" ;`,
      `    schema:url <${p.url}> ;`,
      `    dcterms:isPartOf "${esc(p.section)}" ;`,
      `    dcterms:source "${esc(p.path)}" ;`,
      `    schema:creativeWorkStatus "${esc(p.status)}" ;`,
    ];
    if (p.generated) lines.push(`    prov:wasDerivedFrom "${esc(p.generated)}" ;`);
    lines.push(`    dcterms:type "${esc(p.template)}" .`);
    return lines.join('\n');
  }).join('\n\n');

  return `${header}${body}\n`;
}

function parseDesign(): Quad[] {
  const path = join(STATIC_DIR, DESIGN_FILE);
  if (!existsSync(path)) return [];
  return new Parser().parse(readFileSync(path, 'utf8'));
}

function main(): void {
  const write = process.argv.includes('--write');
  const observed = observe();
  const design = readWebsiteGraph(parseDesign());

  const intended: IntendedPage[] = design.pages.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug ?? '',
    section: p.section,
    position: p.order,
    url: p.url,
  }));

  const alignment = alignWebsite(intended, observed);

  console.log('');
  console.log(C.bold('website alignment') + C.dim(` — static/${DESIGN_FILE} vs observed output`));
  console.log(C.dim(`  design: ${intended.length} pages   observed: ${observed.length} files`));
  console.log('');
  console.log(`  ${C.bold(describeAlignment(alignment))}`);
  console.log(C.dim(`  score basis: ${alignment.scoreBasis}`));

  if (design.problems.length > 0) {
    console.log('');
    console.log(C.yellow(`  ${design.problems.length} problem(s) in the design graph:`));
    for (const p of design.problems) console.log(C.yellow(`    ${p}`));
  }

  if (alignment.unbuilt.length > 0) {
    console.log('');
    console.log(C.yellow(C.bold(`  DESIGNED, NOT BUILT (${alignment.unbuilt.length}):`)));
    for (const p of alignment.unbuilt) {
      console.log(`    ${p.title.padEnd(28)} ${C.dim(p.url ?? '')}`);
    }
  }

  if (alignment.divergent.length > 0) {
    console.log('');
    console.log(C.red(C.bold(`  DISAGREEING (${alignment.divergent.length}):`)));
    for (const d of alignment.divergent) {
      console.log(`    ${d.slug} ${C.dim(d.field)}: design "${d.intended}" vs output "${d.observed}"`);
    }
  }

  if (alignment.undeclared.length > 0) {
    console.log('');
    console.log(C.yellow(C.bold(`  PUBLISHED, NOT DESIGNED (${alignment.undeclared.length}):`)));
    const bySection = new Map<string, ObservedPage[]>();
    for (const p of alignment.undeclared) {
      bySection.set(p.section, [...(bySection.get(p.section) ?? []), p]);
    }
    for (const [section, list] of [...bySection].sort((a, b) => b[1].length - a[1].length)) {
      const gen = list.filter((p) => p.generated).length;
      console.log(
        `    ${(section || '(no section)').padEnd(24)} ${String(list.length).padStart(3)}`
        + C.dim(gen === list.length ? '  all generated' : `  ${gen} generated`),
      );
      console.log(C.dim(`      e.g. ${list[0].url}`));
    }
  }

  if (write) {
    writeFileSync(STATUS_FILE, statusTurtle(observed), 'utf8');
    console.log('');
    console.log(C.green(`  wrote static/website-status.ttl (${observed.length} observed pages)`));
  } else {
    console.log('');
    console.log(C.dim('  run with --write to refresh static/website-status.ttl'));
  }

  console.log('');
  // Deliberately NOT non-zero yet. The gap is currently the whole point of the feature, and a
  // check that always fails is a check people learn to ignore. It becomes blocking once the
  // composed pages actually replace the generated ones.
  console.log(C.dim('  informational: this does not block. It becomes a gate once composition ships.'));
}

main();
