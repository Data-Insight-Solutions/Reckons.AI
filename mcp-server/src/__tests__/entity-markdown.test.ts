import { describe, it, expect } from 'vitest';
import { entityToMarkdown, type EntityMarkdownSource } from '../entity-markdown.js';
import type { Triple } from '../kb-reader.js';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function lit(subject: string, predicate: string, object: string): Triple {
  return { subject, predicate, object, objectIsLiteral: true };
}
function rel(subject: string, predicate: string, object: string): Triple {
  return { subject, predicate, object, objectIsLiteral: false };
}

/** Small in-memory fixture KB — mirrors KBReader.triplesAbout's both-directions lookup. */
function fixtureSource(triples: Triple[]): EntityMarkdownSource {
  return {
    triplesAbout(iri: string): Triple[] {
      return triples.filter((t) => t.subject === iri || t.object === iri);
    },
  };
}

const REVIEW = 'urn:kbase:concept/review-workflow';
const COMPARE = 'urn:kbase:concept/compare-view';

function baseFixture(): Triple[] {
  return [
    rel(REVIEW, RDF_TYPE, 'urn:kbase:type/Feature'),
    lit(REVIEW, RDFS_LABEL, 'Review Workflow'),
    lit(REVIEW, 'urn:kbase:predicate/description', 'The review workflow has four tabs. Each tab handles a different statement lifecycle stage.'),
    lit(REVIEW, 'urn:kbase:predicate/has-status', 'functional'),
    rel(REVIEW, 'urn:kbase:predicate/depends-on', COMPARE),
    lit(COMPARE, RDFS_LABEL, 'Compare View'),
  ];
}

describe('entityToMarkdown', () => {
  it('renders label as title, description as excerpt + section, literals as details, relations as linked list', () => {
    const source = fixtureSource(baseFixture());
    const { frontmatter, markdown } = entityToMarkdown(REVIEW, source);

    expect(frontmatter.title).toBe('Review Workflow');
    expect(frontmatter.slug).toBe('review-workflow');
    expect(frontmatter.status).toBe('draft');
    expect(frontmatter.template).toBe('doc');
    expect(frontmatter.excerpt).toBe('The review workflow has four tabs.');

    expect(markdown).toContain('## Description');
    expect(markdown).toContain('The review workflow has four tabs. Each tab handles a different statement lifecycle stage.');
    expect(markdown).toContain('## Details');
    expect(markdown).toContain('**has-status**: functional');
    expect(markdown).toContain('## Related');
    expect(markdown).toContain('**depends-on** → [Compare View](compare-view)');

    // rdf:type and rdfs:label themselves must not leak into Details/Related.
    expect(markdown).not.toContain('**type**:');
    expect(markdown).not.toContain('**label**:');
  });

  it('is deterministic — two runs over the same triples produce byte-identical output', () => {
    const a = entityToMarkdown(REVIEW, fixtureSource(baseFixture()));
    const b = entityToMarkdown(REVIEW, fixtureSource(baseFixture()));
    expect(a.markdown).toBe(b.markdown);
    expect(a.frontmatter).toEqual(b.frontmatter);
  });

  it('is deterministic regardless of input triple order', () => {
    const forward = baseFixture();
    const reversed = [...baseFixture()].reverse();
    const a = entityToMarkdown(REVIEW, fixtureSource(forward));
    const b = entityToMarkdown(REVIEW, fixtureSource(reversed));
    expect(a.markdown).toBe(b.markdown);
  });

  it('falls back to the first literal sentence for the excerpt when no description-ish predicate exists', () => {
    const triples: Triple[] = [
      lit(REVIEW, RDFS_LABEL, 'Review Workflow'),
      lit(REVIEW, 'urn:kbase:predicate/has-status', 'functional. Additional detail follows.'),
    ];
    const { frontmatter, markdown } = entityToMarkdown(REVIEW, fixtureSource(triples));
    expect(frontmatter.excerpt).toBe('functional.');
    expect(markdown).not.toContain('## Description');
    expect(markdown).toContain('## Details');
  });

  it('falls back to a title-cased IRI local name when there is no rdfs:label, for both subject and relation targets', () => {
    const triples: Triple[] = [
      rel(REVIEW, 'urn:kbase:predicate/depends-on', 'urn:kbase:concept/some-other-thing'),
    ];
    const { frontmatter, markdown } = entityToMarkdown(REVIEW, fixtureSource(triples));
    expect(frontmatter.title).toBe('Review Workflow');
    expect(markdown).toContain('[Some Other Thing](some-other-thing)');
  });

  it('omits Description/Details/Related sections entirely when there are no matching triples', () => {
    const triples: Triple[] = [lit(REVIEW, RDFS_LABEL, 'Review Workflow')];
    const { markdown, frontmatter } = entityToMarkdown(REVIEW, fixtureSource(triples));
    expect(markdown).not.toContain('## Description');
    expect(markdown).not.toContain('## Details');
    expect(markdown).not.toContain('## Related');
    expect(frontmatter.excerpt).toBe('');
  });

  it('only renders outbound triples (where the entity is the subject), not inbound refs', () => {
    const triples: Triple[] = [
      lit(REVIEW, RDFS_LABEL, 'Review Workflow'),
      rel('urn:kbase:concept/other', 'urn:kbase:predicate/relates-to', REVIEW),
    ];
    const { markdown } = entityToMarkdown(REVIEW, fixtureSource(triples));
    expect(markdown).not.toContain('relates-to');
  });
});
