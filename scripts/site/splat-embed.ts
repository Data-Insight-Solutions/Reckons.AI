/**
 * Build a small self-contained embeddable viewer folder for ONE Gaussian splat (F294.7).
 *   npx tsx scripts/site/splat-embed.ts --splat=ring.spz --out=DIR [--title=...] [--poster=img] [--bg=#101010]
 * Writes index.html, viewer.css, loader.js (tiny, loads viewer.js when the frame nears the viewport), viewer.js (three + gaussian-splat-lite bundled), the splat and the poster.
 * Floating, slowly turning, drag to rotate; transparent unless --bg is given.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEmbedArgs, renderEmbedCss, renderEmbedHtml, VIEWER_ENTRY, LOADER_SOURCE } from './splat-embed-lib.js';

export async function buildEmbed(argv: string[]): Promise<string> {
  const a = parseEmbedArgs(argv);
  const out = resolve(a.out);
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'splat-embed-'));
  try {
    writeFileSync(join(tmp, 'entry.js'), VIEWER_ENTRY);
    await build({
      entryPoints: [join(tmp, 'entry.js')], bundle: true, format: 'iife', minify: true, logLevel: 'error',
      outfile: join(out, 'viewer.js'), nodePaths: [resolve(import.meta.dirname, '../../node_modules')],
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const splatFile = basename(a.splat);
  copyFileSync(resolve(a.splat), join(out, splatFile));
  const posterFile = a.poster ? basename(a.poster) : undefined;
  if (a.poster) copyFileSync(resolve(a.poster), join(out, posterFile!));
  writeFileSync(join(out, 'index.html'), renderEmbedHtml({ title: a.title, splatFile, posterFile }));
  writeFileSync(join(out, 'loader.js'), LOADER_SOURCE);
  writeFileSync(join(out, 'viewer.css'), renderEmbedCss(a.bg));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildEmbed(process.argv.slice(2)).then((o) => console.log(`splat viewer written to ${o}`), (e) => { console.error(e.message); process.exit(1); });
}
