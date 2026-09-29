import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'jsdom',
    // `cli/**` added 2026-09-10. The CLI had NO test coverage in CI at all — a test written
    // there would simply never have run, which is worse than not writing one.
    include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,ts}', 'cli/src/**/*.{test,spec}.{js,ts}', 'tests/bench/**/*.{test,spec}.{js,ts}', 'tests/visual/vision-*.{test,spec}.{js,ts}'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/*.svelte.ts', 'src/**/*.d.ts']
    },
    alias: {
      $lib: new URL('./src/lib', import.meta.url).pathname
    }
  }
});
