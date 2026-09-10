/**
 * A title as a READER of the docs should see it — shared by BOTH page generators.
 *
 * Matt, 2026-09-08: "We should avoid labelling the LEAPs at the beginning, it has no relevancy
 * here in the docs." LEAP is the name of a gesture in the APP, where it switches you to another
 * graph. On a website the same node is a link to another section, so the prefix tells a reader
 * nothing and costs them the first characters of every such title.
 *
 * SHARED BECAUSE IT WAS NOT. The first fix lived inside docs-pages.ts, so the docs-kb pages were
 * clean while content/learn/start-here.md — written by the OTHER generator, docs-compose.ts —
 * still read "LEAP: Architecture & Design". Two generators publishing the same site is a standing
 * hazard here, and anything that shapes reader-facing text has to be reachable from both.
 *
 * Stripped at RENDER time rather than in the graph, because the app's own label is still correct
 * where the app uses it.
 */
export function docsTitle(title: string): string {
  return title.replace(/^LEAP:\s*/i, '').trim();
}
