#!/usr/bin/env npx tsx
/**
 * Space-size bench (F107.10 kb:space-file-layout) — what does ONE large space .ttl cost?
 *
 * Matt, 2026-10-06: "Fold the chunks in. We should benchmark and find out performance impacts at
 * different sizes." This measures the three code paths that read or write a space file today, on
 * synthetic spaces of increasing size, each WITH and WITHOUT source chunks folded in:
 *
 *   serialize  toTurtleFull (the app's export) + chunksToTurtle per source (what folding appends)
 *   import     importTurtleFull (the app's import: N3 TriG parse → Statement[] + Source[])
 *   mcp-load   N3 Parser → Store (what mcp-server/src/kb-reader.ts does per KB)
 *
 * NOT MEASURED HERE: the browser's IndexedDB write and the graph render after import, which run
 * only in a browser. Node timings are a lower bound on what a person waits for.
 *
 * Synthetic data only: generated words, no captured text. Deterministic (seeded), so two runs
 * measure the same bytes.
 *
 * Usage:
 *   npx tsx --expose-gc tests/bench/run-space-size-bench.ts [--profiles=s,m,l] [--runs=3] [--save]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser, Store } from 'n3';
import { importTurtleFull } from '../../src/lib/rdf/import-ttl';
import { PROFILES, renderSpace, type Profile } from './lib/synthetic-space';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const RUNS = Number(flag('runs') ?? 3);
const SAVE = args.includes('--save');
const wanted = flag('profiles')?.split(',') ?? ['s', 'm', 'l', 'xl'];
const profiles = PROFILES.filter((p) => wanted.includes(p.key));

// ── measurement ──────────────────────────────────────────────────────────────────────────────
const gc = (globalThis as { gc?: () => void }).gc;
const heapMb = () => { gc?.(); return process.memoryUsage().heapUsed / 1e6; };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time<T>(fn: () => T | Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

type Row = {
  profile: string; chunks: 'folded' | 'none'; statements: number; sources: number;
  bytes: number; chunkBytes: number; quads: number;
  serializeMs: number; importMs: number; mcpLoadMs: number; importHeapMb: number;
  importedStatements: number;
};

async function measure(p: Profile, folded: boolean): Promise<Row> {
  const serialize = () => renderSpace(p, folded);

  const ser: number[] = [], imp: number[] = [], mcp: number[] = [], heap: number[] = [];
  let ttl = '', chunkBytes = 0, quads = 0, importedStatements = 0;
  for (let r = 0; r < RUNS; r++) {
    const s = await time(serialize);
    ser.push(s.ms); ttl = s.value.ttl; chunkBytes = s.value.chunkBytes;
    const before = heapMb();
    const i = await time(() => importTurtleFull(ttl));
    imp.push(i.ms);
    heap.push(Math.max(0, process.memoryUsage().heapUsed / 1e6 - before));
    importedStatements = i.value.statements.length;
    const m = await time(() => { const store = new Store(); store.addQuads(new Parser({ format: 'TriG' }).parse(ttl)); return store.size; });
    mcp.push(m.ms); quads = m.value;
  }
  return {
    profile: p.key, chunks: folded ? 'folded' : 'none', statements: p.statements, sources: p.sources,
    bytes: Buffer.byteLength(ttl), chunkBytes, quads,
    serializeMs: median(ser), importMs: median(imp), mcpLoadMs: median(mcp), importHeapMb: median(heap),
    importedStatements,
  };
}

const rows: Row[] = [];
// Warm-up, discarded: the first parse of the process pays for JIT compilation of N3 and the importer.
await measure(PROFILES[0], true);
console.log(`Space-size bench — ${RUNS} run(s) per cell, median. gc ${gc ? 'on' : 'OFF (pass --expose-gc for heap figures)'}.\n`);
for (const p of profiles) {
  for (const folded of [false, true]) {
    const row = await measure(p, folded);
    rows.push(row);
    const mb = (b: number) => (b / 1e6).toFixed(1);
    console.log(
      `${p.key.padEnd(3)} ${row.chunks.padEnd(6)} ${String(p.statements).padStart(7)} st  ${mb(row.bytes).padStart(6)} MB` +
      ` (chunks ${mb(row.chunkBytes)} MB)  quads ${String(row.quads).padStart(8)}` +
      `  serialize ${row.serializeMs.toFixed(0).padStart(6)} ms  import ${row.importMs.toFixed(0).padStart(6)} ms` +
      `  mcp ${row.mcpLoadMs.toFixed(0).padStart(6)} ms  heap +${row.importHeapMb.toFixed(0)} MB` +
      `  imported ${row.importedStatements}`,
    );
  }
}

if (SAVE) {
  const dir = resolve(import.meta.dirname ?? '.', 'results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `space-size-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify({ node: process.version, runs: RUNS, rows }, null, 2));
  console.log(`\nsaved ${file}`);
}
