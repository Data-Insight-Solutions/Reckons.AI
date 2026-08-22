/**
 * Pure rules shared by the hand-written-surface and published-graph audits.
 *
 * Keep these rules outside the executable scripts so Vitest can exercise the exact
 * classification logic without running a sweep (or recursively launching Vitest).
 */

interface RdfTermLike {
  value: string;
}

export interface RdfQuadLike {
  subject: RdfTermLike;
  predicate: RdfTermLike;
}

const STATEMENT_METADATA_SUBJECT = 'urn:kbase:stmt/';
const STATEMENT_METADATA_PREDICATES = new Set([
  'http://www.w3.org/ns/prov#wasDerivedFrom',
  'http://purl.org/dc/terms/created',
]);
const CONTENT_ADVISORY_SUBJECT = 'urn:reckons:kb';
const CONTENT_ADVISORY_PREDICATE = 'urn:reckons:meta/contentAdvisory';

export interface PublishedGraphCounts {
  /** App statements represented by the export header. */
  statements: number;
  /** All RDF triples/quads the parser sees, including exporter metadata. */
  rdfQuads: number;
  /** Per-statement provenance decorations emitted after the asserted graph. */
  provenanceQuads: number;
  /** Derived graph-level advisory triples not included in the app-statement header. */
  advisoryQuads: number;
}

/**
 * Count the two different units in a lossy `toTurtle()` export honestly.
 *
 * The header is `kept.length`: one count per app Statement. With provenance enabled,
 * the exporter also writes `prov:wasDerivedFrom` and `dc:created` for each Statement.
 * N3 therefore parses three RDF triples for every one header statement. Those exporter
 * decorations (and the derived content-advisory triple) must not be compared with the
 * app-statement header or its logical truncation floor; their raw count remains diagnostic.
 */
export function countPublishedGraph(quads: readonly RdfQuadLike[]): PublishedGraphCounts {
  let provenanceQuads = 0;
  let advisoryQuads = 0;

  for (const quad of quads) {
    if (
      quad.subject.value.startsWith(STATEMENT_METADATA_SUBJECT)
      && STATEMENT_METADATA_PREDICATES.has(quad.predicate.value)
    ) {
      provenanceQuads++;
      continue;
    }
    if (
      quad.subject.value === CONTENT_ADVISORY_SUBJECT
      && quad.predicate.value === CONTENT_ADVISORY_PREDICATE
    ) {
      advisoryQuads++;
    }
  }

  return {
    statements: quads.length - provenanceQuads - advisoryQuads,
    rdfQuads: quads.length,
    provenanceQuads,
    advisoryQuads,
  };
}

const CLAUSE_BOUNDARIES = ['. ', '? ', '! ', '; ', ', but ', ', however ', '\n'];
const NEGATED_CAPABILITY_BEFORE = /(?:\b(?:do|does|did|can|could|will|would|should|may|might|must)\s+not\b|\b(?:don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|mustn't)\b|\bnever\b)[\s\S]{0,96}\b(?:allow|enable|expose|have|host|implement|include|mediate|offer|operate|provide|support|use)\b[\s\S]{0,48}$/i;
const ABSENT_STATUS_AFTER = /^(?:is|are|was|were|remains?)\s+(?:currently\s+)?not\s+(?:available|built|enabled|functional|implemented|live|operational|present|shipped|supported)\b|^(?:do|does)\s+not\s+exist(?:\s+(?:currently|today|yet))?\s*$/i;

function clauseBounds(text: string, start: number, end: number): { start: number; end: number } {
  let clauseStart = 0;
  let clauseEnd = text.length;

  for (const boundary of CLAUSE_BOUNDARIES) {
    const before = text.lastIndexOf(boundary, start - 1);
    if (before >= 0) clauseStart = Math.max(clauseStart, before + boundary.length);

    const after = text.indexOf(boundary, end);
    if (after >= 0) clauseEnd = Math.min(clauseEnd, after);
  }

  return { start: clauseStart, end: clauseEnd };
}

function mentionIsExplicitlyNegated(text: string, start: number, end: number): boolean {
  const bounds = clauseBounds(text, start, end);
  const before = text.slice(bounds.start, start);
  const after = text.slice(end, bounds.end).trimStart();

  // Direct noun-phrase absence: "without Graph Publication" / "no Graph Publication".
  if (/\b(?:no|without)\s+$/i.test(before)) return true;

  // A negated capability verb governs the mention: "we do not ... mediate graph publication".
  if (NEGATED_CAPABILITY_BEFORE.test(before)) return true;

  // Only absence/status predicates count after the name. "Graph Publication does not require
  // a server" still asserts the feature exists and must remain auditable as a built claim.
  return ABSENT_STATUS_AFTER.test(after);
}

/**
 * True when at least one mention asserts rather than explicitly negates the capability.
 * This is deliberately narrower than sentiment/semantic analysis: it only recognizes
 * ordinary auxiliary negation inside the same clause. Ambiguous prose remains a proposal
 * for human review.
 */
export function containsUnnegatedMention(text: string, needle: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let from = 0;

  while (from < lowerText.length) {
    const index = lowerText.indexOf(lowerNeedle, from);
    if (index < 0) return false;
    if (!mentionIsExplicitlyNegated(lowerText, index, index + lowerNeedle.length)) return true;
    from = index + lowerNeedle.length;
  }

  return false;
}
