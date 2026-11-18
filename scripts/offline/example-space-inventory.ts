#!/usr/bin/env npx tsx
/**
 * EXAMPLE INVENTORY (F263 phase 1; SCRIPT tier: deterministic, zero tokens).
 *
 * "More compelling" needs a before and after. This counts, for every bundled example (the ones the
 * app lists in src/lib/storage/example-kbs.ts, plus any other static/starter-*.ttl): statements,
 * typed vs untyped entities, which built-in entity types are used, people without a picture, hubs
 * (the app's own hubNodeKeys rule) without a picture, splat or 3D model, assets with and without a
 * receipt, story and step counts, and sources by review status.
 *
 * Usage:
 *   npx tsx scripts/offline/example-space-inventory.ts            table to stdout
 *   npx tsx scripts/offline/example-space-inventory.ts --json     machine-readable
 *   npx tsx scripts/offline/example-space-inventory.ts --pending  ONE summary proposal per example
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Parser } from 'n3';
import { EXAMPLE_KBS } from '../../src/lib/storage/example-kbs';
import { BUILT_IN_TYPES } from '../../src/lib/rdf/entity-types';
import { queueFindings } from './pending-queue.ts';
import { gapsOf, inventorySpace, type SpaceInventory, type Triple } from './lib/example-space-inventory.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const STATIC = path.join(ROOT, 'static');

export function readTriples(file: string): Triple[] {
  const quads = new Parser().parse(readFileSync(file, 'utf8'));
  return quads.map((q) => ({
    s: q.subject.termType === 'BlankNode' ? `_:${q.subject.value}` : q.subject.value,
    p: q.predicate.value,
    o: q.object.value,
    oKind: q.object.termType === 'Literal' ? 'literal' : q.object.termType === 'BlankNode' ? 'bnode' : 'iri',
  }));
}

/** /generated/<dir>/<file> has a receipt when static/generated/<dir>/receipt.json exists. */
export const hasReceipt = (assetPath: string): boolean => {
  const m = /^\/generated\/([^/]+)\//.exec(assetPath);
  return !!m && existsSync(path.join(STATIC, 'generated', m[1], 'receipt.json'));
};

export type Row = { id: string; file: string; listed: boolean; unlisted: boolean; inv: SpaceInventory };

/**
 * F263 SCOPE (Matt, 2026-11-17, relayed by the local deputy): the review-0.2.x release spaces are NOT example
 * spaces; their home is the workspace, so they stay out of this inventory. Filter by the review- id, NOT by
 * `unlisted`: ring-scan is also unlisted but is a real example (F292.3, linked from a published site).
 */
export const inF263Scope = (id: string): boolean => !/^review-/.test(id);

export function collect(): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const e of EXAMPLE_KBS) {
    const file = e.file.replace(/^\//, '');
    const full = path.join(STATIC, file);
    seen.add(file);
    if (!existsSync(full) || !inF263Scope(e.id)) continue;
    rows.push({ id: e.id, file, listed: !e.unlisted, unlisted: !!e.unlisted, inv: inventorySpace(readTriples(full), { hasReceipt }) });
  }
  for (const f of readdirSync(STATIC).filter((n) => /^starter.*\.ttl$/.test(n)).sort()) {
    if (seen.has(f) || !inF263Scope(f.replace(/\.ttl$/, ''))) continue;
    rows.push({ id: f.replace(/\.ttl$/, ''), file: f, listed: false, unlisted: false, inv: inventorySpace(readTriples(path.join(STATIC, f)), { hasReceipt }) });
  }
  return rows;
}

function table(rows: Row[]): string {
  const head = ['space', 'shown', 'stmts', 'ents', 'typed%', 'types(b/avail)', 'people(no img)', 'hubs(no asset)', 'assets(rcpt/cred/none)', 'story(steps)', 'sources(rev/total)'];
  const body = rows.map((r) => {
    const i = r.inv;
    return [
      r.id, r.listed ? 'listed' : r.unlisted ? 'unlisted' : 'bundled only', String(i.statements), String(i.entities), `${i.typedPercent}%`,
      `${i.builtInUsed.length}/${i.builtInAvailable}`, `${i.people}(${i.peopleWithoutImage.length})`, `${i.hubs}(${i.hubsWithoutAsset.length})`,
      `${i.assets.references}(${i.assets.receipted}/${i.assets.credited}/${i.assets.unrecorded})`, `${i.story.stories}(${i.story.steps})`, `${i.sources.review}/${i.sources.total}`,
    ];
  });
  const all = [head, ...body];
  const w = head.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  const line = (r: string[]) => r.map((v, c) => v.padEnd(w[c])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

if (process.argv[1]?.endsWith('example-space-inventory.ts')) {
  const argv = process.argv.slice(2);
  const rows = collect();
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ builtInTypes: BUILT_IN_TYPES.map((t) => t.iri), spaces: rows }, null, 2));
  } else {
    console.log(table(rows));
    console.log(`\n${rows.length} bundled spaces; ${BUILT_IN_TYPES.length} built-in entity types available. Columns: types = built-in types used / available; assets = local file references (receipted / credited only / neither).`);
  }
  if (argv.includes('--pending')) {
    const findings = rows.flatMap((r) => {
      const gaps = gapsOf(r.inv);
      if (gaps.length === 0) return [];
      return [{
        subject: `urn:example:space/${r.id}`,
        predicate: 'urn:kbase:predicate/example-space-gap',
        kb: 'roadmap',
        question: `[example-space-inventory] ${r.id} (${r.file}): ${gaps.join('; ')}.`,
        type: 'suggestion' as const,
        priority: 'low' as const,
      }];
    });
    // Recomputed every run, so a gap that has been filled drops out of the queue.
    const { queued, superseded } = queueFindings(findings, { agent: 'example-space-inventory', recomputes: true });
    console.error(`pending: ${findings.length} summary row(s), ${queued} queued, ${superseded} superseded`);
  }
}
