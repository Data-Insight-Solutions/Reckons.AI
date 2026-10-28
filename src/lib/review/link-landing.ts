/**
 * What a review LINK should show before it shows a queue (feat/review-links, Matt 2026-10-28).
 *
 * A link minted by `kb_review_links` points at proposals that live in a folder on disk. Whether
 * this browser tab can read that folder depends on its ORIGIN: every origin (localhost:5173,
 * localhost:5174, a deployed site) has its own IndexedDB and so its own stored folder handle, and
 * even the right origin must be re-granted permission with a click once per session. Until that
 * has happened the honest answer to "how many proposals?" is "not known yet", never "0".
 *
 * Pure so it is testable without a browser; the component only renders what this returns.
 */

export type LandingKind =
  /** Not arriving from a link, or nothing to say. */
  | 'none'
  /** The stored folder handle has not been looked up yet. */
  | 'checking'
  /** A folder is linked here but permission lapsed: one click restores it. */
  | 'reconnect'
  /** Connected; the first pull + queue drain is still running. */
  | 'loading'
  /** This origin has no workspace folder at all. */
  | 'unlinked'
  /** Connected and loaded: show the queue (with the filter applied). */
  | 'ready';

export interface LandingInput {
  /** The URL carries ?agent= or ?kb=. */
  fromLink: boolean;
  checked: boolean;
  state: 'none' | 'disconnected' | 'connected';
  loading: boolean;
  /** Folder access exists in this browser at all (File System Access API). */
  supported: boolean;
}

export function landingKind(i: LandingInput): LandingKind {
  if (!i.fromLink) return 'none';
  if (!i.checked) return 'checking';
  if (i.state === 'disconnected') return 'reconnect';
  if (i.state === 'none') return i.supported ? 'unlinked' : 'none';
  return i.loading ? 'loading' : 'ready';
}

/** True when the link names something to filter by. */
export function isReviewLink(params: URLSearchParams): boolean {
  return Boolean(params.get('agent') || params.get('kb'));
}
