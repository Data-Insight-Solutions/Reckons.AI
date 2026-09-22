import type { Source, Statement, Term } from './types';
import { iri, lit, termKey, isMetaPredicate } from './types';
import { RDF_TYPE, RDFS_LABEL } from './entity-types';
import { readSets, PREF_LABEL, MEMBER_PREDICATE } from './sets';

export const MAX_PROVENANCE_SOURCES = 5;
export const DEFAULT_PROVENANCE_SOURCES = 3;
export type ProvenanceReviewState = 'all' | 'confirmed' | 'pending';
/** View controls live with the page, so flipping perspectives preserves each filter set. */
export function createProvenanceControls() {
  return {
    presentation: 'graph' as 'graph' | 'folders' | 'list' | 'gallery',
    selectedIds: [] as string[], initialized: false, expanded: new Set<string>(),
    sourceKind: 'all', capturedSince: '', reviewState: 'all' as ProvenanceReviewState, search: '',
  };
}
const VIEW = 'urn:reckons:view:provenance/';
const active = (st: Statement) => st.status !== 'rejected' && st.status !== 'superseded';
const localName = (value: string) => value.split(/[/#]/).pop() || value;
const sourceIdOf = (st: Statement) => st.sourceId || '__unrecorded__';
const viewIri = (kind: string, id: string) => `${VIEW}${kind}/${encodeURIComponent(id)}`;

export interface ProvenanceGroup {
  key: string;
  sourceId: string;
  label: string;
  /** An existing set is a guide to grouping, never evidence of extraction. */
  setIri?: string;
  members: string[];
  statementIds: string[];
}

export interface ProvenanceSource {
  id: string;
  key: string;
  title: string;
  source?: Source;
  /** All retained records, including rejected/superseded history. */
  statements: Statement[];
  entityKeys: string[];
  groups: ProvenanceGroup[];
}

export interface ProvenanceIndex {
  sources: ProvenanceSource[];
  entities: Map<string, { term: Term; label: string; type?: string }>;
  statements: Map<string, Statement>;
}

/** Join recorded source IDs. A missing source record never becomes invented provenance. */
export function buildProvenanceIndex(statements: Statement[], sources: Source[]): ProvenanceIndex {
  const current = statements.filter(active);
  const entities: ProvenanceIndex['entities'] = new Map();
  const labels = new Map<string, string>();
  const types = new Map<string, string>();
  for (const st of current) {
    if ((st.p.value === RDFS_LABEL || st.p.value === PREF_LABEL) && st.o.kind === 'literal') {
      labels.set(termKey(st.s), st.o.value);
    }
    if (st.p.value === RDF_TYPE && st.o.kind === 'iri') types.set(termKey(st.s), st.o.value);
  }
  const termsOf = (st: Statement): Term[] => {
    const terms = [st.s];
    // Class/property declarations and provenance metadata do not create extracted entities.
    if (st.p.value !== RDF_TYPE && st.p.value !== MEMBER_PREDICATE && !isMetaPredicate(st.p.value)) {
      terms.push(st.o);
    }
    return terms.filter((t) => t.kind === 'iri' && !t.value.startsWith('urn:kbase:source/') &&
      !t.value.startsWith('urn:kbase:stmt/') && !t.value.startsWith(VIEW) &&
      !/^http:\/\/www\.w3\.org\/(1999|2000|2001|2002|2004)\//.test(t.value));
  };
  const bySource = new Map<string, ProvenanceSource>();
  const addSource = (id: string, source?: Source): ProvenanceSource => {
    const entry: ProvenanceSource = {
      id, key: termKey(iri(viewIri('source', id))), source,
      title: source?.title || (id === 'manual' ? 'Your own statements' :
        id === '__unrecorded__' ? 'Source not recorded' : `Source details unavailable (${id})`),
      statements: [], entityKeys: [], groups: [],
    };
    bySource.set(id, entry);
    return entry;
  };
  for (const source of sources) addSource(source.id, source);
  const keysBySource = new Map<string, Set<string>>();
  const statementsByEntity = new Map<string, Map<string, Set<string>>>();
  for (const st of statements) {
    const id = sourceIdOf(st);
    const source = bySource.get(id) ?? addSource(id);
    source.statements.push(st);
    if (!active(st)) continue;
    const keys = keysBySource.get(id) ?? new Set<string>();
    const entityStatements = statementsByEntity.get(id) ?? new Map<string, Set<string>>();
    for (const term of termsOf(st)) {
      const key = termKey(term);
      keys.add(key);
      entities.set(key, { term, label: labels.get(key) ?? localName(term.value), type: types.get(key) });
      const ids = entityStatements.get(key) ?? new Set<string>();
      ids.add(st.id);
      entityStatements.set(key, ids);
    }
    keysBySource.set(id, keys);
    statementsByEntity.set(id, entityStatements);
  }
  const sets = readSets(current.map((st) => ({
    subject: st.s, predicate: st.p,
    object: { value: st.o.value, termType: st.o.kind === 'literal' ? 'Literal' : 'NamedNode' },
  })));
  for (const source of bySource.values()) {
    const keys = keysBySource.get(source.id) ?? new Set<string>();
    source.entityKeys = [...keys];
    const grouped = new Set<string>();
    const addGroup = (id: string, label: string, members: string[], setIri?: string) => {
      const ids = new Set<string>();
      for (const key of members) {
        grouped.add(key);
        for (const statementId of statementsByEntity.get(source.id)?.get(key) ?? []) ids.add(statementId);
      }
      source.groups.push({
        key: termKey(iri(viewIri('group', JSON.stringify([source.id, id])))),
        sourceId: source.id, label, setIri, members, statementIds: [...ids],
      });
    };
    for (const set of sets) {
      const members = [...new Set(set.members.map((m) => termKey(iri(m.iri))))].filter((key) => keys.has(key));
      // Intersect with this source; never imply it produced the rest of the set.
      if (members.length >= 2) addGroup(set.iri, set.label, members, set.iri);
    }
    const rest = [...keys].filter((key) => !grouped.has(key));
    if (rest.length) addGroup('__remaining__', source.groups.length ? 'Other entities' : 'Extracted entities', rest);
  }
  return {
    sources: [...bySource.values()].sort((a, b) =>
      (b.source?.ingestedAt ?? 0) - (a.source?.ingestedAt ?? 0) || a.title.localeCompare(b.title)),
    entities, statements: new Map(statements.map((st) => [st.id, st])),
  };
}

export type ProvenanceNode =
  | { kind: 'source'; source: ProvenanceSource; label: string }
  | { kind: 'group'; group: ProvenanceGroup; label: string }
  | { kind: 'entity'; entityKey: string; label: string };

/** Filter contributions without rebuilding the sets or losing their labels and stable keys. */
export function filterProvenanceIndex(index: ProvenanceIndex, state: ProvenanceReviewState): ProvenanceIndex {
  if (state === 'all') return index;
  const statements = new Map([...index.statements].filter(([, st]) => state === 'pending'
    ? st.status === 'pending' : st.status === 'confirmed' || st.status === 'refined'));
  const sources = index.sources.map((source) => {
    const retained = source.statements.filter((st) => statements.has(st.id));
    const mentioned = new Set(retained.flatMap((st) => [termKey(st.s), termKey(st.o)]));
    const entityKeys = source.entityKeys.filter((key) => mentioned.has(key));
    const groups = source.groups.map((group) => ({
      ...group,
      members: group.members.filter((key) => mentioned.has(key)),
      statementIds: group.statementIds.filter((id) => statements.has(id)),
    })).filter((group) => group.members.length > 0 && group.statementIds.length > 0);
    return { ...source, statements: retained, entityKeys, groups };
  });
  const visible = new Set(sources.flatMap((source) => source.entityKeys));
  return { sources, statements, entities: new Map([...index.entities].filter(([key]) => visible.has(key))) };
}

/**
 * A display projection only. These log-level links are never persisted or sent to a reasoner.
 * Source groups summarize recorded entity mentions, not newly created entities or verified truth.
 * Original statements remain intact in the index for review and provenance inspection.
 */
export function projectProvenance(index: ProvenanceIndex, selectedIds: string[], expanded: Set<string>) {
  const ids = new Set(selectedIds.slice(0, MAX_PROVENANCE_SOURCES));
  const sources = index.sources.filter((s) => ids.has(s.id));
  const nodes = new Map<string, ProvenanceNode>();
  const statements: Statement[] = [];
  const edges: Statement[] = [];
  const make = (s: string, p: string, o: Term, source: ProvenanceSource): Statement => ({
    id: JSON.stringify([s, p, termKey(o)]), s: iri(s), p: iri(p), o,
    g: iri(`${VIEW}graph`), sourceId: source.id, confidence: 1, status: 'confirmed', altitude: 'log',
    createdAt: source.source?.ingestedAt ?? 0, updatedAt: source.source?.ingestedAt ?? 0,
  });
  const node = (key: string, info: ProvenanceNode, type: string | undefined, source: ProvenanceSource) => {
    if (nodes.has(key)) return;
    nodes.set(key, info);
    statements.push(make(key.slice(2), RDFS_LABEL, lit(info.label), source));
    if (type) statements.push(make(key.slice(2), RDF_TYPE, iri(type), source));
  };
  const edge = (a: string, b: string, label: string, source: ProvenanceSource) => {
    const st = make(a.slice(2), `${VIEW}${label}`, iri(b.slice(2)), source);
    statements.push(st);
    edges.push(st);
  };
  for (const source of sources) {
    node(source.key, { kind: 'source', source, label: source.title }, 'urn:kbase:type/Document', source);
    for (const group of source.groups) {
      const label = `${group.label} · ${group.members.length}`;
      node(group.key, { kind: 'group', group, label }, 'urn:kbase:type/EntitySet', source);
      edge(source.key, group.key, 'contributed-to', source);
      if (!expanded.has(group.key)) continue;
      for (const key of group.members) {
        const entity = index.entities.get(key)!;
        node(key, { kind: 'entity', entityKey: key, label: entity.label }, entity.type, source);
        edge(group.key, key, 'includes', source);
      }
    }
  }
  return { sources, nodes, statements, edges };
}

/** Only recorded joins count: a latest-run pointer alone does not attribute every fact to it. */
export function statementsForProvenanceNode(index: ProvenanceIndex, node: ProvenanceNode, selectedIds: string[]) {
  const sources = index.sources.filter((source) => selectedIds.includes(source.id));
  if (node.kind === 'source') return node.source.statements;
  if (node.kind === 'group') return node.group.statementIds.map((id) => index.statements.get(id)!);
  return sources.flatMap((source) => source.statements.filter((st) =>
    termKey(st.s) === node.entityKey || termKey(st.o) === node.entityKey));
}
