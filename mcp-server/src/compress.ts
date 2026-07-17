/**
 * Context compression (F25 / kb:context-compression).
 *
 * Extracted from index.ts so it can be TESTED. It was previously private to the server
 * entrypoint, so the headline efficiency claim had no test behind it — and when one was
 * finally written, the claim did not survive it.
 *
 * MEASURED (2026-07-12, see compress.test.ts):
 *   vs grouped Turtle (what a real .ttl looks like) ... ~18% fewer tokens
 *   vs flat one-triple-per-line Turtle ............... ~29% fewer tokens
 *
 * The docs claimed "~60-70% token reduction". That is NOT true of this FORMAT. The large
 * saving in the kb_compress pipeline comes from SUBGRAPH SELECTION — returning a relevant
 * slice instead of the whole ~116k-token graph — not from the encoding. Conflating the two
 * overstated what this function does. The format is a modest, real win on top of selection;
 * selection is the headline.
 *
 * Format (entity-grouped, compact):
 *   # EntitySlug
 *     .predicate value
 *     .predicate "literal with spaces"
 *     < OtherEntity .refPredicate
 *
 * Entities are emitted in relevance order and truncated to a token budget.
 */
import type { Triple } from './kb-reader.js';

/** Rough token estimate (~1.33 tokens per word, matching the benchmark). */
export function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.33);
}

/** Local name of an IRI (handles both `/` and `#` separators). */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash >= 0) return iri.slice(slash + 1);
  return iri;
}

const slug = (iri: string): string => localName(iri) || iri;

/** `rdf:type` collapses to `a`; everything else uses its local name. */
function abbreviate(pred: string): string {
  const local = localName(pred);
  if (local === 'type' && pred.includes('rdf')) return 'a';
  return local;
}

/** Unquoted when numeric or a short single word; quoted otherwise. */
function fmtValue(obj: string, isLiteral: boolean): string {
  if (!isLiteral) return slug(obj);
  if (/^-?[\d.]+$/.test(obj)) return obj;
  if (/^\S+$/.test(obj) && obj.length < 40) return obj;
  return `"${obj}"`;
}

export interface CompressStats {
  entities: number;
  facts: number;
  tokens: number;
}

export interface CompressResult {
  text: string;
  stats: CompressStats;
}

/** Inbound references are capped per entity so a hub node cannot swamp the budget. */
export const MAX_INBOUND_REFS = 5;

export function compressTriples(
  triples: Triple[],
  entityOrder: string[],
  budget: number,
): CompressResult {
  const bySubject = new Map<string, Triple[]>();
  const asObject = new Map<string, Triple[]>();

  for (const t of triples) {
    const list = bySubject.get(t.subject) ?? [];
    list.push(t);
    bySubject.set(t.subject, list);

    if (!t.objectIsLiteral && t.object.startsWith('urn:')) {
      const refs = asObject.get(t.object) ?? [];
      refs.push(t);
      asObject.set(t.object, refs);
    }
  }

  const allEntities = new Set<string>(entityOrder);
  for (const iri of bySubject.keys()) allEntities.add(iri);
  const orderedEntities = [...allEntities].filter((iri) => bySubject.has(iri) || asObject.has(iri));

  const blocks: string[] = [];
  let totalTokens = 0;
  let factCount = 0;
  let entityCount = 0;

  for (const iri of orderedEntities) {
    const outbound = bySubject.get(iri) ?? [];
    const inbound = asObject.get(iri) ?? [];
    if (outbound.length === 0 && inbound.length === 0) continue;

    const lines: string[] = [`# ${slug(iri)}`];
    // Count this block's facts LOCALLY. The previous version incremented the running
    // factCount while building the block, then `break`-ed on the budget check below —
    // so the facts of the entity that was DROPPED were still counted, and stats.facts
    // over-reported. Only commit the count once the block is actually kept.
    let blockFacts = 0;

    const seen = new Set<string>();
    for (const t of outbound) {
      const key = `${t.predicate}\t${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  .${abbreviate(t.predicate)} ${fmtValue(t.object, t.objectIsLiteral)}`);
      blockFacts++;
    }

    for (const t of inbound.slice(0, MAX_INBOUND_REFS)) {
      const key = `${t.subject}\t${t.predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  < ${slug(t.subject)} .${abbreviate(t.predicate)}`);
      blockFacts++;
    }
    if (inbound.length > MAX_INBOUND_REFS) {
      lines.push(`  (+${inbound.length - MAX_INBOUND_REFS} more refs)`);
    }

    const block = lines.join('\n');
    const blockTokens = estimateTokens(block);

    // Always emit at least one entity, even if it alone busts the budget — an empty
    // context is useless, and the caller asked about *something*.
    if (totalTokens + blockTokens > budget && entityCount > 0) break;

    blocks.push(block);
    totalTokens += blockTokens;
    factCount += blockFacts;
    entityCount++;
  }

  return {
    text: blocks.join('\n'),
    stats: { entities: entityCount, facts: factCount, tokens: totalTokens },
  };
}
