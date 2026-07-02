/**
 * kb_generate_page — prompt-guided WebPage markdown drafting, grounded in
 * the graph via the same search → subgraph → compress pipeline as
 * kb_compress (see `compressTriples` in `index.ts`; the caller builds the
 * `graphContext` block and passes it in here). Generation uses a LOCAL
 * Ollama model (see `ollama-client.ts`) — same opt-in gate (`OLLAMA_BASE_URL`)
 * and disabled-message style as `kb_local_extract`/`kb_local_summarize`.
 *
 * PROPOSAL ONLY: this module never writes to any KB or file. It returns a
 * complete markdown document (frontmatter + body, see `page-markdown.ts`)
 * plus the raw generated fields, for a human (or another tool) to review.
 */

import { ETHICS_PREAMBLE } from './ethics-preamble.js';
import { ollamaChatJSON, type OllamaChatMessage } from './ollama-client.js';
import { frontmatterToMarkdown, slugify, type PageFrontmatter, type PageTemplate } from './page-markdown.js';

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    excerpt: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'excerpt', 'body'],
};

/** Small-model-friendly system prompt: grounding discipline first, format rules second. */
export const GENERATE_PAGE_SYSTEM_PROMPT =
  ETHICS_PREAMBLE +
  `You write documentation pages for a knowledge graph product, grounded strictly in the
GRAPH CONTEXT provided in the user message. Rules:
1. Use ONLY facts present in the GRAPH CONTEXT — never invent facts, numbers, or claims not stated there.
2. Cite entity names as plain text (no markdown links needed).
3. Start the body with one short excerpt-style sentence, then the rest of the content.
4. Output JSON only, matching the schema: {"title": string, "excerpt": string, "body": string}. No markdown fence, no extra text.
5. "excerpt" is one short sentence (roughly 15-25 words) summarizing the page.
6. "body" is the long-form markdown content (headings, lists, prose as appropriate) — do not repeat frontmatter, start directly with the content.
7. If the GRAPH CONTEXT is thin or irrelevant to the prompt, say so plainly in the body rather than inventing content.`;

export interface GeneratePageParams {
  prompt: string;
  section?: string;
  slug?: string;
  title?: string;
  template?: PageTemplate;
}

export interface GeneratePageResult {
  frontmatter: PageFrontmatter;
  body: string;
  markdown: string;
}

const TEMPLATES = new Set<PageTemplate>(['landing', 'doc', 'full', 'sidebar', 'post']);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Generate a WebPage markdown document from a prompt + a pre-built graph
 * context block. Calls a local Ollama model with a JSON-schema-constrained
 * request (one repair retry, via `ollamaChatJSON`).
 */
export async function generatePageMarkdown(
  params: GeneratePageParams,
  graphContext: string,
): Promise<GeneratePageResult> {
  const template: PageTemplate = params.template && TEMPLATES.has(params.template) ? params.template : 'doc';

  const userPrompt = [
    `PROMPT: ${params.prompt}`,
    params.title ? `SUGGESTED TITLE: ${params.title}` : null,
    '',
    'GRAPH CONTEXT:',
    graphContext || '(no relevant facts found in the knowledge base)',
    '',
    'Write the documentation page now, as JSON matching the schema.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: GENERATE_PAGE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const parsed = await ollamaChatJSON<{ title?: string; excerpt?: string; body?: string }>(messages, GENERATE_SCHEMA);

  const title = params.title?.trim() || parsed.title?.trim() || 'Untitled';
  const slug = params.slug?.trim() ? slugify(params.slug) : slugify(title);
  const section = params.section?.trim() || 'docs';
  const body = (parsed.body ?? '').trim() || `# ${title}\n`;
  const excerpt = parsed.excerpt?.trim() ?? '';

  const frontmatter: PageFrontmatter = {
    title,
    slug,
    order: 0,
    section,
    template,
    status: 'draft',
    nav: 'sidebar',
    excerpt,
  };
  if (template === 'post') frontmatter.date = todayIso();

  return { frontmatter, body, markdown: frontmatterToMarkdown(frontmatter, body) };
}
