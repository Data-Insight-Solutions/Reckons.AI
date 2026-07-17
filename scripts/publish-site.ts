#!/usr/bin/env npx tsx
/**
 * `reckons publish` — the CLI half of F76: a graph .ttl in, a live static site out (Matt: build the
 * standalone generator and publish CLI; local CLIs are fine; git optional).
 *
 * Pipeline: parse the .ttl -> generate the self-contained site (site-generator.ts) -> write it to a
 * folder -> preflight the per-file sizes against the chosen host -> emit (or run) the host's deploy
 * command. Cloudflare Pages is the default target and deploys via Wrangler; --deploy runs it.
 *
 *   npx tsx scripts/publish-site.ts graph.ttl                        build -> ./published-site
 *   npx tsx scripts/publish-site.ts graph.ttl --out=dist --title="My Site"
 *   npx tsx scripts/publish-site.ts graph.ttl --target=cloudflare-pages --project=my-site --deploy
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Parser } from 'n3';
import { generateStaticSite } from '../src/lib/publish/site-generator.js';
import { checkAssetSizes, getTarget, formatBytes, type PublishTarget } from '../src/lib/publish/targets.js';
import type { Statement } from '../src/lib/rdf/types.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m';
const argv = process.argv.slice(2);
const flag = (name: string, def = ''): string => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? def;
const has = (name: string) => argv.includes(`--${name}`);
const graphFile = argv.find((a) => !a.startsWith('--'));

if (!graphFile) {
  console.error('Usage: npx tsx scripts/publish-site.ts <graph.ttl> [--out=dir] [--title=..] [--target=cloudflare-pages] [--project=name] [--deploy]');
  process.exit(1);
}

const outDir = flag('out', 'published-site');
const targetId = (flag('target', 'cloudflare-pages')) as PublishTarget['id'];
const project = flag('project', path.basename(outDir));
const target = getTarget(targetId);
if (!target) {
  console.error(`Unknown target "${targetId}". Options: cloudflare-pages, gitlab-pages, netlify, github-pages, zip.`);
  process.exit(1);
}

// ── Parse the graph → statements (all confirmed; the file IS the confirmed graph). ──
const quads = new Parser().parse(readFileSync(graphFile, 'utf8'));
const term = (t: { termType: string; value: string; datatypeString?: string; language?: string }) =>
  t.termType === 'Literal'
    ? { kind: 'literal' as const, value: t.value, ...(t.language ? { lang: t.language } : {}) }
    : t.termType === 'BlankNode'
      ? { kind: 'bnode' as const, value: t.value }
      : { kind: 'iri' as const, value: t.value };
let i = 0;
const stmts: Statement[] = quads.map((q) => ({
  id: `q${i++}`,
  s: term(q.subject) as Statement['s'],
  p: { kind: 'iri', value: q.predicate.value },
  o: term(q.object) as Statement['o'],
  g: { kind: 'iri', value: q.graph.value || 'urn:reckons:site' },
  sourceId: 'publish',
  confidence: 1,
  status: 'confirmed',
  createdAt: 0,
  updatedAt: 0,
}));

// ── Generate ──
const site = generateStaticSite(stmts, { siteTitle: flag('title') || undefined });
if (site.pageCount === 0) {
  console.error(`${R}No published WebPage nodes in ${graphFile}.${X} Mark pages ktype:WebPage with page:status "published".`);
  process.exit(1);
}

console.log(`${B}Publish${X} ${D}— ${graphFile} → ${site.pageCount} page(s), target: ${target.label}${X}\n`);

// ── Write the site folder ──
rmSync(outDir, { recursive: true, force: true });
for (const [rel, content] of Object.entries(site.files)) {
  const full = path.join(outDir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}
console.log(`  ${G}✓${X} wrote ${Object.keys(site.files).length} file(s) to ${B}${outDir}/${X}`);

// ── Preflight: any file over the host's per-file cap? ──
const oversized = checkAssetSizes(site.files, target);
if (oversized.length) {
  console.log(`\n${Y}! ${oversized.length} file(s) exceed ${target.label}'s ${target.perFileLimitMB} MB cap${X} ${D}— offload large assets to object storage (R2) and reference by URL${X}`);
  for (const w of oversized.slice(0, 5)) console.log(`    ${w.path} ${D}(${formatBytes(w.bytes)})${X}`);
}

// ── Deploy step ──
console.log(`\n${B}deploy${X} ${D}(${target.deploy})${X}`);
if (target.deploy === 'cli' && target.cli) {
  const cmd = target.cli.command(outDir, project);
  console.log(`  ${D}install:${X} ${target.cli.install}`);
  if (has('deploy')) {
    console.log(`  ${D}running:${X} ${cmd}\n`);
    try {
      execSync(cmd, { stdio: 'inherit' });
      console.log(`\n${G}✓ deployed via ${target.cli.tool}.${X}`);
    } catch (e) {
      console.error(`\n${R}deploy failed${X} — is ${target.cli.tool} installed and authed? (${target.cli.install})`);
      process.exit(1);
    }
  } else {
    console.log(`  run this to deploy (or re-run with --deploy):\n    ${B}${cmd}${X}`);
  }
} else {
  console.log(`  ${target.setup}`);
}
if (target.dns) console.log(`\n${D}domain: ${target.dns}${X}`);
