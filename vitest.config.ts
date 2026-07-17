import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,ts}', 'tests/bench/**/*.{test,spec}.{js,ts}', 'tests/visual/vision-*.{test,spec}.{js,ts}'],
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
