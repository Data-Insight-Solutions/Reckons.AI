/**
 * Semantic Web export — structured data formats for LLM search optimisation.
 *
 * Two outputs:
 *
 *  JSON-LD  (.jsonld)
 *    Schema.org @graph document. Embeddable in a <script type="application/ld+json">
 *    tag on any web page. Understood by Google, Bing, and LLM crawlers alike.
 *    Entity types are mapped to Schema.org equivalents where known; unknown types
 *    fall back to schema:Thing. Predicates are similarly mapped where possible.
 *
 *  llms.txt  (.txt)
 *    Proposed standard (analogous to robots.txt) giving LLMs a concise, plain-text
 *    summary of the KB. See https://llmstxt.org for the spec.
 *    Format: a Markdown document at /llms.txt with a title, description, and
 *    entity/relation sections that an LLM can skim during crawl or RAG retrieval.
 *
 * Neither format includes pending or rejected statements — confirmed/refined only.
 */

import type { Statement, Source } from '../rdf/types';
import { BUILT_IN_TYPES, RDF_TYPE, RDFS_LABEL } from '../rdf/entity-types';
import { db } from './db';
import { scanForExportAdvisory } from '../safety/content-policy';

// ── Schema.org type mapping ───────────────────────────────────────────────────

const KB_TYPE_TO_SCHEMA: Record<string, string> = {
  'urn:kbase:type/Person':        'Person',
  'urn:kbase:type/Place':         'Place',
  'urn:kbase:type/Organization':  'Organization',
  'urn:kbase:type/Event':         'Event',
  'urn:kbase:type/CalendarEvent': 'Event',
  'urn:kbase:type/Document':      'Article',
  'urn:kbase:type/Concept':       'Thing',
  'urn:kbase:type/Product':       'Product',
  'urn:kbase:type/CreativeWork':  'CreativeWork',
  'urn:kbase:type/SoftwareApp':   'SoftwareApplication',
};

// ── Schema.org predicate mapping ─────────────────────────────────────────────

