/**
 * Cost Bench — KB-grounded generation tasks for the system-vs-Opus-alone comparison.
 *
 * Each task asks for a short prose blurb grounded in the Reckons KBs. We grade by
 * whether the output covers the expected facts (all arms judged identically), and
 * we compare the Opus token cost of three arms:
 *   A0  Opus alone      — full raw KB corpus in context, Opus writes the blurb
 *   A1  Opus + graph    — compressed (query-selected) subgraph, Opus writes the blurb
 *   A2  full system     — local model writes the blurb from the compressed subgraph;
 *                         Opus only reviews/corrects (short output)
 *
 * Generation tasks (not just Q&A) are deliberate: the delegation win in A2 is on
 * OUTPUT tokens (Opus's most expensive tokens), which only shows when there's real
 * output to offload.
 */

export interface CostTask {
  id: string;
  /** The generation instruction handed to whichever model writes the blurb. */
  prompt: string;
  /** Query used to select the compressed subgraph (A1/A2 context). */
  query: string;
  /** Lowercased substrings the output should contain; grading is coverage = hits/total. */
  expect: string[];
  /** Max output tokens for the writing arms (default 400). Large for long-form tasks. */
  maxOut?: number;
}

/** KB files concatenated to form the raw corpus (A0 context). Missing files are skipped. */
export const CORPUS_FILES = [
  'static/reckons-production.ttl',
  'static/docs-features.ttl',
];

export const COST_TASKS: CostTask[] = [
  {
    id: 'mcp-overview',
    prompt:
      'Write a 3-4 sentence overview of the Reckons.AI MCP server for a README: what it is, ' +
      'what it runs on, and name a few of the tools it exposes. Ground every claim in the provided knowledge graph.',
    query: 'MCP server tools kb_search kb_stats kb_compress Node N3',
    expect: ['mcp', 'kb_'],
  },
  {
    id: 'ingest-feature',
    prompt:
      'Write a short feature blurb (3-4 sentences) describing how Reckons.AI ingests a source into ' +
      'the knowledge graph, grounded strictly in the provided graph.',
    query: 'ingest extraction triples source LLM extractor',
    expect: ['ingest', 'triple'],
  },
  {
    id: 'safety-summary',
    prompt:
      'Write a 3-4 sentence summary of Reckons.AI content-safety approach for the docs, ' +
      'grounded in the provided graph.',
    query: 'content safety ethics preamble policy classifier blocked',
    expect: ['safety', 'ethic'],
  },
];

// Long-form task: this is where A2 (local delegation) should finally beat A1,
// because the expensive part is now the OUTPUT and the local model writes it for free.
COST_TASKS.push({
  id: 'full-docs-page',
  prompt:
    'Write a thorough ~700-word documentation page (Markdown, with headings) covering Reckons.AI: ' +
    'what it is, its MCP server and tools, how ingestion works, content safety, and the test suite. ' +
    'Ground every claim strictly in the provided knowledge graph; do not invent facts.',
  query: 'MCP server tools kb_search ingest extraction triples content safety ethics preamble test suite production',
  expect: ['mcp', 'kb_', 'ingest', 'safety', 'test'],
  maxOut: 1100,
});

export const TOTAL_COST_TASKS = COST_TASKS.length;
