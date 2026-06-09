/**
 * Mock for $app/state — SvelteKit's reactive page store.
 * Stories call setMockPathname() in their args to simulate active routes.
 */

let _pathname = '/';

export const page = {
  get url() {
    return {
      pathname: _pathname,
      searchParams: new URLSearchParams(),
      href: `http://localhost:6006${_pathname}`,
      origin: 'http://localhost:6006',
      hash: '',
      search: '',
    };
  },
  get params() { return {}; },
  get route() { return { id: _pathname }; },
  get data() { return {}; },
  get status() { return 200; },
  get error() { return null; },
};

/** Stories can call this to simulate a different active route. */
export function setMockPathname(path: string) {
  _pathname = path;
}
