#!/usr/bin/env npx tsx
/**
 * Draft terms (F263, AGENT tier) - a LOCAL model drafts a missing taxonomy term as a PROPOSAL.
 *
 * taxonomy-current (script tier) FINDS the built-in entity types that have no term. Writing the
 * term is judgment over language, so it goes to a local model inside the usual harness:
 *   ground    the code's own description string for the type (nothing else; the model is told so)
 *   prompt    one JSON object: prefLabel, userLabel, definition
 *   validate  parseable, labels present, definition 6-45 words and at most two sentences, no
 *             jargon in the user label, no invented file names, and it must share a content word
 *             with the grounding (a draft that ignores its grounding is invented)
 *   emit      one pending suggestion per term in knowledge.pending.jsonl. It NEVER edits a TTL:
 *             terminology rule 1 says a term is a proposal until Matt accepts it.
 *
 * Usage: OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/draft-terms.ts
 *          [--model=qwen3.8:latest] [--limit=20] [--dry-run]
 */
import { existsSync } from 'fs';
import { run, type Gap } from './taxonomy-current.ts';
import { transactPendingQueue } from './pending-queue.ts';
import { ollamaStream } from './lib/ollama-stream.ts';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DRY = raw.includes('--dry-run');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? '';
const MODEL = flag('model') ?? 'qwen3.8:latest';
const LIMIT = Number(flag('limit') ?? 50);
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const AGENT = 'offline:draft-terms';
const STOP = new Set('a an the of or and to in is are that this for with as by it its on at be from'.split(' '));

export type Draft = { prefLabel: string; userLabel: string; definition: string };

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Returns a reason when the draft is unusable, or null. Exported so a test can pin it. */
export function validateDraft(d: unknown, grounding: string): string | null {
  if (!d || typeof d !== 'object') return 'not an object';
  const { prefLabel, userLabel, definition } = d as Record<string, unknown>;
  for (const [k, v] of Object.entries({ prefLabel, userLabel, definition })) {
    if (typeof v !== 'string' || !v.trim()) return `${k} missing`;
  }
  const def = (definition as string).trim();
  const n = words(def).length;
  if (n < 6 || n > 45) return `definition is ${n} words (want 6-45)`;
  if ((def.match(/[.!?](\s|$)/g) ?? []).length > 2) return 'definition is more than two sentences';
  if (/\b(rdf|iri|urn|shacl|skos|ontology|triple)\b/i.test(userLabel as string)) return 'user label is jargon';
  if ((userLabel as string).split(/\s+/).length > 4) return 'user label too long';
  if (/\b(TODO|TBD|placeholder|lorem ipsum)\b/i.test(def) || /^(i (cannot|can't)|as an ai|sorry)/i.test(def)) return 'hedged or placeholder';
  for (const m of def.match(/\b[\w./-]+\.(ts|svelte|js|json|ttl|sh)\b/g) ?? []) if (!existsSync(m)) return `cites a file that does not exist: ${m}`;
  if (def.includes('urn:kabase:')) return 'namespace typo';
  const g = new Set(words(grounding).filter((w) => !STOP.has(w) && w.length > 2));
  if (!words(`${prefLabel} ${def}`).some((w) => g.has(w))) return 'shares no word with its grounding';
  return null;
}

const slug = (iri: string) => iri.split('/').pop()!.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

async function main() {
  const gaps: Gap[] = run(process.cwd()).gaps.filter((g) => g.kind === 'type-no-term').slice(0, LIMIT);
  if (!OLLAMA && !DRY) { console.error('OLLAMA_BASE_URL not set - this is the agent tier.'); process.exit(1); }
  console.log(`Draft terms - ${gaps.length} built-in type(s) without a term - ${DRY ? 'dry-run' : MODEL}\n`);
  let drafted = 0, rejected = 0, skipped = 0, failed = 0;
  for (const g of gaps) {
    const name = slug(g.subject);
    process.stdout.write(`  ${name} ... `);
    if (DRY) { console.log('would draft'); continue; }
    const grounding = `${g.detail}. The code describes it as: "${g.description}"`;
    const prompt =
      `You are adding a term to the controlled vocabulary of Reckons.AI, a personal knowledge app where people keep facts about things.\n` +
      `The app has a built-in kind of thing (an entity type). Draft its vocabulary term.\n\nGROUNDING (the only facts you may use)\n${grounding}\n\n` +
      `Reply with ONE JSON object and nothing else:\n{"prefLabel": "...", "userLabel": "...", "definition": "..."}\n` +
      `- prefLabel: the name of the kind of thing, lower case unless a proper name.\n` +
      `- userLabel: 1-3 plain everyday words a first-time reader would recognise.\n` +
      `- definition: ONE sentence in plain English saying what it is, using only the grounding.\n`;
    try {
      const out = (await ollamaStream(OLLAMA, 'generate', { model: MODEL, prompt, format: 'json', think: false, options: { temperature: 0.2, num_ctx: 4096 } })).text;
      let d: unknown;
      try { d = JSON.parse(out); } catch { rejected++; console.log('REJECTED (not JSON)'); continue; }
      const problem = validateDraft(d, grounding);
      if (problem) { rejected++; console.log(`REJECTED (${problem})`); continue; }
      const t = d as Draft;
      const entry = {
        subject: `urn:kbase:term/${name}`,
        predicate: 'http://www.w3.org/2004/02/skos/core#definition',
        object: t.definition.trim(),
        note: `Drafted offline by ${MODEL} from the code's own description of ${g.subject}. Proposed prefLabel "${t.prefLabel.trim()}", user-label "${t.userLabel.trim()}", matching ${g.subject}. PROPOSAL - Matt accepts or edits; nothing was written to a TTL.`,
        question: `[local draft] Built-in type ${g.subject} has no taxonomy term. Proposed: prefLabel "${t.prefLabel.trim()}", user label "${t.userLabel.trim()}", definition "${t.definition.trim()}" - accept, edit, or reject.`,
        kb: 'terminology', type: 'suggestion', agent: `${AGENT} (${MODEL})`, priority: 'low',
        addedAt: new Date().toISOString(), addedByMcp: true,
      };
      const queued = transactPendingQueue(PENDING, (cur) => {
        const dup = cur.split('\n').filter(Boolean).some((l) => { try { const r = JSON.parse(l); return r.subject === entry.subject && r.agent?.startsWith(AGENT); } catch { return false; } });
        if (dup) return { result: false };
        return { content: cur + (cur && !cur.endsWith('\n') ? '\n' : '') + JSON.stringify(entry) + '\n', result: true };
      });
      if (queued) { drafted++; console.log(`queued (${words(t.definition).length} words)`); } else { skipped++; console.log('already queued'); }
    } catch (e) { failed++; console.log(`FAILED (${e instanceof Error ? e.message : e})`); }
  }
  if (DRY) return;
  console.log(`\n${drafted} drafted and queued, ${rejected} rejected by validation, ${skipped} already queued, ${failed} failed. No TTL was changed.`);
}
if (process.argv[1]?.endsWith('draft-terms.ts')) main();
