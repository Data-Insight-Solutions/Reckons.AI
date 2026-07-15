/**
 * Question router — phase 1 (F91 / kb:qr-relevance): who could answer this?
 *
 * F80 taught an agent to ask THE graph it is in. This answers the outward version: a question
 * the local graph cannot settle should go to the graph most RELATED to it — the one whose
 * knowledge actually overlaps the question's subject. "Who, in the world, could answer this?"
 * is turned from a hunch into a ranking.
 *
 * The router's entire value is picking WHO. Broadcasting a question to every graph is spam and,
 * across owners, a privacy leak (a proposed Reckoning is private — F91). So this scores each
 * candidate graph by relatedness and ranks them; the caller sends only to the top.
 *
 * DETERMINISTIC, no model. The signals are all countable:
 *   - does the candidate KNOW THE SUBJECT already? (the strongest signal — it has facts about
 *     the very thing being asked about)
 *   - does it USE THE PREDICATE the question is on? (it speaks this kind of fact)
 *   - does it share the subject's NEIGHBOURHOOD — the entities and terms around the subject in
 *     the source graph? (it is about the same corner of the world)
 *
 * Embedding-based semantic relatedness is a later refinement; this first cut needs none, and
 * "the graph that already has facts about this exact entity" is a genuinely strong answer to
 * "who could answer this" without one.
 */
import type { Statement } from './types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export interface Question {
  /** The entity the question is about. */
  subject: string;
  /** The predicate whose object is unknown. */
  predicate: string;
  /**
   * The subject's neighbourhood in the SOURCE graph — the IRIs it is connected to. Lets the
   * router find graphs about the same corner of the world even when they do not have the exact
   * subject IRI. Optional; derivable with `questionContext`.
   */
  contextIris?: string[];
  /** Salient words from the subject's labels/neighbours — a cheap semantic hook. Optional. */
  contextTerms?: string[];
}

export interface CandidateGraph {
  id: string;
  name?: string;
  statements: Statement[];
}

export interface RoutingScore {
  id: string;
  name?: string;
  /** 0..1 — higher means more likely to be able to answer. */
  score: number;
  signals: {
    knowsSubject: boolean;
    usesPredicate: boolean;
    contextOverlap: number; // 0..1 fraction of the question's context found
  };
  /** Human-readable why, for the "ask another graph" UI. */
  reason: string;
}

/** Build a question's context from the source graph: the subject's neighbour IRIs + label terms. */
export function questionContext(subject: string, predicate: string, source: Statement[]): Question {
  const iris = new Set<string>();
  const terms = new Set<string>();
  for (const s of source) {
    const touchesSubject = s.s.value === subject || s.o.value === subject;
    if (!touchesSubject) continue;
    for (const t of [s.s, s.o]) {
      if (t.value === subject) continue;
      if (t.kind === 'iri') iris.add(t.value);
      else for (const w of t.value.toLowerCase().split(/\W+/)) if (w.length > 3) terms.add(w);
    }
  }
  return { subject, predicate, contextIris: [...iris], contextTerms: [...terms] };
}

/**
 * Score and rank candidate graphs by how likely each is to answer the question.
 *
 * The source graph itself, if passed as a candidate, is excluded — a question is by definition
 * one the source could not answer, so routing it back is noise.
 */
export function routeQuestion(question: Question, candidates: CandidateGraph[]): RoutingScore[] {
  const ctxIris = new Set(question.contextIris ?? []);
  const ctxTerms = new Set(question.contextTerms ?? []);

  const scores: RoutingScore[] = [];
  for (const g of candidates) {
    // Index the candidate once.
    const iris = new Set<string>();
    const predicates = new Set<string>();
    const labelWords = new Set<string>();
    for (const s of g.statements) {
      if (s.status === 'rejected' || s.status === 'superseded') continue;
      if (s.s.kind === 'iri') iris.add(s.s.value);
      if (s.o.kind === 'iri') iris.add(s.o.value);
      predicates.add(s.p.value);
      if (s.p.value === RDFS_LABEL && s.o.kind === 'literal') {
        for (const w of s.o.value.toLowerCase().split(/\W+/)) if (w.length > 3) labelWords.add(w);
      }
    }

    const knowsSubject = iris.has(question.subject);
    const usesPredicate = predicates.has(question.predicate);

    // Neighbourhood overlap: how much of the subject's context this graph also contains.
    let ctxHits = 0;
    for (const iri of ctxIris) if (iris.has(iri)) ctxHits++;
    for (const term of ctxTerms) if (labelWords.has(term)) ctxHits++;
    const ctxTotal = ctxIris.size + ctxTerms.size;
    const contextOverlap = ctxTotal ? ctxHits / ctxTotal : 0;

    // Weights: knowing the subject is by far the strongest answer to "who could answer this".
    const score =
      (knowsSubject ? 0.55 : 0) +
      (usesPredicate ? 0.15 : 0) +
      contextOverlap * 0.3;

    const reasons: string[] = [];
    if (knowsSubject) reasons.push('already has facts about this exact entity');
    if (contextOverlap > 0) reasons.push(`shares ${Math.round(contextOverlap * 100)}% of the subject's neighbourhood`);
    if (usesPredicate && !knowsSubject) reasons.push('speaks this kind of fact');
    const reason = reasons.length ? reasons.join('; ') : 'no meaningful overlap — unlikely to help';

    scores.push({ id: g.id, name: g.name, score: Math.min(1, score), signals: { knowsSubject, usesPredicate, contextOverlap }, reason });
  }

  // Best first; drop the source-identity and zero-overlap candidates from the front by sorting.
  return scores
    .filter((s) => s.id !== '__source__')
    .sort((a, b) => b.score - a.score);
}

/** The graphs worth actually throwing the question to — a threshold, so we do not spam. */
export function addressees(scores: RoutingScore[], minScore = 0.15, max = 3): RoutingScore[] {
  return scores.filter((s) => s.score >= minScore).slice(0, max);
}

const ANSWERS_QUESTIONS = 'urn:kbase:predicate/answers-questions';

/**
 * Has this graph OPTED IN to answering routed questions? (F91 — reach by consent, not discovery.)
 *
 * A graph declares it by carrying `kpred:answers-questions "true"`. Reach must grow by consent:
 * a graph that has not said "you may ask me" is never addressed, however related it is. A
 * proposed Reckoning gathering facts privately must not leak a question to a graph whose owner
 * did not agree to receive it — that is the difference between routing and trespass.
 */
export function graphAnswersQuestions(g: CandidateGraph): boolean {
  return g.statements.some(
    (s) => s.p.value === ANSWERS_QUESTIONS && s.o.value === 'true' && s.status !== 'rejected' && s.status !== 'superseded',
  );
}

/** Keep only candidates that have opted in. The source graph (id '__source__') is always kept
 *  out by routeQuestion; this filters the REACHABLE set to consenting graphs. */
export function optedInCandidates(candidates: CandidateGraph[]): CandidateGraph[] {
  return candidates.filter(graphAnswersQuestions);
}
