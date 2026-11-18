import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * F264.1: /compare is now the compare mode inside Review. Old links (and anything that still
 * navigates here) keep working: ?source=<id> carries over to the Review URL.
 */
export const load: PageLoad = ({ url }) => {
  const params = new URLSearchParams({ view: 'compare' });
  const source = url.searchParams.get('source');
  if (source) params.set('source', source);
  redirect(307, `/review?${params}`);
};
