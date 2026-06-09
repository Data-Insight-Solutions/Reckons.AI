/** Mock for $app/stores — legacy SvelteKit store API. */
import { readable } from 'svelte/store';

export const page = readable({
  url: new URL('http://localhost:6006/'),
  params: {},
  route: { id: '/' },
  data: {},
  status: 200,
  error: null,
  form: null,
});

export const navigating = readable(null);
export const updated = readable(false);
