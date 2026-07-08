import type { StorybookConfig } from '@storybook/sveltekit';
import path from 'path';

/**
 * Storybook 8 config for Reckons.AI.
 *
 * Key concern: SvelteKit-specific modules ($app/state, $app/stores, etc.)
 * do not exist outside the SvelteKit runtime. We alias them to lightweight
 * mock modules so components render correctly in isolation.
 *
 * Similarly, global Svelte stores (kb.svelte.ts, settings.svelte.ts) that
 * read IndexedDB are replaced with static-data mocks so stories work
 * without a running browser extension or database.
 */
const config: StorybookConfig = {
  stories: ['../src/stories/**/*.stories.@(ts|svelte)'],
  addons: [
    '@storybook/addon-essentials',
  ],
  framework: {
    name: '@storybook/sveltekit',
    options: {},
  },
  viteFinal: async (config) => {
    const r = (p: string) => path.resolve(__dirname, p);

    // Merge aliases — keep any existing ones from vite.config.ts
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),

      // ── SvelteKit runtime modules ────────────────────────────────────────
      '$app/state':      r('mocks/app-state.ts'),
      '$app/stores':     r('mocks/app-stores.ts'),
      '$app/navigation': r('mocks/app-navigation.ts'),
      '$app/environment': r('mocks/app-environment.ts'),

      // ── Global Svelte stores (IndexedDB / reactive) ──────────────────────
      '$lib/stores/kb.svelte':           r('mocks/kb-store.ts'),
      '$lib/stores/settings.svelte':     r('mocks/settings-store.ts'),
      '$lib/stores/auto-analyze.svelte': r('mocks/auto-analyze-store.ts'),
      '$lib/stores/entity-types.svelte': r('mocks/entity-types-store.ts'),
      '$lib/stores/snap-layout.svelte':  r('mocks/snap-layout-store.ts'),
      '$lib/stores/shelly-bridge.svelte': r('mocks/shelly-bridge-store.ts'),
      '$lib/stores/notifications.svelte': r('mocks/notifications-store.ts'),
      '$lib/stores/perf-monitor.svelte': r('mocks/perf-monitor-store.ts'),
      '$lib/stores/gif-overrides.svelte': r('mocks/gif-overrides-store.ts'),
      '$lib/stores/glb-overrides.svelte': r('mocks/glb-overrides-store.ts'),

      // ── Node.js-only package (ONNX node runtime) ────────────────────────
      'onnxruntime-node': r('../src/lib/integrations/llm/onnx-node-stub.js'),
    };

    return config;
  },
};

export default config;
