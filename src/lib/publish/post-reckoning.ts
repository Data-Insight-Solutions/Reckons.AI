/**
 * Drafting a post as a RECKONING (F27 + F51 + F112) — target in, grounded draft out.
 *
 * `/publish` began as a title/section/body form, which is a CMS — and Sveltia already exists, so
 * a form is the one thing this product should not be competing on. What a CMS cannot do is
 * guarantee that every sentence it publishes traces to a fact somebody confirmed. That is F51's
 * grounding constraint, and it is the whole reason to draft here instead of anywhere else.
 *
 * So the flow becomes Situation-Target-Proposal:
 *
 *   SITUATION  which graphs are in scope. A SELECTION, not prose (F112) — the author is uniquely
 *              qualified to say what matters, not to retype what the graph already says.
 *   TARGET     what this post should achieve, written by the author. The one genuinely creative
 *              input, and the only free text in the loop.
 *   PROPOSAL   a draft where every sentence cites the statements it rests on, validated by
 *              `generation-grounding.ts` before the author ever sees it as acceptable.
 *
 * WHAT THIS MODULE IS NOT. It does not call a model — `buildPostBrief` produces the prompt and
 * `parseDraftedPost` reads the reply, so the backend stays the caller's choice and the contract
 * stays testable without a network. That split is also what lets the grounding rule be tested
 * against hand-written fixtures rather than against whatever a model happened to say today.
 *
 * THE UNGROUNDED SENTENCE IS THE POINT. A model will produce fluent, plausible prose that cites
 * nothing; the value here is catching it and SHOWING it, not quietly publishing it. A draft with
 * violations is still returned — the author may want the phrasing — but it is returned marked.
 */

import { ETHICS_PREAMBLE } from '$lib/safety/content-policy';
import {
  statementsById, validateGeneration,
  type GroundedSentence, type GroundingViolation,
} from '$lib/rdf/generation-grounding';
import type { Statement } from '$lib/rdf/types';
import type { PostDraft } from './post-authoring';

export interface PostTarget {
  /** What the post should achieve. The author's words — the only free text in the loop. */
  goal: string;
  /** Who it is for. Shapes register, not content. */
  audience?: string;
  /** Rough length. A hint to the model, never a hard cap enforced here. */
  approxWords?: number;
}

export interface PostScope {
  /** Statements the draft may draw on — already narrowed to the chosen graphs. */
  statements: Statement[];
  /** Human-readable names of the graphs in scope, for the brief and for provenance. */
  graphNames: string[];
}

export class PostTargetError extends Error {}

/** Facts a draft is allowed to rest on: confirmed or refined, and nothing else. */
export function groundableStatements(statements: Statement[]): Statement[] {
  return statements.filter((s) => s.status === 'confirmed' || s.status === 'refined');
}

/**
 * Build the drafting brief.
 *
 * Statements are listed WITH their ids because the model must cite them back; a brief that shows
 * facts without identifiers can only produce prose nobody can check, which is the failure this
 * whole path exists to avoid.
 *
 * `limit` bounds the fact list rather than the output. A brief containing a thousand statements
 * costs tokens on every draft and reliably produces worse citations, because the model stops
 * being able to tell which facts are relevant.
 */
export function buildPostBrief(target: PostTarget, scope: PostScope, limit = 60): string {
  if (!target.goal.trim()) {
    throw new PostTargetError('A target is required — the post needs a stated goal to be drafted toward.');
  }
  const usable = groundableStatements(scope.statements).slice(0, limit);
  if (usable.length === 0) {
    throw new PostTargetError(
      'No confirmed facts are in scope. A grounded draft cannot be written from an empty or unreviewed graph.',
    );
  }

  const facts = usable
    .map((s) => `[${s.id}] ${s.s.value} — ${s.p.value} — ${s.o.value}`)
    .join('\n');

  return `${ETHICS_PREAMBLE}

You are drafting a blog post for the author, from THEIR knowledge graph.

TARGET (what this post must achieve, in the author's words):
${target.goal.trim()}
${target.audience?.trim() ? `\nAUDIENCE: ${target.audience.trim()}` : ''}
${target.approxWords ? `\nAPPROXIMATE LENGTH: ${target.approxWords} words` : ''}

GRAPHS IN SCOPE: ${scope.graphNames.join(', ') || 'the active graph'}

FACTS YOU MAY USE — every one carries an id in square brackets:
${facts}

RULES, and the first is absolute:
1. EVERY sentence in the body must cite at least one fact id. A sentence you cannot cite is a
   sentence you must not write. Do not soften this by citing a loosely-related fact.
2. If the target asks for something the facts do not support, SAY SO in the NOTES section rather
   than inventing it. An honest gap is more useful to the author than fluent invention.
3. Use the entity's label where one exists, never a raw IRI.

REPLY IN EXACTLY THIS FORMAT:
TITLE: <one line>
EXCERPT: <one sentence>
BODY:
<sentence> [[id, id]]
<sentence> [[id]]
NOTES:
<anything the target asked for that the facts could not support — or "none">`;
}

