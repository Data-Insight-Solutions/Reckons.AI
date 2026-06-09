import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  plugins: [
    sveltekit(),
    SvelteKitPWA({
      strategies: 'generateSW',
      registerType: 'autoUpdate',
      manifest: {
        name: 'Reckons.AI',
        short_name: 'Reckons',
        description: 'The semantic understanding knowledge graph that you review and automatically edit, compare, and share.',
        theme_color: '#0a0a0b',
        background_color: '#0a0a0b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 50_000_000
      }
    })
  ],
  resolve: {
    alias: {
      // onnxruntime-node is a Node.js-only native addon. @xenova/transformers imports
      // it statically alongside onnxruntime-web and selects at runtime via process.release.
      // In a browser/worker context Vite bundles the real addon whose module-level init
      // calls registerBackend() on undefined browser APIs — crashing the worker.
      // Aliasing to an empty stub lets the import succeed; the node branch is never taken.
      'onnxruntime-node': path.resolve('./src/lib/integrations/llm/onnx-node-stub.js')
    }
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@xenova/transformers', '@huggingface/transformers', 'onnxruntime-web'] },
  ssr: { noExternal: ['bits-ui', 'svelte-toolbelt', 'runed'] }
});
