/**
 * KB → graph terminology normalization for user-facing text.
 *
 * The product's noun is "graph"; older copy says "KB" / "knowledge base". This
 * migrates that vocabulary in USER-FACING TEXT only. For Turtle it runs inside
 * string literals (via literalSpans) so IRIs, prefixed names (`kb:`), and the
 * `urn:kbase:` namespace are never touched.
 *
 * Casing is acronym-aware: "KB"/"KBs" is an all-caps acronym, so it maps to
 * lowercase "graph"/"graphs" mid-sentence (capitalized only at a sentence
 * start) — otherwise "your KB" would wrongly become "your GRAPH". The phrase
 * "knowledge base" is case-preserved ("Knowledge Base" → "Knowledge Graph").
 *
 * NOT for identifiers: never run this over code symbols (KBaseDB, KbEntry),
 * MCP tool names (kb_search), or the /kb route.
 */
import { applyCase, literalSpans } from './americanize';

/** True if `prefix` ends at a sentence boundary (so a following word capitalizes). */
function atSentenceStart(prefix: string): boolean {
  const trimmed = prefix.replace(/[ \t]+$/, '');
  if (trimmed === '') return true;
  const last = trimmed.slice(-1);
  return '.!?:—–-("\'>'.includes(last) || trimmed.endsWith('\n');
}

function graphCase(prefix: string, base: 'graph' | 'graphs'): string {
  return atSentenceStart(prefix) ? base[0].toUpperCase() + base.slice(1) : base;
}

/** Rewrite KB / knowledge base → graph / knowledge graph in free text. */
export function kbToGraphText(text: string): { out: string; count: number } {
  let count = 0;
  let out = text;
  // Two-word phrase first — preserve each word's case ("Knowledge Base" → "Knowledge Graph").
  out = out.replace(/(knowledge)([ \t]+)(bases?)/gi, (_m, w1: string, sp: string, w3: string) => {
    count++;
    const plural = /s$/i.test(w3);
    return applyCase(w1, 'knowledge') + sp + applyCase(w3, plural ? 'graphs' : 'graph');
  });
  // Acronym "KBs"/"KB" (uppercase only), guarded against "64 KB" kilobytes.
  out = out.replace(/(?<!\d )\bKBs\b/g, (_m, off: number, str: string) => { count++; return graphCase(str.slice(0, off), 'graphs'); });
  out = out.replace(/(?<!\d )\bKB\b/g, (_m, off: number, str: string) => { count++; return graphCase(str.slice(0, off), 'graph'); });
  return { out, count };
}

/** Rewrite KB → graph only inside Turtle string literals; IRIs untouched. */
export function sweepKbToGraph(ttl: string): { out: string; count: number } {
  const spans = literalSpans(ttl);
  let out = '';
  let last = 0;
  let count = 0;
  for (const [s, e] of spans) {
    out += ttl.slice(last, s);
    const r = kbToGraphText(ttl.slice(s, e));
    out += r.out;
    count += r.count;
    last = e;
  }
  out += ttl.slice(last);
  return { out, count };
}
