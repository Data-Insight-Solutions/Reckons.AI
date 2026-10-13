/**
 * WHICH "graph" IS THIS? Deterministic sense rules for the one word the product uses three ways
 * (F203). Script tier: a rule decides what a rule can, and only the remainder goes to a model.
 *
 * WHY RULES FIRST. On 2026-10-07 the local panel (qwen3.6, three votes) judged the 59 visible
 * "graph" strings on /kb and voted "keep" on every one, unanimously. Against hand labels it was
 * right 3 times in 59: "Rename graph", "filter graphs…" and "star a graph to bookmark it" all mean
 * the SPACE (kterm:graph-view, user label "space", decided 2026-09-23). Unanimity measured the
 * model's consistency, not its correctness. The labels are scripts/agent/fixtures/ui-copy-graph.labels.json
 * and every change here is scored against them (term-sense-rules.test.ts).
 *
 * The senses, from static/reckons-terminology.ttl:
 *   space      the collection a person opens, names, filters and stars (kterm:graph-view)
 *   keep       the drawn picture of nodes and edges, or a standard RDF term (named graph)
 *   reword     the word stands for something else entirely ("a Turtle graph" means a file)
 *   undecided  no rule fired: the panel's question, with the decided cases as examples
 */

export type Sense = 'space' | 'keep' | 'reword' | 'undecided';
export type SenseResult = { sense: Sense; rule: string };

// Words around "graph" that settle its sense. Lowercased, matched as whole words.
const DRAWN_AFTER = /^(nodes?|edges?|views?|layouts?|canvas|picture|drawing|renderer)\b/;
const DRAWN_BEFORE = /\b(2d|3d|drawn|rendered|visible|force)\s*$|\b(view|zoom\w*|shown|appears?|drawn|pan)\s+(on|in|across)\s+the\s*$/;
const TECHNICAL_BEFORE = /\b(named|default|knowledge|rdf|source|statement)\s*$/;
const FILE_BEFORE = /\b(turtle|trig|n-?quads|ttl)\s*$/;
const CONTAINER_BEFORE = /\b(this|that|these|those|your|my|our|another|other|each|every|all|both|own|new|no|which|archive|separate|bookmarked|current|whole|one|largest|smallest|biggest|newest|oldest|empty)\s*$/;
const CONTAINER_AFTER = /^(names?|titles?|files?|export|package|list|ids?|registry|entries|filters?|sort|search|count|size)\b/;
const CONTAINER_VERBS = /\b(renam\w*|filter\w*|sort\w*|open\w*|switch\w*|merg\w*|star\w*|bookmark\w*|archiv\w*|delet\w*|remov\w*|creat\w*|start\w*|re-?add\w*|back(?:ing)? up|sync\w*|import\w*|export\w*|align\w*|pick\w*|choos\w*|select\w*|load\w*|sav\w*|restor\w*|lin(?:k|ked))\b[^.;:]{0,30}$/;

/**
 * The sense of the occurrence of "graph"/"graphs" at `index` in `sentence`. Order matters: the
 * specific technical and drawn readings are tested before the broad container ones.
 */
export function graphSense(sentence: string, index: number, word = sentence.slice(index).match(/^graphs?/i)?.[0] ?? 'graph'): SenseResult {
  const before = sentence.slice(0, index).toLowerCase();
  const after = sentence.slice(index + word.length).toLowerCase().replace(/^[\s'’]+s?\s*/, '');
  if (FILE_BEFORE.test(before)) return { sense: 'reword', rule: 'a file format before it: the reader means a file' };
  if (TECHNICAL_BEFORE.test(before)) return { sense: 'keep', rule: 'named/default/knowledge/RDF graph: a standard term' };
  if (DRAWN_AFTER.test(after) || DRAWN_BEFORE.test(before)) return { sense: 'keep', rule: 'nodes, edges, view or layout: the drawn picture' };
  if (CONTAINER_AFTER.test(after)) return { sense: 'space', rule: 'graph name/title/file/export/package: the thing itself' };
  if (CONTAINER_BEFORE.test(before)) return { sense: 'space', rule: 'this/your/other/new graph: one of a collection' };
  if (CONTAINER_VERBS.test(before)) return { sense: 'space', rule: 'renamed, opened, starred, synced: something you hold' };
  if (/^graphs$/i.test(word)) return { sense: 'space', rule: 'plural: a collection of them' };
  return { sense: 'undecided', rule: 'no rule fired' };
}
