#!/usr/bin/env npx tsx
/**
 * The digest, as a GRAPH (F80 phase 3 / kb:async-digest) — finally.
 *
 * Matt's very first question this session: "why was DIGEST.md made? Why not record in turtle?"
 * The honest answer was that it should have been. The plan (kb:async-digest) said so explicitly
 * — "agents append findings to a digest ENTITY IN THE GRAPH… renders through the existing
 * WebPage/publish machinery, so it is just a graph node like anything else" — and what actually
 * shipped was a hand-appended markdown file with a graph write bolted on the side.
 *
 * That is a SECOND SOURCE OF TRUTH, inside a product whose entire argument is that there should
 * not be one. It is not a small hypocrisy: the digest is where we record our own failures, so a
 * digest that is not in the graph is a record of honesty kept dishonestly.
 *
 * So:
 *   reckons-workspace/digest.ttl   the findings, as ktype:Finding entities. THE SOURCE.
 *   reckons-workspace/DIGEST.md    GENERATED from it. Never hand-edited.
 *
 * `npm run align` gates the pair, so the markdown cannot drift from the graph. Same rule as
 * every other generated surface, applied to ourselves.
 *
 * Usage:
 *   npx tsx scripts/agent/digest-graph.ts --render        regenerate DIGEST.md from digest.ttl
 *   npx tsx scripts/agent/digest-graph.ts --check         fail if DIGEST.md is stale (CI)
 *   npx tsx scripts/agent/digest-graph.ts --migrate       one-off: DIGEST.md -> digest.ttl
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { Parser, Writer, DataFactory, type Quad } from 'n3';

const { namedNode, literal, quad } = DataFactory;

const TTL = 'reckons-workspace/digest.ttl';
const MD = 'reckons-workspace/DIGEST.md';
const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';
const FINDING = `${KTYPE}Finding`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const NS = 'urn:reckons:finding/';

export type FindingType =
  | 'bug-found' | 'claim-falsified' | 'test-added' | 'question-raised'
  | 'decision-needed' | 'shipped' | 'note';

const ICON: Record<string, string> = {
  'bug-found': '🐛', 'claim-falsified': '❌', 'test-added': '✅',
  'question-raised': '❓', 'decision-needed': '🔶', shipped: '🚢', note: '·',
};

export interface Finding {
  id: string;
  type: string;
  about?: string;
  headline: string;
  detail?: string;
  agent?: string;
  at: string;
}

/** Stable id from the headline — so re-recording the same finding does not duplicate it. */
export function findingId(headline: string): string {
  let h = 0;
  for (let i = 0; i < headline.length; i++) h = (Math.imul(31, h) + headline.charCodeAt(i)) | 0;
  return `f${(h >>> 0).toString(36)}`;
}

export function readFindings(file = TTL): Finding[] {
  if (!existsSync(file)) return [];
  let quads: Quad[];
  try {
    quads = new Parser().parse(readFileSync(file, 'utf8')) as Quad[];
  } catch {
    return [];
  }
  const iris = [...new Set(
    quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === FINDING).map((q) => q.subject.value),
  )];
  const one = (iri: string, p: string) =>
    quads.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${p}`)?.object.value;

  return iris
    .map((iri) => ({
      id: iri.replace(NS, ''),
      type: one(iri, 'finding-type') ?? 'note',
      about: one(iri, 'about'),
      headline: one(iri, 'headline') ?? '',
      detail: one(iri, 'detail'),
      agent: one(iri, 'agent'),
      at: one(iri, 'found-at') ?? '',
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function writeFindings(findings: Finding[], file = TTL): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const quads: Quad[] = [];
  for (const f of findings) {
    const s = namedNode(NS + f.id);
    quads.push(quad(s, namedNode(RDF_TYPE), namedNode(FINDING)) as Quad);
    quads.push(quad(s, namedNode(`${KPRED}finding-type`), literal(f.type)) as Quad);
    quads.push(quad(s, namedNode(`${KPRED}headline`), literal(f.headline)) as Quad);
    quads.push(quad(s, namedNode(`${KPRED}found-at`), literal(f.at)) as Quad);
    if (f.about) quads.push(quad(s, namedNode(`${KPRED}about`), literal(f.about)) as Quad);
    if (f.detail) quads.push(quad(s, namedNode(`${KPRED}detail`), literal(f.detail)) as Quad);
    if (f.agent) quads.push(quad(s, namedNode(`${KPRED}agent`), literal(f.agent)) as Quad);
  }
  const w = new Writer({ format: 'Turtle', prefixes: { kpred: KPRED, ktype: KTYPE, f: NS } });
  w.addQuads(quads);
  w.end((err, result: string) => {
    if (err) throw err;
    writeFileSync(
      file,
      `# The rolling agent digest — THE SOURCE (F80 / kb:async-digest).\n` +
        `#\n` +
        `# Findings live HERE, as graph entities. reckons-workspace/DIGEST.md is GENERATED from\n` +
        `# this file and must never be hand-edited — 'npm run align' fails if it drifts.\n` +
        `#\n` +
        `# The digest is where we record our own failures. A record of honesty kept as a second\n` +
        `# source of truth, in a product whose thesis is that there should not be one, was a\n` +
        `# hypocrisy worth fixing.\n` +
        `#\n` +
        `# Append with: npx tsx scripts/agent/digest.ts --type bug-found --headline "…"\n\n` +
        result,
    );
  });
}

