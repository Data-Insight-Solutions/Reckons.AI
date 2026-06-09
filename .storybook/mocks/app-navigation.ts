/** Mock for $app/navigation. */
export const goto = async (_url: string) => {};
export const pushState = (_url: string, _state: Record<string, unknown>) => {};
export const replaceState = (_url: string, _state: Record<string, unknown>) => {};
export const invalidate = async (_url: string) => {};
export const invalidateAll = async () => {};
export const preloadData = async (_url: string) => ({ type: 'loaded', status: 200, data: {} });
export const preloadCode = async (..._urls: string[]) => {};
export const beforeNavigate = (_fn: () => void) => {};
export const afterNavigate = (_fn: () => void) => {};
export const onNavigate = (_fn: () => void) => () => {};
