/**
 * The interactive half of F190 — an iframe island, deliberately OUTSIDE the docs route group.
 *
 * `src/routes/docs/+layout.ts` sets `csr = false` and that decision stands: a reader of a document
 * should not download a 3D engine to read prose. This route is where the engine is allowed, and it
 * is reached only through an `<iframe loading="lazy">`, so a reader who never scrolls to the scene
 * never fetches it. The cost is charged to the pages that ask for it and to nobody else.
 */
export const csr = true;
export const prerender = false;

export function load({ params }: { params: { id: string } }) {
  return { id: params.id };
}
