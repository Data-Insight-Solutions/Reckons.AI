import { docsBySection } from './_content/docs';

// F27 Phase 2: the /docs route group is prerendered, standalone from the app's SPA
// shell — no Dexie/IndexedDB, no NavBar/Shelly chrome (see src/routes/(app)/+layout.svelte
// for that). Content is static at build time, so csr can stay off too: no client JS
// is needed to read a doc, keeping these pages small and fast.
export const prerender = true;
export const csr = false;

export function load() {
  return { sections: docsBySection() };
}
