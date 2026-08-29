import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'path';

/**
 * Workbox normally precaches every generated JS/WASM asset. That defeats an
 * application-level opt-in: a fresh install would still download Kokoro,
 * Hume, Whisper/Transformers and ONNX before the user enabled voice.
 *
 * Generated chunks are content-hashed, so identify optional runtime chunks by
 * stable source strings instead of brittle filenames. They remain available
 * on demand and the runtime cache stores them after the explicit first use.
 */
function isOptInRuntimeAsset(url: string): boolean {
  if (url.endsWith('.wasm')) return true;
  if (!url.endsWith('.js')) return false;

  const relative = decodeURIComponent(url).replace(/^\/+/, '');
  const clientRelative = relative.replace(/^client\//, '');
  const candidates = [
    path.resolve(process.cwd(), 'build', clientRelative),
    path.resolve(process.cwd(), '.svelte-kit/output', relative),
    path.resolve(process.cwd(), '.svelte-kit/output/client', clientRelative),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return false;

  const source = fs.readFileSync(file, 'utf8');
  return [
    'Kokoro-82M-v1.0-ONNX',
    'KokoroTTS',
    'automatic-speech-recognition',
    'Whisper download declined',
    'empathicVoice',
    'HumeClient',
    'EVIWebAudioPlayer',
    'onnxruntime-web',
  ].some((marker) => source.includes(marker));
}

/** Preserve @vite-pwa/sveltekit's public-URL mapping when adding our custom
 * manifest transform (the integration only injects its own transform when no
 * custom transform is supplied). */
function toPublicPrecacheUrl(url: string): string | null {
  if (url === 'prerendered/fallback.html') return null;
  if (url.startsWith('client/')) url = url.slice(7);
  else if (url.startsWith('prerendered/dependencies/')) url = url.slice(25);
  else if (url.startsWith('prerendered/pages/')) url = url.slice(18);

  if (url.endsWith('.html')) {
    if (url === 'index.html') return '/';
    if (url.endsWith('/index.html')) return url.slice(0, -11);
    return url.slice(0, -5);
  }
  return url === 'manifest.webmanifest' ? null : url;
}

export default defineConfig({
  plugins: [
    // Tailwind v4 powers the shadcn-svelte design-system foundation only.
    // src/lib/styles/tailwind.css imports theme + utilities layers WITHOUT
    // preflight, so the hand-rolled Liquid theme in global.css is untouched.
    tailwindcss(),
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
        orientation: 'any',
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
        manifestTransforms: [async (entries) => ({
          manifest: entries.flatMap((entry) => {
            if (isOptInRuntimeAsset(entry.url)) return [];
            const url = toPublicPrecacheUrl(entry.url);
            return url ? [{ ...entry, url }] : [];
          }),
          warnings: [],
        })],
        runtimeCaching: [
          {
            // Lazy app runtimes (voice/ML and optional 3D decoders) are cached
            // only after a feature requests them, never during PWA install.
            urlPattern: /\/(?:_app\/immutable|draco\/).+\.(?:js|wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opt-in-app-runtimes',
              expiration: { maxEntries: 40, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            }
          },
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
