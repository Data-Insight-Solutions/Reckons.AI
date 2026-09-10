#!/usr/bin/env npx tsx
/**
 * THE LANDING THESIS, GENERATED FROM THE GRAPH — because two copies of the same sentences drift.
 *
 * scripts/offline/landing-data-align.ts has said since 2026-08-14 that this file "should
 * eventually be GENERATED from the graph, as content/*.md already is". This is that, and it was
 * written the day the drift it predicted actually happened.
 *
 * WHAT WENT WRONG, and it is worth stating because the failure had two independent halves:
 *
 *   1. On 2026-09-09 the landing copy was shortened — three tenets ran twice the length of the
 *      other seven — by editing the JSON and not the graph. Ten of ten leads then disagreed with
 *      kpred:tenet-body, which is precisely the drift the gate exists to catch.
 *   2. The gate could not see it. It compared `item.body`, and the JSON key had been renamed to
 *      `lead`, so it was reading `undefined` against every tenet and reporting all ten as
 *      differing. It failed LOUDLY, which is the only reason this was found — a check that reads
 *      a field that does not exist and reports green is the same bug with a worse ending.
 *
 * THE FIX IS NOT TO RE-SYNC THE COPIES. The landing page genuinely wants a shorter line than the
 * docs do, so the graph now carries BOTH: kpred:tenet-body is the full statement, kpred:tenet-lead
 * is the opening the landing page shows. Verified when it was added — every lead was already an
 * exact prefix of its body, so no new prose was minted, only a cut point recorded.
 *
 * Usage: npx tsx scripts/landing-data.ts [--check]
 */

import { Parser } from 'n3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const GRAPH = join(ROOT, 'static', 'reckons-roadmap.ttl');
const OUT = join(ROOT, 'src', 'lib', 'data', 'landing-thesis.json');
const CHECK = process.argv.includes('--check');

interface Tenet { headline: string; lead: string; status: string }

function build(): string {
  const quads = new Parser().parse(readFileSync(GRAPH, 'utf8'));
  const get = (suffix: string) => {
    const m = new Map<string, string>();
    for (const q of quads) if (q.predicate.value.endsWith(suffix)) m.set(q.subject.value, q.object.value);
    return m;
  };
  const label = get('rdf-schema#label');
  const lead = get('tenet-lead');
  const status = get('tenet-status');
  const order = get('nav/order');
  const onLanding = get('show-on-landing');
  // Tenets only. kpred:show-on-landing also marks ROADMAP features for the landing page's roadmap
  // strip, and treating those as tenets reported five phantom "missing lead" warnings.
  const isTenet = new Set(
    quads.filter((q) => q.predicate.value.endsWith('22-rdf-syntax-ns#type') && q.object.value.endsWith('type/Tenet'))
      .map((q) => q.subject.value),
  );

  const tenets: Tenet[] = [...onLanding.entries()]
    .filter(([iri, v]) => v === 'true' && isTenet.has(iri))
    .filter(([iri]) => lead.has(iri))
    .sort((a, b) => Number(order.get(a[0]) ?? 999) - Number(order.get(b[0]) ?? 999))
    .map(([iri]) => ({
      headline: label.get(iri) ?? '',
      lead: lead.get(iri) ?? '',
      status: status.get(iri) ?? 'belief',
    }));

  // A tenet marked for the landing page with no lead would silently vanish from the page. Say so.
  const missing = [...onLanding.entries()].filter(([iri, v]) => v === 'true' && isTenet.has(iri) && !lead.has(iri));
  if (missing.length > 0) {
    console.error(`  ${missing.length} tenet(s) marked show-on-landing carry no kpred:tenet-lead and were skipped:`);
    for (const [iri] of missing) console.error(`    ${label.get(iri) ?? iri}`);
  }

  return JSON.stringify(tenets, null, 2) + '\n';
}

function main(): void {
  const json = build();
  if (CHECK) {
    const existing = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return ''; } })();
    if (existing.trim() !== json.trim()) {
      console.error('✗ src/lib/data/landing-thesis.json does not match the graph. Run: npm run landing:data');
      process.exit(1);
    }
    console.log('✓ landing thesis matches the graph');
    return;
  }
  writeFileSync(OUT, json, 'utf8');
  console.log(`✓ ${JSON.parse(json).length} tenet(s) written to src/lib/data/landing-thesis.json from the graph`);
}

main();