const KB_PRED_TO_SCHEMA: Record<string, string> = {
  'urn:kbase:predicate/birth-date':    'birthDate',
  'urn:kbase:predicate/occupation':    'hasOccupation',
  'urn:kbase:predicate/nationality':   'nationality',
  'urn:kbase:predicate/affiliation':   'affiliation',
  'urn:kbase:predicate/email':         'email',
  'urn:kbase:predicate/url':           'url',
  'urn:kbase:predicate/location':      'location',
  'urn:kbase:predicate/address':       'address',
  'urn:kbase:predicate/country':       'addressCountry',
  'urn:kbase:predicate/coordinates':   'geo',
  'urn:kbase:predicate/author':        'author',
  'urn:kbase:predicate/description':   'description',
  'urn:kbase:predicate/published-at':  'datePublished',
  'urn:kbase:predicate/founded':       'foundingDate',
  'urn:kbase:predicate/headquarters':  'address',
  'urn:kbase:predicate/industry':      'industry',
  'urn:kbase:predicate/member-count':  'numberOfEmployees',
  'urn:kbase:predicate/scheduled-at':  'startDate',
  'urn:kbase:predicate/ends-at':       'endDate',
  'urn:kbase:predicate/attendee':      'attendee',
  'urn:kbase:meta/scheduled-at':       'startDate',
  'urn:kbase:meta/ends-at':            'endDate',
  'urn:kbase:meta/location':           'location',
  'urn:kbase:meta/description':        'description',
  'urn:kbase:meta/url':                'url',
  'urn:kbase:meta/attendees':          'attendee',
  'urn:kbase:meta/organizers':         'organizer',
  'urn:kbase:predicate/name':          'name',
  'http://www.w3.org/2000/01/rdf-schema#label': 'name',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugLabel(iri: string): string {
  return (iri.split('/').pop() ?? iri).replace(/-/g, ' ');
}

function termValue(term: Statement['o']): string {
  if (term.kind === 'literal') return term.value;
  if (term.kind === 'iri') return term.value;
  return term.value;
}

function isConfirmed(s: Statement): boolean {
  return s.status === 'confirmed' || s.status === 'refined';
}

// ── JSON-LD export ────────────────────────────────────────────────────────────

interface JsonLdNode {
  '@id': string;
  '@type'?: string;
  [key: string]: unknown;
}

/**
 * Convert confirmed KB statements to a Schema.org JSON-LD @graph document.
 *
 * One node per unique subject IRI. Predicates are mapped to Schema.org where
 * known; unknown predicates are included as-is under their short slug key so
 * the document remains useful even with custom vocabularies.
 */
export function toJsonLd(
  statements: Statement[],
  opts: { kbTitle?: string; kbDescription?: string; siteUrl?: string } = {}
): object {
  const confirmed = statements.filter(isConfirmed);

  // Group by subject
  const bySubject = new Map<string, Statement[]>();
  for (const st of confirmed) {
    if (st.s.kind !== 'iri') continue;
    const k = st.s.value;
    if (!bySubject.has(k)) bySubject.set(k, []);
    bySubject.get(k)!.push(st);
  }

  const nodes: JsonLdNode[] = [];

  for (const [subjectIri, stmts] of bySubject) {
    const node: JsonLdNode = { '@id': subjectIri };

    for (const st of stmts) {
      const predIri = st.p.value;

      // rdf:type → @type
      if (predIri === RDF_TYPE && st.o.kind === 'iri') {
        node['@type'] = KB_TYPE_TO_SCHEMA[st.o.value] ?? slugLabel(st.o.value);
        continue;
      }

      const schemaKey = KB_PRED_TO_SCHEMA[predIri] ?? slugLabel(predIri);
      const val = st.o.kind === 'iri'
        ? { '@id': st.o.value }
        : st.o.value;

      // Merge multiple values for the same key into an array
      const existing = node[schemaKey];
      if (existing === undefined) {
        node[schemaKey] = val;
      } else if (Array.isArray(existing)) {
        (existing as unknown[]).push(val);
      } else {
        node[schemaKey] = [existing, val];
      }
    }

    // Ensure every node has at least a name derived from its IRI slug
    if (!node['name']) node['name'] = slugLabel(subjectIri);
    if (!node['@type']) node['@type'] = 'Thing';

    nodes.push(node);
  }

  // Content advisory metadata
  const advisory = scanForExportAdvisory(confirmed);

  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org/',
    '@graph': nodes,
  };

  if (opts.kbTitle || opts.kbDescription || opts.siteUrl) {
    doc['@id'] = opts.siteUrl ?? '';
    doc['name'] = opts.kbTitle ?? 'Knowledge Base';
    if (opts.kbDescription) doc['description'] = opts.kbDescription;
  }

  if (advisory.rating !== 'none') {
    doc['contentRating'] = advisory.rating === 'mature' ? 'mature' : 'restricted';
    doc['_contentAdvisory'] = advisory.flags.join('; ');
  }

  return doc;
}

// ── llms.txt export ───────────────────────────────────────────────────────────

/**
 * Generate an llms.txt document — a concise, LLM-readable Markdown summary of
 * the knowledge base. Intended to be served at /llms.txt on a web property so
 * AI crawlers and RAG systems can quickly understand the site's content.
 *
 * Format follows https://llmstxt.org:
 *   - H1: site/KB name
 *   - Blockquote: one-sentence description
 *   - H2 sections per entity type
 *   - Bullet list: entity name + key facts
 */
