/**
 * buildKBContext — summarize a graph into the compact KBContext the chat/voice/explore panels feed
 * to an LLM. Extracted from THREE copies (ExplorePanel, ShellyVoice, TurtleChatPanel) that the
 * code-sprawl detector caught, where one copy (ExplorePanel) had quietly improved (degree-based hub
 * ordering) while the others did not — the exact drift a shared module prevents.
 *
 * The two behavioural differences between the copies are preserved as OPTIONS, so this consolidation
 * changes NOTHING for any caller:
 *   - `hubFirst`      — ExplorePanel surfaces high-degree hubs first; the chat panels sort untyped
 *                       entities first (so Shelly sees them in the sample).
 *   - `includeDegree` — ExplorePanel prefixes each entity's predicate list with `degree:N`.
 *
 * Decoupled from the stores: the caller passes the resolved statements, a source count, and a
 * typeLabelOf resolver — so this is a pure, testable function, not three copies wired to accessors.
 */
import type { Statement } from './types';
import type { KBContext } from '$lib/types/turtle-chat';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export interface BuildKBContextOpts {
  /** Confirmed statements — the graph the context describes. */
  confirmed: Statement[];
  /** All statements — used only for the manual-statement count. */
  all: Statement[];
  /** Number of sources in the graph. */
  sourceCount: number;
  /** Resolve a type IRI to its human label (from the type map), or null. */
  typeLabelOf: (typeIri: string) => string | null;
  /** Sort high-degree hubs to the top (ExplorePanel); default false = untyped-first (chat panels). */
  hubFirst?: boolean;
  /** Prefix each entity's predicates with `degree:N` and cap at 3 (ExplorePanel); default false = 4 preds. */
  includeDegree?: boolean;
}

export function buildKBContext(o: BuildKBContextOpts): KBContext {
  const { confirmed: stmts, all: allStmts, sourceCount, typeLabelOf, hubFirst = false, includeDegree = false } = o;

  const bySubject = new Map<string, Statement[]>();
  const typedIris = new Set<string>();
  const typeDefIris = new Set<string>();
  const objectOnlyIris = new Set<string>();

  for (const st of stmts) {
    if (st.s.kind === 'iri') {
      if (!bySubject.has(st.s.value)) bySubject.set(st.s.value, []);
      bySubject.get(st.s.value)!.push(st);
      if (st.p.value === RDF_TYPE) typedIris.add(st.s.value);
    }
    if (st.o.kind === 'iri') {
      if (st.p.value === RDF_TYPE) typeDefIris.add(st.o.value);
      else if (!bySubject.has(st.o.value)) objectOnlyIris.add(st.o.value);
    }
  }
  for (const iri of typeDefIris) objectOnlyIris.delete(iri);
  for (const iri of bySubject.keys()) objectOnlyIris.delete(iri);

  const untypedEntityCount =
    [...bySubject.keys()].filter((iri) => !typedIris.has(iri)).length + objectOnlyIris.size;
  const manualStatementCount = allStmts.filter(
    (s) => (s.status === 'confirmed' || s.status === 'refined') && s.sourceId === 'manual',
  ).length;

  // Degree (edge count) per entity — always computed; used for hubFirst sort and the degree prefix.
  const degrees = new Map<string, number>();
  for (const st of stmts) {
    if (st.s.kind === 'iri') degrees.set(st.s.value, (degrees.get(st.s.value) ?? 0) + 1);
    if (st.o.kind === 'iri') degrees.set(st.o.value, (degrees.get(st.o.value) ?? 0) + 1);
  }

  const sorted = [...bySubject.entries()]
    .sort(([iriA, a], [iriB, b]) => {
      if (hubFirst) {
        const byDegree = (degrees.get(iriB) ?? 0) - (degrees.get(iriA) ?? 0);
        if (byDegree !== 0) return byDegree;
      }
      const aUntyped = !typedIris.has(iriA) ? -1 : 0;
      const bUntyped = !typedIris.has(iriB) ? -1 : 0;
      return aUntyped - bUntyped || b.length - a.length;
    })
    .slice(0, 20);

  const typesPresent = new Set<string>();
  const sampleEntities: KBContext['sampleEntities'] = [];
  for (const [iri, sts] of sorted) {
    const typeStmt = sts.find((s) => s.p.value === RDF_TYPE);
    const typeLabel = typeStmt?.o.value ? typeLabelOf(typeStmt.o.value) : null;
    if (typeLabel) typesPresent.add(typeLabel);

    const labelStmt = sts.find((s) => s.p.value === RDFS_LABEL);
    const label = labelStmt?.o.value ?? iri.split('/').pop() ?? iri;

    const preds = sts.filter((s) => s.p.value !== RDF_TYPE);
    const predStrs = (includeDegree ? preds.slice(0, 3) : preds.slice(0, 4)).map(
      (s) => `${s.p.value.split('/').pop()} → ${s.o.value.slice(0, 40)}`,
    );

    sampleEntities.push({
      iri,
      label,
      type: typeLabel,
      predicates: includeDegree ? [`degree:${degrees.get(iri) ?? 0}`, ...predStrs] : predStrs,
    });
  }

  return {
    statementCount: stmts.length,
    sourceCount,
    typesPresent: [...typesPresent],
    untypedEntityCount,
    manualStatementCount,
    sampleEntities,
  };
}
