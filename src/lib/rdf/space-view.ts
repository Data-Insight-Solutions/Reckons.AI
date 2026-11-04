import type { Statement } from './types';
export type SpaceView = { id: string; name: string; entities: string[]; predicates: string[]; statementIds: string[] };
/** Display-only selection; an edge survives only when both its endpoints survive. */
export function projectSpaceView(statements: Statement[], options: { view?: SpaceView; limit?: number; focus?: string } = {}) {
  const roots = new Set(options.view?.entities ?? []);
  const pinned = new Set(roots); if (options.focus) pinned.add(options.focus);
  const predicates = new Set(options.view?.predicates ?? []), ids = new Set(options.view?.statementIds ?? []);
  const candidates = statements.filter(s => (!roots.size || roots.has(s.s.value) || (s.o.kind === 'iri' && roots.has(s.o.value)))
    && (!predicates.size || predicates.has(s.p.value) || /(?:label|prefLabel)$/.test(s.p.value))
    && (!ids.size || ids.has(s.id) || /(?:label|prefLabel)$/.test(s.p.value)));
  const degree = new Map<string, number>();
  for (const s of candidates) for (const t of [s.s, s.o]) if (t.kind === 'iri') degree.set(t.value, (degree.get(t.value) ?? 0) + 1);
  const ranked = [...degree.keys()].sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)) || degree.get(b)! - degree.get(a)! || a.localeCompare(b));
  const limit = options.limit === 0 ? Infinity : Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 80);
  const entities = new Set(ranked.slice(0, limit));
  const projected = candidates.filter(s => entities.has(s.s.value) && (s.o.kind !== 'iri' || entities.has(s.o.value)));
  const labels = statements.filter(s => entities.has(s.s.value) && /(?:label|prefLabel)$/.test(s.p.value));
  const result = [...new Map([...projected, ...labels].map(s => [s.id, s])).values()];
  return { statements: result, entities, candidateEntities: ranked.length, hiddenStatements: Math.max(0, statements.length - result.length) };
}