export function toLlmsTxt(
  statements: Statement[],
  opts: { kbTitle?: string; kbDescription?: string; siteUrl?: string } = {}
): string {
  const confirmed = statements.filter(isConfirmed);
  const title = opts.kbTitle ?? 'Knowledge Base';
  const desc  = opts.kbDescription ?? 'A structured knowledge base.';

  // Group by subject
  const bySubject = new Map<string, Statement[]>();
  for (const st of confirmed) {
    if (st.s.kind !== 'iri') continue;
    const k = st.s.value;
    if (!bySubject.has(k)) bySubject.set(k, []);
    bySubject.get(k)!.push(st);
  }

  // Group subjects by their Schema.org type
  const byType = new Map<string, Array<{ label: string; iri: string; facts: string[] }>>();

  for (const [subjectIri, stmts] of bySubject) {
    const typeStmt = stmts.find(s => s.p.value === RDF_TYPE && s.o.kind === 'iri');
    const schemaType = typeStmt
      ? (KB_TYPE_TO_SCHEMA[typeStmt.o.value] ?? slugLabel(typeStmt.o.value))
      : 'Thing';

    const labelStmt = stmts.find(s =>
      s.p.value === RDFS_LABEL ||
      s.p.value === 'urn:kbase:predicate/name' ||
      KB_PRED_TO_SCHEMA[s.p.value] === 'name'
    );
    const label = labelStmt
      ? termValue(labelStmt.o)
      : slugLabel(subjectIri);

    // Pick up to 4 interesting facts (skip type and label)
    const facts = stmts
      .filter(s => s.p.value !== RDF_TYPE && s.p.value !== RDFS_LABEL)
      .slice(0, 4)
      .map(s => {
        const predLabel = KB_PRED_TO_SCHEMA[s.p.value] ?? slugLabel(s.p.value);
        const objLabel  = s.o.kind === 'iri' ? slugLabel(s.o.value) : s.o.value;
        return `${predLabel}: ${objLabel}`;
      });

    if (!byType.has(schemaType)) byType.set(schemaType, []);
    byType.get(schemaType)!.push({ label, iri: subjectIri, facts });
  }

  // Content advisory
  const advisory = scanForExportAdvisory(confirmed);

  const lines: string[] = [
    `# ${title}`,
    '',
    `> ${desc}`,
    '',
  ];

  if (advisory.rating !== 'none') {
    lines.push(`> **Content Advisory:** This knowledge base contains ${advisory.rating} content (${advisory.flags.join(', ')}). Viewer discretion is advised.`, '');
  }

  if (opts.siteUrl) {
    lines.push(`Site: ${opts.siteUrl}`, '');
  }

  // Emit sections in a stable order: known Schema.org types first, then custom
  const knownOrder = ['Person', 'Organization', 'Place', 'Event', 'Article', 'Product', 'SoftwareApplication', 'CreativeWork', 'Thing'];
  const allTypes = [...byType.keys()];
  const orderedTypes = [
    ...knownOrder.filter(t => allTypes.includes(t)),
    ...allTypes.filter(t => !knownOrder.includes(t)),
  ];

  for (const type of orderedTypes) {
    const entities = byType.get(type)!;
    lines.push(`## ${type}s`);
    lines.push('');
    for (const { label, iri, facts } of entities.slice(0, 100)) {
      const factStr = facts.length > 0 ? ` (${facts.join('; ')})` : '';
      lines.push(`- [${label}](${iri})${factStr}`);
    }
    lines.push('');
  }

  // Relations section — key confirmed triples in plain English
  const relations = confirmed
    .filter(s =>
      s.s.kind === 'iri' && s.o.kind === 'iri' &&
      s.p.value !== RDF_TYPE && s.p.value !== RDFS_LABEL
    )
    .slice(0, 200);

  if (relations.length > 0) {
    lines.push('## Key Relations', '');
    for (const st of relations) {
      const sub  = slugLabel(st.s.value);
      const pred = KB_PRED_TO_SCHEMA[st.p.value] ?? slugLabel(st.p.value);
      const obj  = slugLabel(st.o.value);
      lines.push(`- ${sub} ${pred} ${obj}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Download helpers ──────────────────────────────────────────────────────────

function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function dateStr(): string {
  return new Date().toISOString().split('T')[0];
}

export async function exportJsonLd(opts: { kbTitle?: string; kbDescription?: string; siteUrl?: string } = {}): Promise<void> {
  const statements = await db.statements.toArray();
  const doc = toJsonLd(statements, opts);
  downloadText(JSON.stringify(doc, null, 2), `kb_${dateStr()}.jsonld`, 'application/ld+json');
}

export async function exportLlmsTxt(opts: { kbTitle?: string; kbDescription?: string; siteUrl?: string } = {}): Promise<void> {
  const statements = await db.statements.toArray();
  downloadText(toLlmsTxt(statements, opts), `llms_${dateStr()}.txt`, 'text/plain');
}
