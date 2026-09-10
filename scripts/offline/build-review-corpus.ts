#!/usr/bin/env npx tsx
/**
 * RAW TEXT -> A GRAPH THAT ARRIVES AS REVIEW WORK, through the real pipeline. AGENT TIER.
 *
 * Matt, 2026-09-04: "we have attempted the summary, hierarchy, and other elements to reduce
 * reviewer workload, but now with enhanced extraction we should test again."
 *
 * WHY THIS EXISTS AND WHY IT IS NOT make-review-fixture.ts. That script takes an EXISTING graph and
 * re-serializes it so it imports as pending. It never runs an extractor, so it cannot answer whether
 * extraction changes review workload. This one starts from raw note text and runs what the app now
 * actually does:
 *
 *   extract (ungrounded)  ->  triplesToStatements  ->  reconcileVocabulary  ->  annotated Turtle
 *
 * That chain is the point. The 2026-09-02 review baseline — 0 decisions open, 53 orphan judgments,
 * a flat list — was measured on a graph extracted by llama3.2:3b WITH prompt grounding on. Both of
 * those changed on 2026-09-04 (qwen3:32b, grounding deferred to vocabulary-reconcile), so the review
 * numbers have to be re-measured rather than assumed to have moved.
 *
 * PENDING, NOT CONFIRMED. Statements are written with status `pending` and serialized via
 * toTurtleFull, because a plain-Turtle export imports as CONFIRMED and lands a whole graph settled —
 * which shows an empty review queue and reads as "the tree is broken" when the tree is fine. That
 * exact confusion is recorded in make-review-fixture.ts and is easy to re-create by accident.
 *
 *   npx tsx scripts/offline/build-review-corpus.ts
 *   … --model=qwen3:32b --out=reckons-workspace/kbs/review-test/review-test.ttl
 *   … --ground              put the graph back in the extraction prompt (opt-in, as the app now is)
 *   … --thinking            two-pass extract-then-critic
 *
 * Needs OLLAMA_BASE_URL. Writes ONE TTL file and nothing else — no graph is mutated.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { extractWithOllama } from '../../src/lib/integrations/llm/ollama-extract.js';
import { triplesToStatements } from '../../src/lib/integrations/llm/extractor.js';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { reconcileVocabulary, reconcileSummary } from '../../src/lib/rdf/vocabulary-reconcile.js';
import { selectVocabulary, buildVocabularySection } from '../../src/lib/rdf/vocabulary-context.js';
import { selectStructuralContext, buildStructuralSection } from '../../src/lib/rdf/structural-context.js';
import type { Source, Statement } from '../../src/lib/rdf/types.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const MODEL = arg('model', 'qwen3:32b');
const CORPUS = arg('corpus', 'tests/fixtures/notes-corpus');
const OUT = arg('out', 'reckons-workspace/kbs/review-test/review-test.ttl');
const GROUND = args.includes('--ground');
const THINKING = args.includes('--thinking');
const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

/** Stable across runs so re-running replaces the same graph rather than minting a new KB. */
const KB_STABLE_ID = '9f4c2e10-7a83-4d61-b2f5-000000000404';

async function main() {
  if (!existsSync(CORPUS)) throw new Error(`No corpus at ${CORPUS}`);
  const files = readdirSync(CORPUS)
    .filter((f) => (f.endsWith('.txt') || f.endsWith('.md')) && !f.includes('EXPECTED') && !f.startsWith('README'))
    .sort();

  console.log(`\n${B}Build review corpus${X} ${D}— ${MODEL} · ${files.length} source(s) · grounding ${GROUND ? 'ON' : 'OFF'}${THINKING ? ' · thinking' : ''}${X}`);
  console.log(`${D}${BASE_URL} -> ${OUT}${X}\n`);

  const allStatements: Statement[] = [];
  const sources: Source[] = [];
  let totalApplied = 0;
  let totalSuggested = 0;

  for (const file of files) {
    const full = path.join(CORPUS, file);
    const text = readFileSync(full, 'utf8');
    // 04 is a fetch-instructions stub, not prose. Extracting it would put curl commands in the graph.
    if (/fetch on demand|not committed here/i.test(text.slice(0, 400))) {
      console.log(`${D}skip ${file} — fetch-instructions stub, not source text${X}`);
      continue;
    }

    const title = file.replace(/\.\w+$/, '');
    // No `as Source` cast: the first version used `createdAt` here, which is not a Source field,
    // and the cast silenced it until toTurtleFull threw `Invalid time value` on `ingestedAt`.
    const source: Source = {
      id: `review-${title}`,
      title,
      kind: 'note',
      uri: `file://${full}`,
      ingestedAt: Date.now(),
    };

    /*
     * Grounding is built from the statements accumulated SO FAR, which is what the app does: each
     * note is extracted against the graph as it stands after the previous ones. Building it from
     * the finished graph would leak later notes into earlier extractions and flatter the result.
     */
    let graphContext: string | undefined;
    if (GROUND) {
      const vocab = selectVocabulary(allStatements, text);
      const struct = selectStructuralContext(allStatements, { sourceText: text });
      graphContext = `${buildVocabularySection(vocab)}${buildStructuralSection(struct)}` || undefined;
    }

    const t0 = Date.now();
    const triples = await extractWithOllama(text, title, {
      model: MODEL,
      baseUrl: BASE_URL,
      maxTokens: 4096,
      graphContext,
      thinking: THINKING,
    });

    // sourceText verifies every excerpt against the real text (kb:passage-grounding) and drops
    // forged quotes — the same guard the app applies, so the fixture carries honest provenance.
    let statements = triplesToStatements(triples, source, text).map(
      (st) => ({ ...st, status: 'pending' }) as Statement,
    );

    const rec = reconcileVocabulary(statements, allStatements);
    statements = rec.statements;
    totalApplied += rec.applied.length;
    totalSuggested += rec.suggested.length;

    allStatements.push(...statements);
    sources.push(source);

    console.log(
      `${C}${title}${X} ${D}·${X} ${triples.length} triples ${D}·${X} reconcile: ${reconcileSummary(rec)} ${D}· ${((Date.now() - t0) / 1000).toFixed(1)}s${X}`,
    );
    for (const p of rec.suggested.slice(0, 3)) {
      console.log(`  ${Y}suggest${X} ${D}${p.from.split('/').pop()} ~ ${p.to.split('/').pop()} (${p.reason}, ${p.similarity.toFixed(2)})${X}`);
    }
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  const ttl = toTurtleFull(allStatements, sources, {
    kbStableId: KB_STABLE_ID,
    header: [
      'REVIEW TEST CORPUS — generated, do not hand-edit.',
      `npx tsx scripts/offline/build-review-corpus.ts --model=${MODEL}${GROUND ? ' --ground' : ''}${THINKING ? ' --thinking' : ''}`,
      '',
      'Raw note text run through the REAL pipeline: ungrounded extraction, passage-verified',
      'excerpts, then deterministic vocabulary reconciliation against the graph so far.',
      'Every statement is PENDING on purpose — this is meant to arrive as review work.',
    ].join('\n'),
  });
  writeFileSync(OUT, ttl);

  console.log(
    `\n${G}Wrote ${allStatements.length} pending statements from ${sources.length} source(s)${X} ${D}-> ${OUT}${X}`,
  );
  console.log(`${D}reconcile totals: ${totalApplied} auto-connected, ${totalSuggested} awaiting review${X}`);
  console.log(`\n${D}Next: npx tsx scripts/offline/extraction-chain.ts --graph=${OUT}${X}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
