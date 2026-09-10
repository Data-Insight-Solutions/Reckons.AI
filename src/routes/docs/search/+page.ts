/**
 * The one page in /docs that is allowed JavaScript (F191).
 *
 * `src/routes/docs/+layout.ts` sets `csr = false` for the whole group and that decision stands —
 * a reader of a document should not download a search engine to read prose. A page option set in
 * a `+page.ts` overrides the layout's for that route alone, so search is an ISLAND: the cost is
 * paid by the reader who opens search and by nobody else.
 *
 * The explicit alternative, rejected: enabling csr for the docs group would bill every reader on
 * every page for a feature most of them never use.
 */
export const csr = true;
export const prerender = true;
