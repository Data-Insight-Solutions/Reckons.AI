#!/usr/bin/env npx tsx
/**
 * Code sprawl / duplication detector (Matt, 2026-07-15: "add evaluation of sprawl or duplication
 * of files or code to the loop").
 *
 * The clipboard crash was near-identical `navigator.clipboard.writeText` copy-pasted into several
 * files; the label overlay was one component duplicated into two pages. Both are the same disease —
 * separate code for nearly the same task — and both are DETECTABLE by a rule. This is the code-level
 * companion to shared-deps.ts (which works at the roadmap level).
 *
 * Method: a copy-paste detector. Each source file is reduced to its SIGNIFICANT lines (comments,
 * imports, blanks and trivia dropped). A window of K consecutive significant lines is hashed; a
 * window whose hash appears in TWO OR MORE files is a duplicated block. Deterministic, zero tokens.
 *
 *   npx tsx scripts/offline/code-sprawl.ts             report duplication + sprawl metrics
 *   npx tsx scripts/offline/code-sprawl.ts --window=8  bigger blocks only (fewer, stronger)
 *   npx tsx scripts/offline/code-sprawl.ts --ci        exit 1 if duplication exceeds the budget
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const WINDOW = Number(process.argv.find((a) => a.startsWith('--window='))?.split('=')[1] ?? 6);
const CI = process.argv.includes('--ci');
const DUP_BUDGET = 40; // cross-file duplicate blocks tolerated before --ci fails (ratchet down over time)
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';

const ROOTS = ['src', 'scripts', 'mcp-server/src', 'cli'];
const EXT = /\.(ts|svelte|js)$/;
// Skip generated/vendored trees: shadcn primitives (components/ui) are generated boilerplate whose
// "duplication" is intended and not ours to consolidate.
const SKIP_DIR = /node_modules|\.svelte-kit|dist|build|\.vite|components\/ui\//;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, out);
    else if (EXT.test(p)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

/** A significant line: real code, worth comparing. Drops trivia so a run of `}`/imports/comments
 *  does not read as "duplication". */
function significant(line: string): string | null {
  const t = line.trim();
  if (t.length < 8) return null; // too short to be meaningful duplication
  if (/^(import|export \{|\/\/|\/\*|\*|<!--|@|})/.test(t)) return null;
  if (/^[)\]}>;,]+$/.test(t)) return null;
  // Framework/markup boilerplate — a `<script lang="ts">` tag or a bare `return {` is not
  // "duplicated logic", it is the shape every file of that kind has.
  if (/^(<script|<\/|<style|<template|\{@|return \{$|const argv = process\.argv|ref = \$bindable)/.test(t)) return null;
  return t.replace(/\s+/g, ' ');
}

// hash → list of {file, line} where a K-window with that content starts
const windows = new Map<string, { file: string; line: string; startLine: number }[]>();
const lineCounts: { file: string; lines: number }[] = [];

for (const file of files) {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rawLines = raw.split('\n');
  lineCounts.push({ file, lines: rawLines.length });
  const sig: { text: string; n: number }[] = [];
  rawLines.forEach((l, i) => {
    const s = significant(l);
    if (s) sig.push({ text: s, n: i + 1 });
  });
  for (let i = 0; i + WINDOW <= sig.length; i++) {
    const slice = sig.slice(i, i + WINDOW);
    const key = slice.map((s) => s.text).join('');
    const entry = { file, line: slice[0].text, startLine: slice[0].n };
    const arr = windows.get(key);
    if (arr) arr.push(entry);
    else windows.set(key, [entry]);
  }
}

// Cross-file duplicates: same window content in >=2 DISTINCT files. Collapse overlapping windows
// per file-pair set by keeping the first occurrence per (sorted file set).
const dupes: { files: string[]; sample: string; where: string[] }[] = [];
const seenSets = new Set<string>();
for (const [, entries] of windows) {
  const distinctFiles = [...new Set(entries.map((e) => e.file))];
  if (distinctFiles.length < 2) continue;
  const setKey = distinctFiles.sort().join('|') + '::' + entries[0].line;
  if (seenSets.has(setKey)) continue;
  seenSets.add(setKey);
  dupes.push({
    files: distinctFiles,
    sample: entries[0].line,
    where: entries.map((e) => `${e.file}:${e.startLine}`),
  });
}
dupes.sort((a, b) => b.files.length - a.files.length || b.where.length - a.where.length);

console.log(`${B}Code sprawl / duplication${X} ${D}— ${files.length} files, window ${WINDOW} significant lines${X}\n`);

console.log(`${B}${Y}cross-file duplicated blocks${X} ${D}— same ${WINDOW}-line block in >1 file (separate code, same task?)${X}`);
if (dupes.length === 0) console.log(`  ${G}none${X}`);
for (const d of dupes.slice(0, 25)) {
  console.log(`  ${B}${d.files.length} files${X} ${D}·${X} ${d.sample.slice(0, 70)}${d.sample.length > 70 ? '…' : ''}`);
  console.log(`     ${D}${d.where.slice(0, 4).join('  ')}${d.where.length > 4 ? ' …' : ''}${X}`);
}

// Sprawl metrics
const bySize = [...lineCounts].sort((a, b) => b.lines - a.lines);
console.log(`\n${B}sprawl metrics${X}`);
console.log(`  largest files: ${D}${bySize.slice(0, 5).map((f) => `${f.file.split('/').pop()} (${f.lines})`).join(', ')}${X}`);
const huge = bySize.filter((f) => f.lines > 1500);
if (huge.length) console.log(`  ${Y}${huge.length} file(s) over 1500 lines${X} ${D}— ${huge.map((f) => f.file.split('/').pop()).join(', ')} (split candidates)${X}`);

console.log(`\n${D}${dupes.length} cross-file duplicate block(s) (budget ${DUP_BUDGET}). Read as "should these share a module?", not "bug".${X}`);
if (CI && dupes.length > DUP_BUDGET) {
  console.log(`${Y}--ci: ${dupes.length} duplicate blocks exceeds budget ${DUP_BUDGET}.${X}`);
  process.exit(1);
}
