/**
 * Post authoring (F27) — the write side of the publishing pipeline.
 *
 * `page.ts` reads WebPage nodes OUT of the graph and `site-export.ts` renders them to markdown.
 * Nothing ever put one IN. The whole publish module — `buildSitePages`, `buildSiteFiles`,
 * `exportSiteZip`, `publishSiteToGitHub` — had no caller anywhere in `src/routes` or
 * `src/lib/components`, so a user could read a site the build generated and could not author a
 * single page. This module is the missing half: a draft in, validated graph statements out.
 *
 * GRAPH-FIRST, deliberately. A post is not a markdown file that we later parse into facts — it is
 * a `ktype:WebPage` node with `page:*` predicates, and the markdown is a rendering of it. That is
 * the direction the whole pipeline already assumes (`content/` is generated, never hand-edited),
 * and authoring straight to markdown would have quietly inverted it.
 *
 * Pure: no Dexie, no store, no clock beyond what the caller passes. Validation returns EVERY
 * problem at once rather than throwing on the first, because a form that reveals its objections
 * one at a time is a form people fill in wrong four times.
 *
 * WHAT THIS DOES NOT DO — see `validatePostDraft`'s notes: it cannot know whether the built site
 * will actually serve the page. `/docs` globs markdown at BUILD time (mdsvex compiles each `.md`
 * into a Svelte component), so a post authored in the browser reaches the live site only after
 * the exported file is committed and the site is rebuilt. The in-app preview renders from the
 * graph, which is honest about being a preview and not a deployment.
 */

import { v4 as uuid } from 'uuid';
import {
  PAGE_BODY, PAGE_DATE, PAGE_EXCERPT, PAGE_NAV, PAGE_NS, PAGE_SECTION, PAGE_SLUG,
  PAGE_STATUS, PAGE_TEMPLATE, WEBPAGE_TYPE, slugify,
  type PageNav, type PageStatus, type SitePage,
} from '$lib/rdf/page';
import { NAV_ORDER } from '$lib/rdf/hierarchy';
import { iri, lit, type Statement } from '$lib/rdf/types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Where an authored post's IRI lives. Distinct from docs-KB concept IRIs on purpose. */
export const AUTHORED_POST_NS = `${PAGE_NS}post/`;

export interface PostDraft {
  title: string;
  /** Blank means "derive from the title" — the common case, and one less field to get wrong. */
  slug?: string;
  section: string;
  /** ISO yyyy-mm-dd. Posts are dated content; that is what distinguishes them from docs. */
  date: string;
  excerpt: string;
  body: string;
  status?: PageStatus;
  nav?: PageNav;
  order?: number;
}

export interface DraftProblem {
  field: keyof PostDraft;
  message: string;
}

export interface PostValidation {
  ok: boolean;
  problems: DraftProblem[];
  /** The slug that would be used — derived when the draft leaves it blank. */
  resolvedSlug: string;
}

/**
 * Check a draft against everything that can be checked without a network or a build.
 *
 * `existingSlugs` is passed in rather than read from a store so this stays pure AND so the caller
 * decides what "already taken" means — an edit of an existing post must not collide with itself.
 * A slug collision is worth catching here because `contentPath()` derives the FILE PATH from
 * section + slug: two posts agreeing on both would silently overwrite each other on export, and
 * the loss would appear as a file that quietly has the wrong content rather than as an error.
 */
export function validatePostDraft(
  draft: PostDraft,
  existingSlugs: ReadonlySet<string> = new Set(),
): PostValidation {
  const problems: DraftProblem[] = [];

  const title = draft.title.trim();
  if (!title) problems.push({ field: 'title', message: 'A post needs a title.' });

  const section = draft.section.trim();
  if (!section) {
    problems.push({ field: 'section', message: 'A post needs a section — it becomes the folder.' });
  }

  // Derive before validating, so the problem is reported against the TITLE that failed to
  // produce a slug rather than as a mysterious empty field.
  //
  // `slugify` never returns empty — it falls back to the literal string "page". That fallback is
  // a silent-collision hazard here: every punctuation-only title would land at
  // content/<section>/page.md and quietly overwrite the last one. So the check is on the SOURCE
  // having usable characters, not on the output being non-empty. A user who deliberately types
  // "page" is fine; a title of "!!! ???" that fell back to it is not.
  const slugSource = draft.slug?.trim() || title;
  const resolvedSlug = slugify(slugSource);
  if (!/[a-z0-9]/i.test(slugSource)) {
    problems.push({
      field: 'slug',
      message: 'This title produces no usable slug — add letters or numbers, or set a slug.',
    });
  } else if (existingSlugs.has(slugKey(section, resolvedSlug))) {
    problems.push({
      field: 'slug',
      message: `"${resolvedSlug}" already exists in ${section} — exporting would overwrite it.`,
    });
  }

  if (!ISO_DATE_RE.test(draft.date)) {
    problems.push({ field: 'date', message: 'Date must be yyyy-mm-dd.' });
  } else if (!isRealCalendarDate(draft.date)) {
    // `new Date('2026-02-30')` does not fail, it rolls over to 2 March — so a date that passes
    // the regex can still be a day that never happened, and it would be published as fact.
    problems.push({ field: 'date', message: `${draft.date} is not a real date.` });
  }

  if (!draft.body.trim()) {
    problems.push({ field: 'body', message: 'A post with no body is not a post.' });
  }

  return { ok: problems.length === 0, problems, resolvedSlug };
}

