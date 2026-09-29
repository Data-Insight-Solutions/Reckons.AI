/**
 * Notifications are DEFERRED on the landing, never discarded.
 *
 * A first-time visitor arriving from a link met a tray of eight: a Shelly tour for a graph they did
 * not have, a 3D performance warning about a scene they had not rendered, model-status notes about
 * work they had not asked for. Each is useful later and noise on arrival, and a stack of eight
 * teaches somebody to dismiss the ninth without reading it.
 *
 * The distinction these tests protect is deferral versus loss: suppressing must hide the queue, not
 * empty it, or a warning raised while the landing happened to be showing would vanish for good.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushNotification, notifications, dismissNotification,
  setNotificationsSuppressed, notificationsSuppressed,
} from '../notifications.svelte';

beforeEach(() => {
  setNotificationsSuppressed(false);
  for (const n of [...notifications()]) dismissNotification(n.id);
});

describe('landing suppression', () => {
  it('hides ordinary notifications while the landing shows', () => {
    pushNotification({ id: 'tip-a', type: 'info', title: 'Meet Shelly', body: 'tour' });
    expect(notifications()).toHaveLength(1);

    setNotificationsSuppressed(true);
    expect(notifications()).toHaveLength(0);
    expect(notificationsSuppressed()).toBe(true);
  });

  it('RELEASES them once there is a graph — deferred, not dropped', () => {
    setNotificationsSuppressed(true);
    pushNotification({ id: 'tip-b', type: 'info', title: 'queued while hidden', body: 'x' });
    expect(notifications()).toHaveLength(0);

    setNotificationsSuppressed(false);
    expect(notifications().map((n) => n.id)).toContain('tip-b');
  });

  it('never defers an important notification, because those are about now', () => {
    pushNotification({ id: 'urgent', type: 'warn', title: 'save failed', body: 'x', important: true });
    pushNotification({ id: 'ordinary', type: 'info', title: 'tip', body: 'x' });

    setNotificationsSuppressed(true);
    const shown = notifications().map((n) => n.id);
    expect(shown).toContain('urgent');
    expect(shown).not.toContain('ordinary');
  });
});
