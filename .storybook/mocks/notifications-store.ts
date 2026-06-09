/** Mock for $lib/stores/notifications.svelte */
export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warn';
  title: string;
  body?: string;
  action?: { label: string; href?: string; onclick?: () => void };
  ondismiss?: () => void;
  oneTime?: boolean;
}

export function notifications(): AppNotification[] { return []; }
export function pushNotification(_n: Omit<AppNotification, 'id'> & { id?: string }): void {}
export function dismissNotification(_id: string): void {}
