/**
 * Notifications store — app-wide dismissable notification stack.
 *
 * Notifications render in NotificationStack.svelte (upper-right corner).
 * `oneTime: true` notifications are stored in localStorage so they never
 * re-appear after dismissal (used for first-run tips).
 */

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warn';
  title: string;
  body?: string;
  action?: { label: string; href?: string; onclick?: () => void };
  /** Called when the notification is dismissed (via X or action). */
  ondismiss?: () => void;
  /** Persist dismissal to localStorage — never shown again after dismiss */
  oneTime?: boolean;
}

const DISMISSED_KEY = 'reckons:dismissed-tips';

let _notifications = $state<AppNotification[]>([]);

/** Reactive height of the rendered notification stack (px). Updated by NotificationStack. */
let _stackHeight = $state(0);
export const notificationStackHeight = {
  get: () => _stackHeight,
  set: (h: number) => { _stackHeight = h; },
};

function getDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')); }
  catch { return new Set(); }
}

function saveDismissed(ids: Set<string>) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
}

export function notifications(): AppNotification[] { return _notifications; }

export function pushNotification(n: Omit<AppNotification, 'id'> & { id?: string }): void {
  const id = n.id ?? Math.random().toString(36).slice(2, 10);
  if (n.oneTime && getDismissed().has(id)) return;
  if (_notifications.some(x => x.id === id)) return; // dedupe
  _notifications = [..._notifications, { ...n, id }];
}

export function dismissNotification(id: string): void {
  const idx = _notifications.findIndex(x => x.id === id);
  if (idx === -1) return; // nothing to do — avoids triggering reactive cycle
  const n = _notifications[idx];
  if (n.oneTime) {
    const d = getDismissed();
    d.add(id);
    saveDismissed(d);
  }
  n.ondismiss?.();
  _notifications = _notifications.filter(x => x.id !== id);
}