/** Add a finding. Idempotent on the headline — the same finding twice is one finding. */
export function addFinding(f: Omit<Finding, 'id' | 'at'> & { at?: string }, file = TTL): boolean {
  const findings = readFindings(file);
  const id = findingId(f.headline);
  if (findings.some((x) => x.id === id)) return false;
  findings.push({ ...f, id, at: f.at ?? new Date().toISOString() });
  writeFindings(findings, file);
  return true;
}

/** Render the markdown. Newest LAST, so the file reads as an accumulating record. */
export function renderMarkdown(findings: Finding[]): string {
  const lines: string[] = [
    `<!-- GENERATED from reckons-workspace/digest.ttl by scripts/agent/digest-graph.ts.`,
    `     DO NOT HAND-EDIT — 'npm run align' will fail. Edit the graph, then regenerate. -->`,
    ``,
    `# Reckons.AI — rolling agent digest`,
    ``,
    `One report that GROWS, instead of many that interrupt (F80 / kb:async-digest).`,
    `Agents append here while you are away. **Nothing in this file waited on you.**`,
    ``,
    `Questions needing your answer appear in the app's **Review tab** as partial facts`,
    `(object \`?\`, with an entity picker). Answering one unblocks whatever it was holding up.`,
    ``,
    `${findings.length} finding(s).`,
    ``,
    `---`,
  ];

  for (const f of findings) {
    lines.push('');
    lines.push(`### ${ICON[f.type] ?? '·'} ${f.headline}`);
    lines.push('');
    const meta = [`\`${f.type}\``];
    if (f.about) meta.push(`**${f.about}**`);
    meta.push(f.at);
    if (f.agent) meta.push(`_${f.agent}_`);
    lines.push(meta.join(' · '));
    if (f.detail) {
      lines.push('');
      lines.push(f.detail);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('digest-graph.ts');
if (isMain) {
  const argv = process.argv.slice(2);

  // One-off: pull the existing hand-written findings into the graph.
  if (argv.includes('--migrate')) {
    if (!existsSync(MD)) {
      console.error(`No ${MD} to migrate.`);
      process.exit(1);
    }
    const text = readFileSync(MD, 'utf8');
    const blocks = text.split(/\n### /).slice(1);
    const findings: Finding[] = [];
    for (const b of blocks) {
      const lines = b.split('\n');
      const headline = lines[0].replace(/^[^\w"'A-Za-z]*\s*/, '').trim();
      const metaLine = lines.find((l) => l.trim().startsWith('`')) ?? '';
      const type = metaLine.match(/`([a-z-]+)`/)?.[1] ?? 'note';
      const about = metaLine.match(/\*\*(.+?)\*\*/)?.[1];
      const at = metaLine.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] ?? new Date().toISOString();
      const agent = metaLine.match(/_([\w-]+)_/)?.[1];
      const metaIdx = lines.indexOf(metaLine);
      const detail = lines.slice(metaIdx + 1).join('\n').trim() || undefined;
      if (!headline) continue;
      findings.push({ id: findingId(headline), type, about, headline, detail, agent, at });
    }
    findings.sort((a, b) => a.at.localeCompare(b.at));
    writeFindings(findings);
    console.log(`Migrated ${findings.length} finding(s) → ${TTL}`);
    console.log(`Now run --render to regenerate ${MD} from the graph.`);
    process.exit(0);
  }

  const findings = readFindings();
  const rendered = renderMarkdown(findings);

  if (argv.includes('--check')) {
    const current = existsSync(MD) ? readFileSync(MD, 'utf8') : '';
    if (current !== rendered) {
      console.error(`${MD} is STALE — it no longer matches reckons-workspace/digest.ttl.`);
      console.error(`The graph is the source. Run: npx tsx scripts/agent/digest-graph.ts --render`);
      process.exit(1);
    }
    console.log(`DIGEST.md matches the graph (${findings.length} findings).`);
    process.exit(0);
  }

  writeFileSync(MD, rendered);
  console.log(`Rendered ${findings.length} finding(s) → ${MD} (from ${TTL}).`);
}
