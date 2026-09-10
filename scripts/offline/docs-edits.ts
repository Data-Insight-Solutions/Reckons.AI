#!/usr/bin/env npx tsx
/**
 * HAND EDITS, PROPOSED BACK AS TRIPLES (F189) — script tier, no model, writes no graph.
 *
 * Matt, 2026-09-08: "Can we somehow watch for manual edits and incorporate those as triples for
 * next regeneration of the page?"
 *
 * Yes, and the reason it is worth doing rather than forbidding is that `md-align` already NOTICES
 * a hand edit — it regenerates every page and diffs the bytes. What it does with that knowledge is
 * fail the build and tell you to re-export, which throws the edit away. The edit is information:
 * somebody improved a sentence, on the surface where reading it made the improvement obvious.
 *
 * WHY IT NEEDS PROVENANCE, and why this could not be built before today. `site-import.ts` already
 * turns a content file back into statements, but it mints `urn:kbase:concept/{slug}` as the
 * subject — a WebPage entity keyed on the FILE. The prose actually lives on the docs entity that
 * generated it, `urn:reckons:feature/FiveMoves` and the like. Round-tripping without provenance
 * therefore creates a SECOND entity describing the same thing, which is the duplication this
 * product exists to prevent. `static/page-provenance.json` now records page -> entity, so an edit
 * can be proposed against the subject that owns the sentence.
 *
 * IT PROPOSES; IT NEVER WRITES. Every finding lands in knowledge.pending.jsonl for review, exactly
 * as extraction does. That is not caution for its own sake: a generated page contains rendered
 * SVG, folded children and derived links, so "the text changed" is often the generator's doing
 * rather than a person's, and a tool that wrote those back into the graph would corrupt it
 * silently. A human confirming each one is the control.
 *
 * Usage:
 *   npx tsx scripts/offline/docs-edits.ts            report edits found
 *   npx tsx scripts/offline/docs-edits.ts --pending  queue them for review
 */

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { Parser } from 'n3';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const CONTENT = join(ROOT, 'content');
const PROVENANCE = join(ROOT, 'static', 'page-provenance.json');
const PENDING = join(ROOT, 'reckons-workspace', 'knowledge.pending.jsonl');
const KPRED = 'urn:kbase:predicate/';
/** Marks a predicate with several values — rendered as a list, not comparable to one band. */
const MULTI = '\u0000multi';

const args = process.argv.slice(2);
const QUEUE = args.includes('--pending');

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Prov { path: string; entity: string; graph: string; factHash: string; factCount: number }

/**
 * The prose bands a page is rendered from, read back out of the markdown.
 *
 * `renderProse` writes each literal predicate as `**Humanized Name**` followed by its text, so the
 * inverse is mechanical. Only these are read back: a heading, a figure or a link was DERIVED by
 * the generator and is not a sentence anybody wrote here.
 */
