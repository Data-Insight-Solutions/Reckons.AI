#!/usr/bin/env npx tsx
/**
 * EVERY DOCUMENTED CAPABILITY HAS ONE STATUS, AND IT IS THE ROADMAP'S (F222 phase 2; SCRIPT tier).
 *
 * Until 2026-09-29, 3 of the 41 capabilities in docs-features.ttl carried a status and none named
 * the roadmap entity it described, so a reader could not tell what works — and the one status that
 * was written down (Git Analysis, "functional") disagreed with the roadmap ("production"). Now a
 * capability names its roadmap entity with skos:exactMatch or skos:broadMatch and scripts/docs-pages.ts
 * reads the status from there. This check keeps that true:
 *
 *   - every capability (an entity in the urn:reckons:feature/ namespace of a docs graph) resolves to
 *     a status, or declares kpred:status-not-applicable with a reason
 *   - a capability with a mapping has no status of its own, so the two can never disagree
 *   - every mapping target exists in the roadmap graphs and has a status
 *
 * Usage:
 *   npx tsx scripts/offline/docs-status.ts           the capabilities, grouped by status
 *   npx tsx scripts/offline/docs-status.ts --check   exit 1 on any problem (CI / npm run align)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Parser, type Quad } from 'n3';
import { STATUS_GRAPHS, statusIndex } from '../docs-pages';

const FEATURE_NS = 'urn:reckons:feature/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const HAS_STATUS = 'urn:kbase:predicate/has-status';
const NOT_APPLICABLE = 'urn:kbase:predicate/status-not-applicable';
const EXACT = 'http://www.w3.org/2004/02/skos/core#exactMatch';
const BROAD = 'http://www.w3.org/2004/02/skos/core#broadMatch';

export type CapabilityStatus = { iri: string; status: string | null; via: 'exact' | 'broad' | 'own' | 'n/a' | null };

/** Every way the docs capabilities can fail to have exactly one status. Empty means they all do. */
export function checkDocsStatus(docsQuads: Quad[], statusOf: Map<string, string>): { problems: string[]; rows: CapabilityStatus[] } {
  const problems: string[] = [];
  const rows: CapabilityStatus[] = [];
  const capabilities = new Set(
    docsQuads.filter((q) => q.predicate.value === RDF_TYPE && q.subject.value.startsWith(FEATURE_NS)).map((q) => q.subject.value),
  );
  const values = (s: string, p: string) => docsQuads.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value);

  for (const iri of [...capabilities].sort()) {
    const name = iri.slice(FEATURE_NS.length);
    const exact = values(iri, EXACT), broad = values(iri, BROAD), own = values(iri, HAS_STATUS), na = values(iri, NOT_APPLICABLE);
    const mapped = [...exact, ...broad];

    if (na.length) {
      if (mapped.length || own.length) problems.push(`${name} says status is not applicable but also has a status or a mapping`);
      rows.push({ iri, status: null, via: 'n/a' });
      continue;
    }
    if (mapped.length && own.length) {
      problems.push(`${name} has its own has-status "${own[0]}" AND a roadmap mapping — remove the literal; the roadmap is where a status is written`);
    }
    for (const t of mapped) {
      if (!statusOf.has(t)) problems.push(`${name} maps to ${t}, which has no has-status in ${STATUS_GRAPHS.join(' or ')}`);
    }
    const target = exact.find((t) => statusOf.has(t)) ?? broad.find((t) => statusOf.has(t));
    if (target) rows.push({ iri, status: statusOf.get(target)!, via: exact.includes(target) ? 'exact' : 'broad' });
    else if (own.length) rows.push({ iri, status: own[0], via: 'own' });
    else {
      if (!mapped.length) problems.push(`${name} has no status — map it to its roadmap entity with skos:exactMatch or skos:broadMatch, or declare kpred:status-not-applicable with a reason`);
      rows.push({ iri, status: null, via: null });
    }
  }
  return { problems, rows };
}

function main(): void {
  const parse = (f: string) => new Parser().parse(readFileSync(join('static', f), 'utf8'));
  const docsFiles = readdirSync('static').filter((f) => f.startsWith('docs-') && f.endsWith('.ttl') && f !== 'docs-all.ttl');
  const { problems, rows } = checkDocsStatus(docsFiles.flatMap(parse), statusIndex(STATUS_GRAPHS.flatMap(parse)));

  if (!process.argv.includes('--check')) {
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.status ?? r.via ?? 'none', [...(by.get(r.status ?? r.via ?? 'none') ?? []), `${r.iri.slice(FEATURE_NS.length)}${r.via === 'broad' ? ' (via a broader feature)' : ''}`]);
    for (const [status, names] of [...by].sort()) console.log(`${status} (${names.length}): ${names.join(', ')}`);
  }
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  if (process.argv.includes('--check')) console.log(`✓ docs status: ${rows.length} documented capabilit${rows.length === 1 ? 'y' : 'ies'}, each with one status`);
}

if (process.argv[1] && process.argv[1].endsWith('docs-status.ts')) main();
