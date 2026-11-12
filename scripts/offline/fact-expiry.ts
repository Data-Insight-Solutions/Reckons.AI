#!/usr/bin/env npx tsx
/**
 * Fact expiry (F293, SCRIPT tier) — which facts a site states are past their valid-until date, which are
 * about to be, and which have no date yet. No model, no network: a date compared with today's date.
 *
 *   npx tsx scripts/offline/fact-expiry.ts [--built=<site:build output> | --ttl=<example .ttl> | --site=<site repository>]
 *                                          [--warn-days=60] [--today=YYYY-MM-DD]
 *
 * With no source it reads the committed Data Insight Solutions example. Each fact is listed with EVERY
 * page that states it. Exit 1 when a fact is past its date; open dates and facts inside the warning window
 * are reported and do not fail. A past date is never inferred: only a fact's own valid-until date counts.
 * (site:build applies the same refusal to the pages it is about to publish.)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, type Quad } from 'n3';
import {
  DEFAULT_WARNING_DAYS, FACTS_FILE, STATED_ON_PREDICATE, VALID_UNTIL_PREDICATE, classifyExpiry, describeExpiry,
  expiryFactsFromContent, parseFactsFile, todayUtc, type ExpiryFact,
} from '../../src/lib/publish/site-expiry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const META_STATUS = 'urn:kbase:meta/status';
const URL_PRED = 'urn:kbase:predicate/url';

/** The facts a Turtle file states: every valid-until fact still alive, with the pages that say it. */
export function factsFromTurtle(ttl: string): ExpiryFact[] {
  const quads: Quad[] = new Parser().parse(ttl);
  const objects = (s: string, p: string): string[] => quads.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value);
  const first = (s: string, p: string): string | undefined => objects(s, p)[0];
  const facts = new Map<string, ExpiryFact>();
  for (const st of quads.filter((q) => q.predicate.value === RDF + 'type' && q.object.value === RDF + 'Statement')) {
    const id = st.subject.value;
    if (first(id, RDF + 'predicate') !== VALID_UNTIL_PREDICATE) continue;
    const status = first(id, META_STATUS);
    if (status === 'rejected' || status === 'superseded') continue;
    const subject = first(id, RDF + 'subject') as string;
    const object = first(id, RDF + 'object') as string;
    const pages = quads.filter((q) => q.subject.value === subject && q.predicate.value === STATED_ON_PREDICATE).map((q) => {
      const url = first(q.object.value, URL_PRED);
      let p = first(q.object.value, RDFS_LABEL) ?? q.object.value;
      if (url) { try { p = new URL(url).pathname; } catch { p = url; } }
      return { slug: q.object.value, path: p };
    }).sort((a, b) => a.path.localeCompare(b.path));
    facts.set(subject, { id: subject, label: first(subject, RDFS_LABEL) ?? subject, validUntil: object === '?' ? null : object, pages });
  }
  return [...facts.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => argv.find((a) => a.startsWith('--' + n + '='))?.split('=').slice(1).join('=');
  const windowDays = arg('warn-days') ? Number(arg('warn-days')) : DEFAULT_WARNING_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 0) { console.error('fact-expiry: --warn-days must be a whole number of days'); process.exit(2); }
  const today = arg('today') ?? todayUtc();
  let facts: ExpiryFact[]; let from: string;
  const built = arg('built'); const ttlArg = arg('ttl'); const site = arg('site');
  if (built) {
    const f = path.join(path.resolve(built), FACTS_FILE);
    from = 'built site ' + path.resolve(built);
    // A build with no dated or open fact writes no facts file: that is "none", but say how it was learned.
    facts = existsSync(f) ? parseFactsFile(readFileSync(f, 'utf8')) : [];
    if (!existsSync(f)) console.log('fact-expiry: ' + FACTS_FILE + ' is absent, so that build stated no fact with a valid-until marker (or it predates F293)');
  } else if (site) {
    const content: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      for (const e of existsSync(dir) ? readdirSyncSafe(dir) : []) {
        if (e.isDirectory) walk(path.join(dir, e.name), rel + e.name + '/');
        else if (e.name.endsWith('.md')) content['content/' + rel + e.name] = readFileSync(path.join(dir, e.name), 'utf8');
      }
    };
    walk(path.join(path.resolve(site), 'content'), '');
    from = 'site repository ' + path.resolve(site);
    facts = expiryFactsFromContent(content);
  } else {
    const file = path.resolve(ttlArg ?? path.join(ROOT, 'static', 'starter-data-insight-solutions.ttl'));
    if (!existsSync(file)) { console.error('fact-expiry: no such file: ' + file); process.exit(2); }
    from = 'file ' + path.relative(ROOT, file);
    facts = factsFromTurtle(readFileSync(file, 'utf8'));
  }
  const r = classifyExpiry(facts, today, windowDays);
  for (const line of describeExpiry(r)) console.log(line);
  console.log(`fact-expiry: ${facts.length} fact(s) with a valid-until marker in ${from} on ${today}: ${r.expired.length} expired, ${r.warning.length} within ${windowDays} day(s), ${r.open.length} open date(s), ${r.ok.length} ok`);
  if (r.expired.length > 0) process.exit(1);
}

function readdirSyncSafe(dir: string): { name: string; isDirectory: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
}

if (process.argv[1] && process.argv[1].endsWith('fact-expiry.ts')) main();
