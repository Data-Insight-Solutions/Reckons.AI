/**
 * Focus a control introduced by an explicit user action without using the HTML
 * `autofocus` attribute, which can unexpectedly steal focus on initial load.
 */
export function focusOnMount(node: HTMLElement) {
  queueMicrotask(() => node.focus({ preventScroll: true }));
}
