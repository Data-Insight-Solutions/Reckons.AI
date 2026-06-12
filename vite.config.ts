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
        maximumFileSizeToCacheInBytes: 50_000_000,
        runtimeCaching: [
          {
            // Cache HuggingFace model files (ONNX weights, tokenizers, configs)
            // after first download so WASM LLM + embeddings work offline.
            urlPattern: /^https:\/\/huggingface\.co\/.+\/(resolve|raw)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'hf-models',
              expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            }
          },
          {
            // Cache CDN assets (ONNX WASM runtime fallback from jsdelivr)
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.+\.(wasm|mjs|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-assets',
              expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            }
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      // onnxruntime-node is a Node.js-only native addon. @huggingface/transformers imports
      // it statically alongside onnxruntime-web and selects at runtime via process.release.
      // In a browser/worker context Vite bundles the real addon whose module-level init
      // calls registerBackend() on undefined browser APIs — crashing the worker.
      // Aliasing to an empty stub lets the import succeed; the node branch is never taken.
      'onnxruntime-node': path.resolve('./src/lib/integrations/llm/onnx-node-stub.js')
    }
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  ssr: { noExternal: ['bits-ui', 'svelte-toolbelt', 'runed'] }
});