/** The identity a file path collides on: section AND slug, matching `contentPath()`. */
export function slugKey(section: string, slug: string): string {
  return `${slugify(section)}/${slug}`;
}

/** Section+slug pairs already taken, optionally excluding the page being edited. */
export function takenSlugs(pages: SitePage[], exceptIri?: string): Set<string> {
  const taken = new Set<string>();
  for (const p of pages) {
    if (p.iri === exceptIri) continue;
    taken.add(slugKey(p.section, p.slug));
  }
  return taken;
}

export class PostDraftError extends Error {
  constructor(readonly problems: DraftProblem[]) {
    super(problems.map((p) => p.message).join(' '));
    this.name = 'PostDraftError';
  }
}

export interface BuildPostOptions {
  /** Reuse an existing IRI to EDIT a post rather than mint a second one. */
  iri?: string;
  existingSlugs?: ReadonlySet<string>;
  /** Provenance graph for the produced statements. */
  sourceId?: string;
  now?: () => number;
  newId?: () => string;
}

/**
 * Turn a validated draft into the statements that ARE the post.
 *
 * Refuses an invalid draft rather than writing a partial node: a WebPage missing its date or slug
 * still renders — as a page at the wrong path, dated nothing — which is worse than not existing,
 * because it looks like it worked.
 *
 * Statements are written `confirmed`. This is the USER authoring their own content directly, not
 * an agent proposing a fact, so the F52 agent-edit boundary does not apply — that boundary exists
 * to stop machines settling facts, not to make people review their own writing. An agent-authored
 * post must go through `addStatements({ origin: 'agent' })` like anything else, which downgrades
 * it to a proposal.
 */
export function buildPostStatements(
  draft: PostDraft,
  opts: BuildPostOptions = {},
): { statements: Statement[]; iri: string; slug: string } {
  const validation = validatePostDraft(draft, opts.existingSlugs);
  if (!validation.ok) throw new PostDraftError(validation.problems);

  const now = (opts.now ?? Date.now)();
  const newId = opts.newId ?? (() => uuid());
  const subject = opts.iri ?? `${AUTHORED_POST_NS}${validation.resolvedSlug}-${newId()}`;
  const sourceId = opts.sourceId ?? 'authored';
  const g = iri(`urn:kbase:source/${sourceId}`);

  const fact = (p: string, o: ReturnType<typeof lit> | ReturnType<typeof iri>): Statement => ({
    id: newId(),
    s: iri(subject),
    p: iri(p),
    o,
    g,
    sourceId,
    confidence: 1,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
  });

  const statements: Statement[] = [
    fact(RDF_TYPE, iri(WEBPAGE_TYPE)),
    fact(RDFS_LABEL, lit(draft.title.trim())),
    fact(PAGE_SLUG, lit(validation.resolvedSlug)),
    fact(PAGE_SECTION, lit(draft.section.trim())),
    fact(PAGE_TEMPLATE, lit('post')),
    fact(PAGE_STATUS, lit(draft.status ?? 'draft')),
    fact(PAGE_NAV, lit(draft.nav ?? 'hidden')),
    fact(PAGE_DATE, lit(draft.date)),
    fact(NAV_ORDER, lit(String(draft.order ?? 0))),
    fact(PAGE_BODY, lit(draft.body)),
  ];

  // Excerpt is genuinely optional — an empty one is absence, not an empty string worth storing.
  const excerpt = draft.excerpt.trim();
  if (excerpt) statements.push(fact(PAGE_EXCERPT, lit(excerpt)));

  return { statements, iri: subject, slug: validation.resolvedSlug };
}

/** Today in yyyy-mm-dd, LOCAL — a post dated "today" must mean the author's today. */
export function todayIso(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Does this yyyy-mm-dd name a day that exists? (`new Date` rolls 30 Feb over to 2 March.) */
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
