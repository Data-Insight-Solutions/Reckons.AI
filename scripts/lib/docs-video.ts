/**
 * F275.22.1 — the HTML a documentation page shows for a workflow's narrated video.
 *
 * Pure apart from the injected `exists`, so a test can run it. A video that is linked but missing is
 * an ERROR, the same as a screenshot (scripts/offline/test-workflow-check.ts): a page must never
 * show a player that cannot play. Only paths under /video/demos/ are accepted, so a typo cannot make
 * a page load something from elsewhere on the site, or from another site.
 */
import type { Workflow } from './test-workflow.js';

export const VIDEO_DIR = '/video/demos/';

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The problem with a site path used as a docs video asset, or null when it is acceptable. */
export function videoPathProblem(path: string, ext: readonly string[], exists: (sitePath: string) => boolean): string | null {
  if (!path.startsWith(VIDEO_DIR) || path.includes('..') || path.includes('//')) {
    return `${path} is not under ${VIDEO_DIR}`;
  }
  if (!ext.some((e) => path.endsWith(e))) return `${path} must end in ${ext.join(' or ')}`;
  if (!exists(path)) return `${path} is linked but static${path} does not exist`;
  return null;
}

/** The player for a workflow that carries kpred:video; throws on a bad or missing asset. */
export function videoBlock(w: Workflow, exists: (sitePath: string) => boolean): string {
  if (!w.video) throw new Error(`<${w.iri}> has no kpred:video`);
  const bad = [
    videoPathProblem(w.video, ['.mp4'], exists),
    w.videoCaptions ? videoPathProblem(w.videoCaptions, ['.vtt'], exists) : null,
    w.videoPoster ? videoPathProblem(w.videoPoster, ['.webp', '.jpg'], exists) : null,
  ].filter((x): x is string => !!x);
  if (bad.length) throw new Error(`Video of workflow <${w.iri}>: ${bad.join('; ')}`);
  const poster = w.videoPoster ? ` poster="${escAttr(w.videoPoster)}"` : '';
  const track = w.videoCaptions
    ? `<track kind="captions" srclang="en" label="English" src="${escAttr(w.videoCaptions)}" default>`
    : '';
  return `<video controls preload="metadata" playsinline${poster}><source src="${escAttr(w.video)}" type="video/mp4">${track}</video>`;
}
