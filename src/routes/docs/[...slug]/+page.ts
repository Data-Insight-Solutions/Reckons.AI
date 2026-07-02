import { error } from '@sveltejs/kit';
import { allSlugs, findDoc } from '../_content/docs';
import type { EntryGenerator } from './$types';

export const prerender = true;

// Tells adapter-static which [...slug] values exist so every published doc gets
// its own prerendered HTML file (strict:true would otherwise fail the build for
// an un-enumerated dynamic route).
export const entries: EntryGenerator = () => allSlugs().map((slug) => ({ slug }));

// Only hand serializable frontmatter across the load boundary. The mdsvex-compiled
// component itself is resolved directly in +page.svelte (via the same slug) so a
// Svelte component reference never has to survive SvelteKit's data-serialization step.
export function load({ params }) {
  const doc = findDoc(params.slug);
  if (!doc) error(404, 'Page not found');
  return { slug: doc.path, metadata: doc.metadata };
}
