/**
 * kb_entity_markdown — deterministic (no LLM) rendering of one KB entity as
 * a WebPage markdown document, built purely from its triples. See
 * `page-markdown.ts` for the frontmatter shape this stays compatible with.
 *
 * Deterministic by construction: same triples in → same markdown out, every
 * time. All grouping/ordering below is by predicate/object string sort, not
 * by triple-store iteration order.
 */

import type { Triple } from './kb-reader.js';
import { frontmatterToMarkdown, slugify, type PageFrontmatter } from './page-markdown.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** Extract local name from IRI (handles both / and # separators). */
function localName(iriStr: string): string {
  const hash = iriStr.lastIndexOf('#');
  if (hash >= 0) return iriStr.slice(hash + 1);
  const slash = iriStr.lastIndexOf('/');
  if (slash >= 0) return iriStr.slice(slash + 1);
  return iriStr;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** First sentence of a text block (falls back to the whole trimmed text). */
function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  return (m ? m[0] : text.trim()).trim();
}

/** Minimal interface entity-markdown needs from a KB reader — satisfied structurally by MultiKBReader. */
export interface EntityMarkdownSource {
  triplesAbout(iri: string, kb?: string): Triple[];
}

export interface EntityMarkdownResult {
  frontmatter: PageFrontmatter;
  body: string;
  markdown: string;
}

function targetLabel(targetIri: string, source: EntityMarkdownSource, kbName?: string): string | null {
  const targetTriples = source.triplesAbout(targetIri, kbName);
  const labelTriple = targetTriples.find(
    (t) => t.subject === targetIri && t.predicate === RDFS_LABEL && t.objectIsLiteral,
  );
  return labelTriple?.object ?? null;
}

/**
 * Render one entity's outbound triples as a WebPage markdown document:
 *   - rdfs:label → title (falls back to a title-cased IRI local name)
 *   - literal predicates whose name looks description-ish ("description",
 *     "desc") → a "## Description" section; first sentence → excerpt
 *   - remaining literal predicates → a "## Details" bullet list
 *   - relation (IRI-object) predicates → a "## Related" list of markdown
 *     links naming the target entities (by their own rdfs:label, if any)
 *
 * Always produces `status: 'draft'` — this is a proposal rendering, not a
 * publish action.
 */
export function entityToMarkdown(iri: string, source: EntityMarkdownSource, kbName?: string): EntityMarkdownResult {
  const triples = source.triplesAbout(iri, kbName).filter((t) => t.subject === iri);

  const labelTriple = triples.find((t) => t.predicate === RDFS_LABEL && t.objectIsLiteral);
  const title = labelTriple?.object ?? titleCase(localName(iri));
  const slug = slugify(labelTriple?.object ?? localName(iri));

  const literalTriples = triples.filter((t) => t.objectIsLiteral && t.predicate !== RDFS_LABEL);
  const relationTriples = triples.filter((t) => !t.objectIsLiteral && t.predicate !== RDF_TYPE);

  const sortByPredThenObj = (a: Triple, b: Triple) =>
    localName(a.predicate).localeCompare(localName(b.predicate)) || a.object.localeCompare(b.object);
  literalTriples.sort(sortByPredThenObj);
  relationTriples.sort(sortByPredThenObj);

  const descriptionTriples = literalTriples.filter((t) => /desc/i.test(localName(t.predicate)));
  const detailTriples = literalTriples.filter((t) => !descriptionTriples.includes(t));

  let excerpt = '';
  const bodyParts: string[] = [`# ${title}`];

  if (descriptionTriples.length > 0) {
    excerpt = firstSentence(descriptionTriples[0].object);
    bodyParts.push('## Description');
    bodyParts.push(descriptionTriples.map((t) => t.object).join('\n\n'));
  } else if (detailTriples.length > 0) {
    excerpt = firstSentence(detailTriples[0].object);
  }

  if (detailTriples.length > 0) {
    bodyParts.push('## Details');
    bodyParts.push(detailTriples.map((t) => `- **${localName(t.predicate)}**: ${t.object}`).join('\n'));
  }

  if (relationTriples.length > 0) {
    bodyParts.push('## Related');
    bodyParts.push(
      relationTriples
        .map((t) => {
          const label = targetLabel(t.object, source, kbName) ?? titleCase(localName(t.object));
          const targetSlug = slugify(label);
          return `- **${localName(t.predicate)}** → [${label}](${targetSlug})`;
        })
        .join('\n'),
    );
  }

  const body = bodyParts.join('\n\n') + '\n';

  const frontmatter: PageFrontmatter = {
    title,
    slug,
    order: 0,
    section: 'docs',
    template: 'doc',
    status: 'draft',
    nav: 'sidebar',
    excerpt,
  };

  return { frontmatter, body, markdown: frontmatterToMarkdown(frontmatter, body) };
}
