#!/usr/bin/env npx tsx
/**
 * Turn a plain demo graph into one that ARRIVES AS REVIEW WORK.
 *
 * THE PROBLEM THIS SOLVES, measured 2026-08-21: demo-decision-tree.ttl is 87 plain triples, so
 * `isAnnotated` is false in kb-import.ts and every statement is imported as CONFIRMED. Synced into
 * a workspace the whole graph lands settled, the review queue is empty, and /review correctly shows
 * an empty tree — which reads as "the tree is broken" when the tree is fine and the fixture simply
 * arrived as finished knowledge.
 *
 * The annotated (toTurtleFull) format carries each statement's real status, and kb-import preserves
 * it verbatim. So the fix is not a flag at import time but a fixture that STATES what it is.
 *
 * Deterministic, zero tokens (F74.3 script tier). Round-trips through the app's own importer and
 * serializer rather than hand-writing annotation, because hand-written annotation is exactly the
 * kind of thing that drifts from the parser that has to read it.
 *
 *   npx tsx scripts/offline/make-review-fixture.ts <in.ttl> [--out=<path>]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { importTurtleFull } from '../../src/lib/rdf/import-ttl.js';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import type { Source, Statement } from '../../src/lib/rdf/types.js';

const C = { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', r: '\x1b[31m', x: '\x1b[0m' };
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const out = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? input;

if (!input || !existsSync(input)) {
  console.error(`Usage: npx tsx scripts/offline/make-review-fixture.ts <in.ttl> [--out=<path>]`);
  process.exit(1);
}

const ttl = readFileSync(input, 'utf8');
const { statements, sources, cleanImportCount } = await importTurtleFull(ttl);
if (!statements.length) { console.error(`${C.r}No statements parsed from ${input}${C.x}`); process.exit(1); }

if (cleanImportCount === 0) {
  console.log(`${C.d}${input} is already annotated — nothing to do.${C.x}`);
  process.exit(0);
}

// One synthetic source, so every pending fact has provenance a reviewer can see.
const now = Date.now();
const sourceId = sources[0]?.id ?? `demo-${now}`;
const outSources: Source[] = sources.length ? sources : [{
  id: sourceId,
  title: input.split('/').pop()?.replace(/\.ttl$/, '') ?? 'demo',
  uri: `file://${input}`,
  kind: 'document',
  trustLevel: 'trusted',
  ingestedAt: now,
} as Source];

const pending: Statement[] = statements.map((s, i) => ({
  ...s,
  id: s.id || `st-${i}`,
  sourceId: s.sourceId || sourceId,
  status: 'pending' as const,
  createdAt: s.createdAt || now,
  updatedAt: s.updatedAt || now,
}));

// Keep the authored comment header: it is what makes the fixture judgeable rather than just
// viewable, and the serializer would otherwise drop it.
const header = ttl.split('\n').filter((l) => l.startsWith('#')).join('\n');

const annotated = toTurtleFull(pending, outSources, { header });
writeFileSync(out!, annotated);

// Prove it: re-read what was just written and check the importer will keep it pending.
const back = await importTurtleFull(readFileSync(out!, 'utf8'));
const statuses = new Map<string, number>();
for (const s of back.statements) statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
const ok = back.cleanImportCount === 0 && statuses.get('pending') === back.statements.length;

console.log(`${C.b}${input}${C.x} → ${C.b}${out}${C.x}`);
console.log(`  ${statements.length} statement(s) · was ${cleanImportCount} plain triple(s)`);
console.log(`  re-read: ${back.statements.length} statement(s), cleanImportCount ${back.cleanImportCount}, ` +
  `statuses ${JSON.stringify(Object.fromEntries(statuses))}`);
console.log(ok
  ? `  ${C.g}✓ imports as review work — the whole graph will arrive pending${C.x}`
  : `  ${C.r}✗ round-trip did NOT produce an annotated pending file — do not ship this${C.x}`);
process.exit(ok ? 0 : 1);
