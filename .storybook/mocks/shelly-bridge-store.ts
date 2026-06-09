/** Mock for $lib/stores/shelly-bridge.svelte */
export interface ViewAdjust {
  selectEntity?: string;
  layout?: 'force' | 'focus' | 'source' | 'type' | 'hub';
  filters?: Array<'hubs' | 'islands' | 'confirmed' | 'pending' | 'no-type' | 'no-source'>;
  spotlight?: string[];
}

export function shellyChatOpen(): boolean { return false; }
export function setShellyChatOpen(_open: boolean): void {}
export function shellyOpenMessage(): string | null { return null; }
export function requestShellyChat(_message?: string): void {}
export function clearShellyOpen(): void {}

export function shellyViewAdjust(): ViewAdjust | null { return null; }
export function shellySpotlight(): string[] { return []; }
export function applyShellyViewAdjust(_adj: ViewAdjust): void {}
export function clearShellyViewAdjust(): void {}
export function setShellySpotlight(_iris: string[]): void {}
