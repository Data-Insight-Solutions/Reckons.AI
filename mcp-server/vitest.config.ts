import { defineConfig } from 'vitest/config';

// Standalone config so Vite doesn't walk up into the parent SvelteKit
// project's vite.config.ts (which requires @sveltejs/kit/vite + app.html
// that don't exist in this package).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
  },
});
