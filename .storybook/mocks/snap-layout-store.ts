/** Mock for $lib/stores/snap-layout.svelte */
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export function registerPanel(_id: string, _corner: Corner): void {}
export function unregisterPanel(_id: string): void {}
export function getColumnMaxH(_id: string, _vh: number): number | null { return null; }
