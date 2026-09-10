/**
 * What the graph ALREADY CLAIMS about the things this text is about.
 *
 * THE GAP THIS CLOSES. Extraction was grounded in two things: the words the graph uses
 * (`vocabulary-context`) and the entities it holds (`structural-context`). Both are about NAMES.
 * Neither tells the model what has already been SAID.
 *
 * So a follow-up note could only ever restate or append. Dictate "Orange Logic is an enterprise
 * DAM" today and "Orange Logic also handles rights management" tomorrow, and the second extraction
 * sees the anchor `orange-logic ("Orange Logic")` and nothing else — it cannot tell that it is
 * adding to a claim, cannot notice it is contradicting one, and cannot sharpen a rough earlier
 * fact into a better one. The diff catches exact duplicates afterwards, but by then the model has
 * already spent its one chance to produce a REFINEMENT instead of a near-copy.
 *
 * Matt, 2026-08-27: "pending extracted facts might need to be reformed, either with additional new
 * info... or with additional added content running its own extraction... Alignment is key to clear
 * and concise definition."
 *
 * PENDING CLAIMS ARE INCLUDED, AND MARKED. This is the delicate part. A follow-up note usually
 * arrives while the first note's facts are still unreviewed, so excluding pending claims would
 * miss the exact case this exists for. But an unreviewed claim is a PROPOSAL, and letting a model
 * treat it as established is how one mis-hearing becomes a convention that later notes agree with.
 * So every unconfirmed claim is labelled `(unconfirmed)` in the prompt and the model is told
 * plainly that it may contradict one.
 *
 * BUDGETED, BECAUSE CONTEXT IS NOT FREE. Only anchors the text actually seems to be about get
 * their claims listed, and each gets a handful. A graph with 6,000 facts must not turn every
 * dictated sentence into a 60k-token prompt.
 */

import type { Statement } from './types';
import type { StructuralAnchor } from './structural-context';

/** Claims listed per anchor. Enough to refine against, not enough to bury the source text. */
const CLAIMS_PER_ANCHOR = 6;

/** Anchors that get their claims listed at all. */
const ANCHOR_BUDGET = 8;

/** Objects longer than this are cut — a claim's SHAPE is what matters here, not its full prose. */
const MAX_OBJECT = 120;

export interface KnownClaim {
  subjectSlug: string;
  predicate: string;
  object: string;
  /** False for pending/refined statements — surfaced in the prompt, never hidden. */
  confirmed: boolean;
}

export interface ClaimsContext {
  claims: KnownClaim[];
  /** How many anchors had claims, for callers that want to report grounding coverage. */
  anchorsCovered: number;
}

function shortPredicate(iri: string): string {
  return iri.replace('urn:kbase:predicate/', '').replace(/^.*[/#]/, '');
}

function slugOf(iri: string): string {
  return iri.split('/').pop() ?? iri;
}

/**
 * Collect what is already claimed about the given anchors.
 *
 * Confirmed claims are listed first within each anchor: if the budget truncates, what survives
 * should be the settled knowledge rather than an unreviewed proposal.
 */
export function selectKnownClaims(
  statements: Statement[],
  anchors: StructuralAnchor[],
  options: { anchorBudget?: number; perAnchor?: number } = {},
): ClaimsContext {
  const anchorBudget = options.anchorBudget ?? ANCHOR_BUDGET;
  const perAnchor = options.perAnchor ?? CLAIMS_PER_ANCHOR;
  const wanted = anchors.slice(0, anchorBudget);
  if (wanted.length === 0) return { claims: [], anchorsCovered: 0 };

  const bySlug = new Map<string, Statement[]>();
  for (const st of statements) {
    if (st.s.kind !== 'iri') continue;
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    const slug = slugOf(st.s.value);
    const bucket = bySlug.get(slug);
    if (bucket) bucket.push(st);
    else bySlug.set(slug, [st]);
  }

  const claims: KnownClaim[] = [];
  let anchorsCovered = 0;

  for (const anchor of wanted) {
    const found = bySlug.get(anchor.slug);
    if (!found || found.length === 0) continue;

    const ordered = [...found].sort((a, b) => {
      const ac = a.status === 'confirmed' ? 0 : 1;
      const bc = b.status === 'confirmed' ? 0 : 1;
      return ac - bc;
    });

    let taken = 0;
    for (const st of ordered) {
      if (taken >= perAnchor) break;
      const object = st.o.value.slice(0, MAX_OBJECT);
      if (!object.trim()) continue;
      claims.push({
        subjectSlug: anchor.slug,
        predicate: shortPredicate(st.p.value),
        object,
        confirmed: st.status === 'confirmed',
      });
      taken++;
    }
    if (taken > 0) anchorsCovered++;
  }

  return { claims, anchorsCovered };
}

/**
 * The prompt section. Empty string when there is nothing to say, so a first ingest pays no bytes.
 *
 * The instruction is deliberately permissive about DISAGREEING. An extractor told only "here is
 * what is known" tends to echo it; the value of this block is the opposite — it exists so the
 * model can say something BETTER than what is already there, including that the text contradicts
 * an earlier claim.
 */
export function buildClaimsSection(ctx: ClaimsContext): string {
  if (ctx.claims.length === 0) return '';

  const bySubject = new Map<string, KnownClaim[]>();
  for (const c of ctx.claims) {
    const bucket = bySubject.get(c.subjectSlug);
    if (bucket) bucket.push(c);
    else bySubject.set(c.subjectSlug, [c]);
  }

  const lines: string[] = ['', 'ALREADY CLAIMED about these subjects:'];
  for (const [slug, claims] of bySubject) {
    lines.push(`${slug}:`);
    for (const c of claims) {
      lines.push(`  - ${c.predicate}: ${c.object}${c.confirmed ? '' : '   (unconfirmed)'}`);
    }
  }

  lines.push('');
  lines.push('Do NOT re-emit a claim that is already listed above — it adds nothing and creates a');
  lines.push('duplicate for a person to dismiss. DO emit a triple when the text says something');
  lines.push('MORE PRECISE than a listed claim, or something that CONTRADICTS one: a correction is');
  lines.push('the most valuable thing you can extract, and a claim marked (unconfirmed) is only a');
  lines.push('proposal nobody has checked, so contradicting it is expected and welcome.');

  return lines.join('\n');
}
