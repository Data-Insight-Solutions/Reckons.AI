#!/usr/bin/env npx tsx
/**
 * Render every three.js scene declared in the docs graphs into committed PNGs (F190).
 *
 * THE SAME SPLIT `docs-diagrams.ts` ENFORCES, for the same reason. `docs-pages.ts` never renders —
 * it looks a scene up by hash and fails loudly naming this command. Rendering needs a browser and
 * a GPU, so it happens once, deliberately, on a developer's machine, and the frame is reviewed in
 * a PR like any other artifact. CI and the docs build only ever read it.
 *
 * Determinism is the reason, not speed: a GPU and a software rasteriser do not produce identical
 * pixels, so a CI re-render would show a diff nobody wrote — the same trap that made the diagram
 * cache committed rather than generated.
 *
 * Usage:
 *   npx tsx scripts/docs-scenes.ts            render anything missing
 *   npx tsx scripts/docs-scenes.ts --check    report what is missing, render nothing (CI)
 *   npx tsx scripts/docs-scenes.ts --force    re-render everything (after a contract bump)
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { Parser, type Quad } from 'n3';
import { loadSceneCache, saveSceneCache, sceneKey, renderScenes, SCENE_DIR, type SceneSpec } from './lib/scene-render.js';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const STATIC_DIR = join(ROOT, 'static');
export const SCENE_PREDICATE = 'urn:kbase:predicate/scene';
const SCENE_WIDTH = 'urn:kbase:predicate/scene-width';
const SCENE_HEIGHT = 'urn:kbase:predicate/scene-height';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const FORCE = argv.includes('--force');

function ttlFiles(): string[] {
  return readdirSync(STATIC_DIR).filter((f) => f.endsWith('.ttl')).map((f) => join(STATIC_DIR, f));
}

function collect(): Map<string, SceneSpec> {
  const specs = new Map<string, SceneSpec>();
  for (const file of ttlFiles()) {
    let quads: Quad[];
    try { quads = new Parser().parse(readFileSync(file, 'utf8')); } catch { continue; }
    const dims = new Map<string, { w?: number; h?: number }>();
    for (const q of quads) {
      if (q.predicate.value === SCENE_WIDTH) dims.set(q.subject.value, { ...dims.get(q.subject.value), w: Number(q.object.value) });
      if (q.predicate.value === SCENE_HEIGHT) dims.set(q.subject.value, { ...dims.get(q.subject.value), h: Number(q.object.value) });
    }
    for (const q of quads) {
      if (q.predicate.value !== SCENE_PREDICATE || q.object.termType !== 'Literal') continue;
      const d = dims.get(q.subject.value) ?? {};
      specs.set(sceneKey(q.object.value), { source: q.object.value, width: d.w, height: d.h });
    }
  }
  return specs;
}

async function main(): Promise<void> {
  const declared = collect();
  const cache = loadSceneCache();
  const missing = new Map(
    [...declared].filter(([k]) => FORCE || !cache[k] || !existsSync(join(SCENE_DIR, `${k}.png`))),
  );

  console.log(`${declared.size} scene(s) declared across the graphs.`);
  if (missing.size === 0) { console.log('✓ nothing to render — every scene is already committed.'); return; }

  if (CHECK) {
    console.error(`✗ ${missing.size} scene(s) missing. Run: npm run docs:scenes`);
    process.exit(1);
  }

  console.log(`Rendering ${missing.size} scene(s) — launching Chromium…`);
  const rendered = await renderScenes(missing);
  for (const [k, size] of rendered) cache[k] = size;
  // Drop entries no graph declares any more, so the cache cannot grow forever.
  for (const k of Object.keys(cache)) if (!declared.has(k)) delete cache[k];
  saveSceneCache(cache);
  console.log(`✓ rendered ${rendered.size}. Frames in static/scenes/, index in static/scene-cache.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
