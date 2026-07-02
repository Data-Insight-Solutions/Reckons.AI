import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { mdsvex } from 'mdsvex';

// F27 Phase 2 (Graph Publishing): mdsvex compiles content/**/*.md (frontmatter +
// markdown body written by src/lib/publish/site-export.ts) into Svelte components
// so the /docs route group can import them directly via import.meta.glob. The rest
// of the app is untouched — this only adds `.md` as a recognised component
// extension; adapter-static + the fallback SPA behaviour for every other route are
// unchanged, and adapter stays adapter-static (no swap).
/** @type {import('@sveltejs/kit').Config} */
const config = {
  extensions: ['.svelte', '.md'],
  preprocess: [vitePreprocess(), mdsvex({ extension: '.md' })],
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true
    }),
    alias: {
      $lib: './src/lib'
    }
  }
};

export default config;
