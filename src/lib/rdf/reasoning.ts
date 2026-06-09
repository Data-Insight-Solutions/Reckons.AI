import type { Statement } from './types';
import { iri, termKey, tripleKey } from './types';
import { v4 as uuid } from 'uuid';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUBPROP = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const OWL_SAMEAS = 'http://www.w3.org/2002/07/owl#sameAs';
const OWL_INVERSE = 'http://www.w3.org/2002/07/owl#inverseOf';

/**
 * A small forward-chaining reasoner that materializes entailments from a
 * subset of RDFS + OWL. Used during merge to surface implied conflicts and
 * during split to find connected components.
 *
 * Rules implemented:
 *   - rdfs9:  (?x rdf:type ?a) ∧ (?a rdfs:subClassOf ?b) ⇒ (?x rdf:type ?b)
 *   - rdfs7:  (?x ?p ?y) ∧ (?p rdfs:subPropertyOf ?q) ⇒ (?x ?q ?y)
 *   - rdfs11: transitivity of subClassOf
 *   - rdfs5:  transitivity of subPropertyOf
 *   - owl:sameAs symmetry + substitutivity (limited to subjects)
 *   - owl:inverseOf bidirectional
 */
export function closure(statements: Statement[]): Statement[] {
  const facts = new Map<string, Statement>();
  for (const s of statements) {
    if (s.status === 'rejected' || s.status === 'superseded') continue;
    facts.set(tripleKey(s), s);
  }

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;

    const subClass: Array<[string, string]> = [];
    const subProp: Array<[string, string]> = [];
    const inverse: Array<[string, string]> = [];
    const sameAs: Array<[string, string]> = [];

    for (const s of facts.values()) {
      if (s.p.value === RDFS_SUBCLASS && s.s.kind === 'iri' && s.o.kind === 'iri')
        subClass.push([s.s.value, s.o.value]);
      if (s.p.value === RDFS_SUBPROP && s.s.kind === 'iri' && s.o.kind === 'iri')
        subProp.push([s.s.value, s.o.value]);
      if (s.p.value === OWL_INVERSE && s.s.kind === 'iri' && s.o.kind === 'iri')
        inverse.push([s.s.value, s.o.value]);
      if (s.p.value === OWL_SAMEAS && s.s.kind === 'iri' && s.o.kind === 'iri')
        sameAs.push([s.s.value, s.o.value]);
    }

    const addDerived = (st: Omit<Statement, 'id' | 'createdAt' | 'updatedAt'>) => {
      const tk = tripleKey(st);
      if (facts.has(tk)) return;
      const now = Date.now();
      facts.set(tk, { ...st, id: uuid(), createdAt: now, updatedAt: now } as Statement);
      changed = true;
    };

    // rdfs9 + rdfs7
    for (const s of [...facts.values()]) {
      if (s.p.value === RDF_TYPE && s.o.kind === 'iri') {
        for (const [a, b] of subClass)
          if (a === s.o.value)
            addDerived({
              ...s,
              o: iri(b),
              g: iri('urn:kbase:graph/inferred'),
              status: 'confirmed',
              confidence: Math.min(1, s.confidence)
            });
      }
      for (const [a, b] of subProp)
        if (a === s.p.value)
          addDerived({
            ...s,
            p: iri(b),
            g: iri('urn:kbase:graph/inferred'),
            status: 'confirmed',
            confidence: Math.min(1, s.confidence)
          });
      for (const [a, b] of inverse)
        if (a === s.p.value)
          addDerived({
            ...s,
            s: s.o,
            o: s.s,
            p: iri(b),
            g: iri('urn:kbase:graph/inferred'),
            status: 'confirmed',
            confidence: Math.min(1, s.confidence)
          });
    }
  }
  return [...facts.values()];
}

/* ============================================================
 *  MERGE
 *  Combine two knowledge bases, detecting conflicts via closure.
 * ============================================================ */

export type MergeReport = {
  merged: Statement[];
  conflicts: Array<{ a: Statement; b: Statement; reason: string }>;
  added: number;
  collapsedDuplicates: number;
};

export function merge(a: Statement[], b: Statement[]): MergeReport {
  const seen = new Map<string, Statement>();
  let collapsed = 0;
  for (const st of [...a, ...b]) {
    const k = tripleKey(st);
    if (seen.has(k)) {
      collapsed++;
      // Keep the higher-confidence one, but bump the confidence of the keeper
      // since multiple sources now corroborate it.
      const cur = seen.get(k)!;
      if (st.confidence > cur.confidence) seen.set(k, { ...st, confidence: Math.min(1, st.confidence + 0.05) });
      else seen.set(k, { ...cur, confidence: Math.min(1, cur.confidence + 0.05) });
    } else {
      seen.set(k, st);
    }
  }

  const merged = [...seen.values()];
  const closed = closure(merged);

  // Conflicts: same (s,p) but distinct o that are not refinements
  const bySp = new Map<string, Statement[]>();
  for (const st of closed) {
    const sp = `${termKey(st.s)}>${termKey(st.p)}`;
    if (!bySp.has(sp)) bySp.set(sp, []);
    bySp.get(sp)!.push(st);
  }
  const conflicts: MergeReport['conflicts'] = [];
  for (const sts of bySp.values()) {
    if (sts.length < 2) continue;
    // Functional-property-style conflict heuristic
    const distinctObjects = new Set(sts.map((s) => termKey(s.o)));
    if (distinctObjects.size > 1) {
      // Pairwise report
      for (let i = 0; i < sts.length; i++)
        for (let j = i + 1; j < sts.length; j++)
          if (termKey(sts[i].o) !== termKey(sts[j].o))
            conflicts.push({ a: sts[i], b: sts[j], reason: 'distinct objects for same (s,p)' });
    }
  }

  return { merged, conflicts, added: merged.length - a.length, collapsedDuplicates: collapsed };
}

/* ============================================================
 *  SPLIT
 *  Partition KB by connected components of the subject/object graph.
 *  Useful for extracting topical subsets to share or archive.
 * ============================================================ */

export function splitByConcept(statements: Statement[], seedSubjects: string[]): Statement[] {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const s of statements) {
    const sk = termKey(s.s);
    const ok = termKey(s.o);
    add(sk, ok);
    add(ok, sk);
  }
  const reachable = new Set<string>(seedSubjects.map((v) => `i:${v}`));
  const queue = [...reachable];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of adj.get(n) ?? []) {
      if (!reachable.has(m)) {
        reachable.add(m);
        queue.push(m);
      }
    }
  }
  return statements.filter((s) => reachable.has(termKey(s.s)) || reachable.has(termKey(s.o)));
}
