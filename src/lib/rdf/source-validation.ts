/**
 * Source validation — check a graph fact against the open web (mission-critical, F100).
 *
 * The thesis of Reckons.AI is that an unverifiable claim, made by the party it benefits, is not
 * evidence. This is the tool that acts on it: take a fact the graph asserts, search the web for
 * INDEPENDENT sources, and judge each as supporting, contradicting, or neither. Two outcomes both
 * matter, and the second is the rare one worth the whole feature:
 *
 *   • CORROBORATION — an independent source agrees. The fact earns provenance it did not have; a
 *     claim that was only ever self-asserted now has an outside witness.
 *   • CONFLICT — an independent source DISAGREES. This is the well-formed absence made visible: a
 *     contradiction the graph could not see from the inside. It is never auto-resolved — it is
 *     surfaced for review, because which source to believe is a judgment, not a lookup.
 *
 * This module is the DETERMINISTIC harness: it builds the query, and it turns a set of per-source
 * judgments into a verdict. The two judgment-tier plugins — WHERE to search (tavily.ts) and WHETHER
 * a source supports/contradicts (an LLM/NLI call) — are injected, so the harness runs in CI with
 * mocks and never hardcodes a provider. Validation PROPOSES (corroboration → a sourced suggestion;
 * conflict → a drift-warning for review); a human disposes.
 */

export interface FactRef {
  subject: string;
  predicate: string;
  object: string;
  /** Human labels for query building (fall back to the IRIs' local names). */
  subjectLabel?: string;
  predicateLabel?: string;
  objectLabel?: string;
}

export type Stance = 'supports' | 'contradicts' | 'neutral';

export interface SourceJudgment {
  url: string;
  title: string;
  snippet: string;
  stance: Stance;
  /** 0..1 confidence from the judge; used to break ties and rank evidence. */
  confidence: number;
}

export type FactVerdict = 'supported' | 'contradicted' | 'mixed' | 'unverified';

export interface ValidationResult {
  fact: FactRef;
  verdict: FactVerdict;
  supporting: SourceJudgment[];
  conflicting: SourceJudgment[];
  evidence: string;
}

const localName = (iri: string) => iri.split(/[/#:]/).pop() ?? iri;
const humanize = (s: string) => s.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

/**
 * A natural-language query for the fact — "<subject> <predicate> <object>", humanized. Deliberately
 * plain: we want independent pages that happen to speak to the claim, not pages that parrot our
 * exact triple. Quotes the object when it is a literal phrase so multi-word values stay together.
 */
export function buildValidationQuery(fact: FactRef): string {
  const s = fact.subjectLabel ?? humanize(localName(fact.subject));
  const p = fact.predicateLabel ?? humanize(localName(fact.predicate));
  // An IRI object is an entity name (humanize its local part, leave it bare); a LITERAL object is a
  // phrase (keep it verbatim, and quote it when multi-word so the search keeps the words together).
  const isIri = /^[a-z][a-z0-9+.-]*:/i.test(fact.object);
  const o = fact.objectLabel ?? (isIri ? humanize(localName(fact.object)) : fact.object);
  const objPart = !isIri && /\s/.test(o) && o.length <= 60 ? `"${o}"` : o;
  return `${s} ${p} ${objPart}`.trim();
}

/**
 * Fold per-source judgments into a verdict. Neutral sources are evidence of nothing and are
 * dropped. The interesting verdict is MIXED — independent sources disagree — because that is the
 * contradiction the graph could not see itself, and the one a human most needs to see.
 */
export function verdictFromJudgments(judgments: SourceJudgment[]): {
  verdict: FactVerdict;
  supporting: SourceJudgment[];
  conflicting: SourceJudgment[];
} {
  const byConf = (a: SourceJudgment, b: SourceJudgment) => b.confidence - a.confidence;
  const supporting = judgments.filter((j) => j.stance === 'supports').sort(byConf);
  const conflicting = judgments.filter((j) => j.stance === 'contradicts').sort(byConf);

  let verdict: FactVerdict;
  if (supporting.length && conflicting.length) verdict = 'mixed';
  else if (supporting.length) verdict = 'supported';
  else if (conflicting.length) verdict = 'contradicted';
  else verdict = 'unverified';

  return { verdict, supporting, conflicting };
}

function summarize(fact: FactRef, verdict: FactVerdict, supporting: SourceJudgment[], conflicting: SourceJudgment[]): string {
  const claim = buildValidationQuery(fact);
  switch (verdict) {
    case 'supported':
      return `${supporting.length} independent source(s) support "${claim}".`;
    case 'contradicted':
      return `${conflicting.length} independent source(s) CONTRADICT "${claim}" — review before trusting it.`;
    case 'mixed':
      return `Sources DISAGREE on "${claim}": ${supporting.length} support, ${conflicting.length} contradict. A human must decide which to believe.`;
    default:
      return `No independent source spoke to "${claim}". Still only self-asserted.`;
  }
}

export interface ValidationPlugins {
  /** WHERE to look — e.g. tavily.ts. Returns candidate sources for a query. */
  search: (query: string) => Promise<{ url: string; title: string; content: string }[]>;
  /** WHETHER a source supports/contradicts the fact — an LLM/NLI call. */
  judge: (fact: FactRef, source: { url: string; title: string; content: string }) => Promise<{ stance: Stance; confidence: number }>;
}

/**
 * Validate one fact end to end: search → judge each source → fold into a verdict. Never throws on
 * an empty result — an unsearchable or unjudgeable fact simply comes back 'unverified'. The caller
 * decides what to emit (corroboration → a sourced suggestion; conflict → a drift-warning for review).
 */
export async function validateFact(fact: FactRef, plugins: ValidationPlugins, maxSources = 5): Promise<ValidationResult> {
  const sources = (await plugins.search(buildValidationQuery(fact)).catch(() => [])).slice(0, maxSources);
  const judgments: SourceJudgment[] = [];
  for (const src of sources) {
    try {
      const { stance, confidence } = await plugins.judge(fact, src);
      judgments.push({ url: src.url, title: src.title, snippet: src.content.slice(0, 280), stance, confidence });
    } catch {
      /* a source we cannot judge is not evidence either way — skip it */
    }
  }
  const { verdict, supporting, conflicting } = verdictFromJudgments(judgments);
  return { fact, verdict, supporting, conflicting, evidence: summarize(fact, verdict, supporting, conflicting) };
}