export interface DraftedPost {
  title: string;
  excerpt: string;
  sentences: GroundedSentence[];
  /** What the model said it could not support. Surfaced, never discarded. */
  notes: string;
  violations: GroundingViolation[];
  /** True only when every sentence cites at least one CONFIRMED statement. */
  fullyGrounded: boolean;
}

const CITATION_RE = /\s*\[\[([^\]]*)\]\]\s*$/;

/**
 * Parse a model reply into a grounded draft and validate it against the graph.
 *
 * Sentences that arrive with NO citation marker are kept, with empty citations, so
 * `validateGeneration` reports them as uncited. Dropping them would hide the exact failure this
 * path exists to catch, and silently keeping them unmarked would be worse still.
 */
export function parseDraftedPost(reply: string, scope: PostScope): DraftedPost {
  const byId = statementsById(groundableStatements(scope.statements));

  // NO `m` FLAG, deliberately. With multiline, `$` matches every line ending, so the lazy body
  // capture stopped after ONE line and a following "NOTES: none" was swallowed as a sentence.
  // `(?:^|\n)` handles the line start instead, leaving `$` meaning end-of-reply.
  const section = (name: string): string => {
    const re = new RegExp(`(?:^|\\n)${name}:[ \\t]*([\\s\\S]*?)(?=\\n(?:TITLE|EXCERPT|BODY|NOTES):|$)`);
    return re.exec(reply)?.[1]?.trim() ?? '';
  };

  const title = section('TITLE').split('\n')[0].trim();
  const excerpt = section('EXCERPT').split('\n')[0].trim();
  const notes = section('NOTES');

  const sentences: GroundedSentence[] = section('BODY')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = CITATION_RE.exec(line);
      const citations = match
        ? match[1].split(',').map((c) => c.trim()).filter(Boolean)
        : [];
      return { text: line.replace(CITATION_RE, '').trim(), citations };
    })
    .filter((s) => s.text.length > 0);

  const violations = validateGeneration(sentences, byId);

  return {
    title,
    excerpt,
    sentences,
    notes: notes.toLowerCase() === 'none' ? '' : notes,
    violations,
    fullyGrounded: violations.length === 0 && sentences.length > 0,
  };
}

/**
 * Turn a drafted post into an editable draft.
 *
 * Citations are DROPPED from the rendered body on purpose — they are review apparatus, not
 * publishable prose, and a reader does not want `[[abc-123]]` in the middle of a sentence. They
 * remain on `DraftedPost.sentences`, which is what the review surface reads, so nothing is lost;
 * the author reviews grounded sentences and publishes clean ones.
 */
export function draftedPostToDraft(
  drafted: DraftedPost,
  base: Pick<PostDraft, 'section' | 'date'>,
): PostDraft {
  return {
    title: drafted.title,
    section: base.section,
    date: base.date,
    excerpt: drafted.excerpt,
    body: drafted.sentences.map((s) => s.text).join('\n\n'),
    status: 'draft',
  };
}

/**
 * One honest line about a draft, leading with what is wrong.
 *
 * Grounding failures come FIRST because a fluent draft is persuasive and its problems are not
 * visible in the prose. Saying "412 words" before "3 sentences cite nothing" would bury the only
 * thing the author has to act on.
 */
export function describeDraft(drafted: DraftedPost): string {
  if (drafted.sentences.length === 0) return 'The model returned no usable body.';

  const parts: string[] = [];
  if (drafted.violations.length > 0) {
    const uncited = drafted.violations.filter((v) => v.kind === 'uncited').length;
    const other = drafted.violations.length - uncited;
    if (uncited > 0) {
      parts.push(`${uncited} sentence${uncited === 1 ? ' cites' : 's cite'} nothing and cannot be published as grounded.`);
    }
    if (other > 0) {
      parts.push(`${other} citation${other === 1 ? '' : 's'} point at facts that are missing or unconfirmed.`);
    }
  } else {
    const n = drafted.sentences.length;
    parts.push(`All ${n} sentence${n === 1 ? '' : 's'} trace to confirmed facts.`);
  }
  if (drafted.notes) parts.push('The draft reports gaps the graph could not support — read the notes.');
  return parts.join(' ');
}
