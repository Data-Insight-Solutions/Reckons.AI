/**
 * Drafting a post as a Reckoning (F27 + F51).
 *
 * The tests that earn their place are about the UNGROUNDED sentence. A model reliably produces
 * fluent prose that cites nothing, and that prose is persuasive precisely because its problem is
 * invisible in the reading. Every test here is about catching and SHOWING that, rather than about
 * whether the happy path parses.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPostBrief, parseDraftedPost, draftedPostToDraft, describeDraft,
  groundableStatements, PostTargetError,
} from '../post-reckoning';
import { validatePostDraft } from '../post-authoring';
import type { NamedNode, ReviewStatus, Statement, Term } from '$lib/rdf/types';

const iri = (v: string): NamedNode => ({ kind: 'iri', value: v });
const lit = (v: string): Term => ({ kind: 'literal', value: v });
const st = (id: string, s: string, p: string, o: string, status: ReviewStatus = 'confirmed'): Statement => ({
  id, s: iri(s), p: iri(p), o: lit(o), g: iri('urn:g'),
  sourceId: 'x', confidence: 1, status, createdAt: 0, updatedAt: 0,
});

const facts = [
  st('f1', 'urn:kb/reckons', 'urn:p/is', 'local-first'),
  st('f2', 'urn:kb/reckons', 'urn:p/stores', 'IndexedDB'),
  st('f3', 'urn:kb/draft', 'urn:p/note', 'not reviewed yet', 'pending'),
  st('f4', 'urn:kb/old', 'urn:p/note', 'withdrawn', 'rejected'),
];
const scope = { statements: facts, graphNames: ['Product'] };
const target = { goal: 'Explain why the app keeps data on the device.' };

describe('the brief', () => {
  it('lists facts WITH ids, because the model must cite them back', () => {
    const brief = buildPostBrief(target, scope);
    expect(brief).toContain('[f1]');
    expect(brief).toContain('[f2]');
  });

  it('offers only confirmed and refined facts — never pending or rejected', () => {
    // A draft grounded in an unreviewed fact is grounded in nothing anyone agreed to.
    const brief = buildPostBrief(target, scope);
    expect(brief).not.toContain('[f3]');
    expect(brief).not.toContain('[f4]');
    expect(groundableStatements(facts).map((s) => s.id)).toEqual(['f1', 'f2']);
  });

  it('carries the ethics preamble', () => {
    expect(buildPostBrief(target, scope).length).toBeGreaterThan(target.goal.length + 200);
  });

  it('refuses a target with no goal', () => {
    expect(() => buildPostBrief({ goal: '  ' }, scope)).toThrow(PostTargetError);
  });

  it('refuses to draft from a graph with no confirmed facts', () => {
    // The honest failure. Drafting anyway would produce prose grounded in nothing.
    expect(() => buildPostBrief(target, { statements: [facts[2]], graphNames: ['Empty'] }))
      .toThrow(/cannot be written from an empty or unreviewed graph/);
  });

  it('bounds the fact list rather than the output', () => {
    const many = Array.from({ length: 200 }, (_, i) => st(`m${i}`, 'urn:s', 'urn:p', `v${i}`));
    const brief = buildPostBrief(target, { statements: many, graphNames: ['Big'] }, 5);
    expect(brief).toContain('[m4]');
    expect(brief).not.toContain('[m5]');
  });
});

const REPLY = `TITLE: Why your data stays put
EXCERPT: The app keeps everything on your own device.
BODY:
Reckons.AI is local-first. [[f1]]
Your facts live in the browser's IndexedDB. [[f1, f2]]
NOTES:
none`;

describe('parsing and grounding', () => {
  it('reads title, excerpt and cited sentences', () => {
    const d = parseDraftedPost(REPLY, scope);
    expect(d.title).toBe('Why your data stays put');
    expect(d.excerpt).toBe('The app keeps everything on your own device.');
    expect(d.sentences).toEqual([
      { text: 'Reckons.AI is local-first.', citations: ['f1'] },
      { text: "Your facts live in the browser's IndexedDB.", citations: ['f1', 'f2'] },
    ]);
    expect(d.fullyGrounded).toBe(true);
  });

  it('KEEPS an uncited sentence and reports it, rather than dropping it', () => {
    // Dropping it hides the failure; keeping it unmarked publishes it. Both are worse.
    const d = parseDraftedPost(`TITLE: T
EXCERPT: E
BODY:
Reckons.AI is local-first. [[f1]]
It is also the fastest tool on the market.
NOTES: none`, scope);
    expect(d.sentences).toHaveLength(2);
    expect(d.violations.some((v) => v.kind === 'uncited')).toBe(true);
    expect(d.fullyGrounded).toBe(false);
  });

  it('rejects a citation pointing at a fact that is not confirmed', () => {
    const d = parseDraftedPost(`TITLE: T
EXCERPT: E
BODY:
Something unreviewed. [[f3]]
NOTES: none`, scope);
    expect(d.fullyGrounded).toBe(false);
    expect(d.violations).not.toEqual([]);
  });

  it('rejects a citation pointing at nothing at all', () => {
    const d = parseDraftedPost(`TITLE: T
EXCERPT: E
BODY:
Invented support. [[does-not-exist]]
NOTES: none`, scope);
    expect(d.fullyGrounded).toBe(false);
  });

  it('surfaces the notes when the model could not support the target', () => {
    const d = parseDraftedPost(`TITLE: T
EXCERPT: E
BODY:
Reckons.AI is local-first. [[f1]]
NOTES:
No facts describe pricing, so the target's pricing angle is unsupported.`, scope);
    expect(d.notes).toContain('pricing');
  });

  it('treats a NOTES value of "none" as no notes', () => {
    expect(parseDraftedPost(REPLY, scope).notes).toBe('');
  });

  it('reports an empty body rather than pretending to have drafted', () => {
    const d = parseDraftedPost('TITLE: T\nEXCERPT: E\nBODY:\nNOTES: none', scope);
    expect(d.sentences).toEqual([]);
    expect(d.fullyGrounded).toBe(false);
    expect(describeDraft(d)).toBe('The model returned no usable body.');
  });
});

describe('handing the draft to the editor', () => {
  it('strips citation markers from the published body but keeps them for review', () => {
    const d = parseDraftedPost(REPLY, scope);
    const draft = draftedPostToDraft(d, { section: 'Blog', date: '2026-07-30' });
    expect(draft.body).not.toContain('[[');
    expect(draft.body).toContain('Reckons.AI is local-first.');
    // Still reviewable — the citations live on the drafted sentences.
    expect(d.sentences[0].citations).toEqual(['f1']);
  });

  it('produces a draft the authoring validator accepts', () => {
    // The two halves must agree, or a drafted post cannot be saved.
    const draft = draftedPostToDraft(parseDraftedPost(REPLY, scope), { section: 'Blog', date: '2026-07-30' });
    expect(validatePostDraft(draft).ok).toBe(true);
  });

  it('always arrives as a draft, never published', () => {
    const draft = draftedPostToDraft(parseDraftedPost(REPLY, scope), { section: 'Blog', date: '2026-07-30' });
    expect(draft.status).toBe('draft');
  });
});

describe('the sentence the author reads', () => {
  it('leads with what is WRONG, not with what was produced', () => {
    // A fluent draft is persuasive and its problems are invisible in the prose.
    const d = parseDraftedPost(`TITLE: T
EXCERPT: E
BODY:
Grounded. [[f1]]
Unbacked claim.
NOTES: none`, scope);
    expect(describeDraft(d)).toMatch(/^1 sentence cites nothing/);
  });

  it('says so plainly when everything traces', () => {
    expect(describeDraft(parseDraftedPost(REPLY, scope)))
      .toContain('All 2 sentences trace to confirmed facts');
  });
});
