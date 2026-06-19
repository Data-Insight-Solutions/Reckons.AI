/**
 * Vite build config for the browser extension.
 * Output goes to dist/extension/ — load this folder as an unpacked extension.
 *
 * Build:  pnpm build:extension
 * Watch:  pnpm dev:extension
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import type { Plugin } from 'vite';

function copyExtensionAssets(): Plugin {
  const src = resolve(__dirname, 'src/extension');
  const out = resolve(__dirname, 'dist/extension');

  function copyStatics() {
    const statics = [
      'manifest.json',
      'popup.html',
      'options.html',
      'sidepanel.html',
      'highlight.css',
      'popup.css',
      'sidepanel.css',
      'offscreen.html',
      'live-overlay.css',
    ];
    mkdirSync(out, { recursive: true });
    mkdirSync(resolve(out, 'icons'), { recursive: true });
    for (const f of statics) {
      const s = resolve(src, f);
      if (existsSync(s)) copyFileSync(s, resolve(out, f));
    }
    // Copy icons if they exist
    const iconsDir = resolve(src, 'icons');
    if (existsSync(iconsDir)) {
      for (const f of readdirSync(iconsDir)) {
        copyFileSync(resolve(iconsDir, f), resolve(out, 'icons', f));
      }
    }
  }

  return {
    name: 'copy-extension-assets',
    buildStart: copyStatics,
    writeBundle: copyStatics,
    handleHotUpdate: copyStatics,
  };
}

export default defineConfig({
  plugins: [copyExtensionAssets()],
  build: {
    outDir: 'dist/extension',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        background:       resolve(__dirname, 'src/extension/background.ts'),
        'content-script': resolve(__dirname, 'src/extension/content-script.ts'),
        popup:            resolve(__dirname, 'src/extension/popup.ts'),
        sidepanel:        resolve(__dirname, 'src/extension/sidepanel.ts'),
        options:          resolve(__dirname, 'src/extension/options.ts'),
        offscreen:        resolve(__dirname, 'src/extension/offscreen.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        // Each entry should be standalone — no shared chunks
        manualChunks: undefined,
        inlineDynamicImports: false,
      },
    },
  },
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/lib'),
      'onnxruntime-node': resolve(__dirname, 'src/lib/integrations/llm/onnx-node-stub.js'),
    },
  },
});
