/**
 * Global feedback surface (kb:feedback-channel).
 *
 * Feedback used to live only on /about. Someone hitting friction in the graph view does not
 * navigate to an About page to complain — they leave. So the form is reachable from anywhere,
 * and opens in place rather than navigating, for two reasons: the user does not lose the state
 * they were annoyed about, and WE LEARN WHICH PAGE THEY WERE ON.
 *
 * That last part is the actual product value. "The graph is confusing" is a shrug; the same
 * sentence stamped with /review after a merge is a bug report. The route is captured at OPEN
 * time, not submit time, so navigating away mid-typing cannot rewrite where the friction was.
 */

let open = $state(false);
let capturedSource = $state('unknown');

/** Is the feedback dialog showing? */
export function feedbackOpen(): boolean {
  return open;
}

/** Where the user was when they decided to tell us something. */
export function feedbackSource(): string {
  return capturedSource;
}

/**
 * Open the feedback dialog, recording the current route as the source.
 *
 * `source` is passed in rather than read from $page here so this store stays free of SvelteKit
 * navigation imports — it is called from components that already know their route.
 */
export function openFeedback(source: string): void {
  capturedSource = normalizeSource(source);
  open = true;
}

export function closeFeedback(): void {
  open = false;
}

/**
 * Reduce a pathname to a stable, NON-IDENTIFYING label.
 *
 * A raw path can carry graph names, entity IRIs and query strings — a user telling us the UI is
 * confusing has not agreed to send us the contents of their private graph. Feedback is voluntary;
 * quietly attaching their data to it is not. So only the first path segment survives, and query
 * strings and fragments are dropped entirely.
 */
export function normalizeSource(pathname: string): string {
  if (!pathname) return 'unknown';
  const path = pathname.split('?')[0].split('#')[0];
  const first = path.split('/').filter(Boolean)[0];
  return first ? first.toLowerCase() : 'home';
}