export function parseBands(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Strip anything the generator synthesised, so it cannot be mistaken for an edit.
  let clean = body
    .replace(/<figure[\s\S]*?<\/figure>/g, '')
    .replace(/<div class="card-grid">[\s\S]*?<\/div>/g, '')
    .replace(/<details class="accordion">[\s\S]*?<\/details>/g, '');

  /*
   * ONLY THE PAGE'S OWN PROSE — everything from the first `###` belongs to a FOLDED CHILD.
   *
   * This produced a false positive on the first real run, and a convincing one. A page renders its
   * own bands and then its folded children's, and both use the same names, so `**Command**`
   * appeared twice on content/testing/visual-tests.md — once from the page's entity ("npm run
   * test:visual") and once from a child ("npm run test:stories"). Reading the last occurrence and
   * comparing it to the parent's value reported a hand edit that nobody had made, on a page where
   * both values were correct. renderBody emits the entity's own prose BEFORE renderChildren, and
   * a folded child is always introduced by `###`, so cutting there is exact rather than heuristic.
   */
  const firstChild = clean.search(/^### /m);
  if (firstChild >= 0) clean = clean.slice(0, firstChild);

  const re = /^\*\*([A-Z][A-Za-z ]+)\*\*\n\n([\s\S]*?)(?=\n\*\*[A-Z]|\n## |\n### |$)/gm;
  for (const m of clean.matchAll(re)) {
    const predicate = m[1].trim().toLowerCase().replace(/\s+/g, '-');
    const text = m[2].trim();
    if (text) out.set(predicate, text);
  }
  return out;
}

/**
 * The same reading applied to the graph's own literals, so the two are comparable.
 *
 * Parsed rather than regexed. The first version matched the entity's block with a regular
 * expression and silently found NOTHING, because it assumed a block terminates with a "." on its
 * own line when in these files it sits at the end of the last predicate. A detector that reports
 * "no edits" when it cannot read the graph at all is the worst possible failure here, so this
 * uses the parser every other script in the repo uses.
 */
function graphBands(entity: string, graphFile: string): Map<string, string> {
  const out = new Map<string, string>();
  const path = join(ROOT, 'static', graphFile);
  if (!existsSync(path)) return out;
  let quads: Array<{ subject: { value: string }; predicate: { value: string }; object: { value: string; termType: string } }>;
  try {
    quads = new Parser().parse(readFileSync(path, 'utf8')) as never;
  } catch {
    return out;
  }
  for (const q of quads) {
    if (q.subject.value !== entity || q.object.termType !== 'Literal') continue;
    if (!q.predicate.value.startsWith(KPRED)) continue;
    const name = q.predicate.value.slice(KPRED.length);
    // A predicate with several values renders as a bulleted list, which this reader cannot map
    // back to one value. Skipping is honest; guessing which bullet was edited is not.
    if (out.has(name)) { out.set(name, MULTI); continue; }
    out.set(name, q.object.value);
  }
  return out;
}

function main(): void {
  if (!existsSync(PROVENANCE)) {
    console.error(C.red('No static/page-provenance.json. Run: npm run docs:pages'));
    process.exit(1);
  }
  const { pages } = JSON.parse(readFileSync(PROVENANCE, 'utf8')) as { pages: Prov[] };

  const edits: Array<{ prov: Prov; predicate: string; was: string; now: string }> = [];
  for (const prov of pages) {
    const file = join(CONTENT, `${prov.path}.md`);
    if (!existsSync(file)) continue;
    const onPage = parseBands(readFileSync(file, 'utf8'));
    const inGraph = graphBands(prov.entity, prov.graph);
    for (const [pred, text] of onPage) {
      const original = inGraph.get(pred);
      // Only a band the graph also has is comparable. A band with no counterpart is usually a
      // predicate this reader cannot map back, not a new fact, and guessing would be worse.
      if (original === undefined || original === MULTI) continue;
      /*
       * Compare on collapsed whitespace AND unescaped entities.
       *
       * Two false alarms this removes, both found on the first real run. Markdown wraps lines and
       * the TTL does not, so a rewrap is not an edit. And `escapeMdText` writes `-&gt;` for a `->`
       * the author typed, so every page containing an arrow reported itself as hand-edited
       * forever. A staleness signal with a permanent false positive is one nobody reads.
       */
      const norm = (x: string) => x
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
        .replace(/\s+/g, ' ').trim();
      if (norm(original) !== norm(text)) {
        edits.push({ prov, predicate: pred, was: original, now: text });
      }
    }
  }

  console.log('');
  console.log(C.bold('hand edits on generated pages') + C.dim(` — ${pages.length} pages checked`));
  if (edits.length === 0) {
    console.log(C.green('  no edits found — every page says what its entity says.'));
    return;
  }
  for (const e of edits) {
    console.log(`  ${C.cyan(e.prov.path)}  ${C.bold(e.predicate)}`);
    console.log(C.dim(`    was: ${e.was.slice(0, 90)}`));
    console.log(C.yellow(`    now: ${e.now.slice(0, 90)}`));
  }

  if (!QUEUE) {
    console.log('');
    console.log(C.dim('  Report only. Pass --pending to queue these as proposals for review.'));
    return;
  }
  const lines = edits.map((e) => JSON.stringify({
    subject: e.prov.entity,
    predicate: `kpred:${e.predicate}`,
    object: e.now,
    note: `Edited by hand on content/${e.prov.path}.md. The graph still says: "${e.was.slice(0, 160)}". `
      + `Accepting replaces the value in ${e.prov.graph}; rejecting means the page should be regenerated.`,
    type: 'suggestion',
    agent: 'docs-edits',
    priority: 'medium',
  }));
  appendFileSync(PENDING, lines.join('\n') + '\n');
  console.log('');
  console.log(C.green(`  Queued ${lines.length} proposal(s) to reckons-workspace/knowledge.pending.jsonl.`));
}

if (process.argv[1] && process.argv[1].endsWith('docs-edits.ts')) main();
