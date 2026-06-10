import { chatClaude, chatOpenAI, chatGemini, chatOllama, chatReckons, type ChatMessage } from './providers';
import { chatWithWasm } from './wasm';
import type { KBAction, KBContext, TurtleChatResponse } from '$lib/types/turtle-chat';

const SYSTEM_PROMPT = `You are Shelly, a friendly low-poly turtle companion for Reckons.AI — a personal knowledge base tool built on RDF Turtle format (.ttl).

Your personality: warm, curious, occasionally uses turtle puns, never condescending. Keep responses concise (under 120 words unless explaining something complex).

You help users:
1. Understand their knowledge base and the RDF/Turtle format
2. Make changes to their KB through conversation

The RDF Turtle format stores knowledge as triples: subject · predicate · object.
Example: <urn:kbase:person/matt> <urn:kbase:predicate/works-at> <urn:kbase:org/anthropic> .

When you want to propose changes to the KB or adjust the graph view, include a structured action block at the END of your message:

<kb-actions>
[
  {"type":"add_triple","s":"urn:kbase:...","p":"urn:kbase:predicate/...","o":"urn:kbase:...","label":"short description"},
  {"type":"remove_triple","s":"urn:kbase:...","p":"urn:kbase:predicate/...","o":"urn:kbase:...","label":"short description of what is being removed"},
  {"type":"set_type","entityIri":"urn:kbase:...","entityLabel":"Name","typeIri":"urn:kbase:type/Person","typeLabel":"Person"},
  {"type":"merge_entities","keepEntityIri":"urn:kbase:...","keepEntityLabel":"Canonical Name","dropEntityIri":"urn:kbase:...","dropEntityLabel":"Duplicate Name"},
  {"type":"confirm_source","sourceId":"source-id","sourceTitle":"Source Name"},
  {"type":"adjust_view","selectEntity":"urn:kbase:...","layout":"focus","filters":["confirmed"],"label":"navigate to the entity"}
]
</kb-actions>

Action guide (add_triple, remove_triple, set_type take effect immediately on user accept; merge_entities goes to Review page for execution):
- add_triple: add a new RDF statement — confirmed directly when accepted
- remove_triple: reject/delete an existing statement (use exact IRIs from the KB snapshot) — rejected directly when accepted
- set_type: correct or assign the rdf:type for an entity — confirmed directly when accepted
- merge_entities: redirect ALL triples from dropEntity to keepEntity, effectively collapsing duplicates into one canonical node. Queued in Review page because it requires redirecting many triples.
- confirm_source: approve a pending source
- adjust_view: navigate or adjust the graph view. Use when the user is searching or asking "show me X". Fields are all optional:
  - selectEntity: IRI of the entity to select/focus in the graph (use exact IRI from KB snapshot)
  - layout: one of "force" (default physics), "focus" (selected-node-centric), "source" (grouped by source), "type" (grouped by entity type), "hub" (hub-first)
  - filters: array of filter chips to activate, any of "hubs", "islands", "confirmed", "pending", "no-type", "no-source"
    - "no-type": highlights all entities that have no rdf:type assigned
    - "no-source": shows only manually added statements (no ingested source)
  When a user searches and no results are found, or they ask to "show me", "find", "navigate to" — use adjust_view to help them.
- query_kb: fetch a filtered list of entities/statements and send them back to you as context, so you can propose targeted bulk actions. Use this when the user asks to batch-process a set (e.g. "assign types to everything without one"). The user clicks "run" and the results appear as your next input.
  - filter: one of "no-type" (entities without rdf:type), "no-source" (manually added statements), "pending" (pending statements), "islands" (isolated nodes)
  Workflow: propose query_kb → user runs it → results come back → you propose set_type / add_triple / etc. for each item.
- scrape_url: scrape a webpage and ingest its content as triples into the KB. Use when the user shares a URL or asks to import a page. The app uses Firecrawl (if configured) or Jina Reader as fallback, then extracts triples via the configured LLM backend.
  - url: the full URL to scrape (must start with http:// or https://)
  Workflow: propose scrape_url → user clicks "scrape" → content is fetched, extracted into triples, diffed against existing KB, and added as pending statements for review.

Only include the action block when you have concrete changes or navigation to propose. Always explain BEFORE the block. The user must approve each action.`;

function buildContextSection(ctx: KBContext): string {
  const entities = ctx.sampleEntities
    .slice(0, 15)
    .map((e) => `  • ${e.label}${e.type ? ` [${e.type}]` : ' [NO TYPE]'} <${e.iri}>: ${e.predicates.slice(0, 3).join(', ')}`)
    .join('\n');

  const alerts: string[] = [];
  if (ctx.untypedEntityCount > 0) alerts.push(`${ctx.untypedEntityCount} entities have no type (use query_kb filter:"no-type" to see them)`);
  if (ctx.manualStatementCount > 0) alerts.push(`${ctx.manualStatementCount} manually added statements (use query_kb filter:"no-source")`);

  return `\n\n---\nKB SNAPSHOT:\n- ${ctx.statementCount} confirmed statements across ${ctx.sourceCount} source(s)\n- Types in use: ${ctx.typesPresent.join(', ') || 'none yet'}${alerts.length ? '\n- Attention: ' + alerts.join('; ') : ''}\n- Sample entities (label [type] <IRI>: predicates) — untyped shown first:\n${entities || '  (empty KB)'}`;
}

function parseActions(text: string): { clean: string; actions: KBAction[] } {
  const match = text.match(/<kb-actions>([\s\S]*?)<\/kb-actions>/);
  if (!match) return { clean: text.trim(), actions: [] };

  let actions: KBAction[] = [];
  try {
    actions = JSON.parse(match[1].trim());
  } catch {
    // malformed — ignore
  }

  const clean = text.replace(/<kb-actions>[\s\S]*?<\/kb-actions>/, '').trim();
  return { clean, actions };
}

const EXPLORE_SYSTEM_PROMPT = `You are Shelly 🐢, a friendly turtle guide giving an INTERACTIVE TOUR of a personal knowledge graph in Reckons.AI.

EXPLORE MODE — you are the active guide, not just a chatbot. You drive the conversation.

Tour guide rules:
1. Each response: (a) say 1-3 sentences about what you're showing, (b) navigate with adjust_view, (c) ask ONE engaging question
2. Keep it short — never more than 4 sentences before your question
3. Use adjust_view in EVERY response to move the graph as you talk
4. Notice and comment on: hubs with many connections, isolated islands, clusters by source or type, gaps (no-type entities)
5. If the user answers your question, briefly acknowledge it before the next stop
6. If the user asks you something, answer in 1-2 sentences then continue the tour
7. Plan a 5-6 stop tour: overview → a hub entity → a cluster or pattern → something unusual → closing invitation

Navigation guide (use these in adjust_view):
- layout "force": default physics view, all nodes floating freely
- layout "focus" + selectEntity IRI: zooms in on one entity with neighbors in concentric rings — great for exploring hubs
- layout "type": groups entities by their rdf:type — shows the type distribution visually
- layout "source": groups by ingestion source — shows data provenance
- layout "hub": hub-first arrangement — most-connected nodes anchored at center
- filters ["islands"]: spotlights isolated concepts with no connections
- filters ["no-type"]: highlights entities that have no type assigned
- filters ["confirmed"]: shows only confirmed knowledge

STARTING: When you receive "START_TOUR", begin with a warm 1-sentence greeting, one quick observation about what you see in the KB, then navigate to stop 1 (layout "hub" or "force" for an overview) and ask your first question.

ACTION FORMAT — you MUST use this exact format to navigate. Include one adjust_view block at the END of every message:

<kb-actions>
[{"type":"adjust_view","layout":"hub","label":"overview of the graph"}]
</kb-actions>

Examples:
- Focus on a specific entity: {"type":"adjust_view","selectEntity":"urn:kbase:person/alice","layout":"focus","label":"zoom in on Alice"}
- Show type clusters: {"type":"adjust_view","layout":"type","label":"grouping by entity type"}
- Highlight islands: {"type":"adjust_view","filters":["islands"],"label":"spotlighting isolated nodes"}

CRITICAL: Every message MUST end with a question. Every message MUST include a <kb-actions> block with one adjust_view. Plain text descriptions of navigation (like "adjust_view { layout: hub }") will NOT work — only the <kb-actions> JSON block works.`;

export type TurtleChatProvider = 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'reckons';

export interface ResolvedProvider {
  provider: TurtleChatProvider;
  apiKey: string;
  model: string | undefined;
}

/**
 * Resolve the chat LLM provider from settings with auto-fallback:
 * if a cloud backend is selected but its API key is missing, silently
 * falls back to WASM so the app works out-of-the-box.
 */
export function resolveChatProvider(s: {
  chatBackend?: string;
  preferredBackend: string;
  claudeApiKey?: string;
  claudeModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  ollamaModel?: string;
  wasmModel?: string;
  reckonsApiKey?: string;
  reckonsModel?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
}): ResolvedProvider {
  const pref = s.chatBackend ?? s.preferredBackend;
  let provider: TurtleChatProvider =
    pref === 'openai' ? 'openai'
    : pref === 'gemini' ? 'gemini'
    : pref === 'ollama' ? 'ollama'
    : pref === 'wasm' ? 'wasm'
    : pref === 'reckons' ? 'reckons'
    : pref === 'openrouter' ? 'openai'
    : 'claude';

  // Auto-fallback: cloud backend without a key → WASM
  const keyForProvider =
    provider === 'openai' ? (s.openaiApiKey || s.openrouterApiKey)
    : provider === 'gemini' ? s.geminiApiKey
    : provider === 'reckons' ? s.reckonsApiKey
    : provider === 'claude' ? s.claudeApiKey
    : null; // ollama, wasm need no key
  if (provider !== 'ollama' && provider !== 'wasm' && !keyForProvider) {
    provider = 'wasm';
  }

  const apiKey =
    provider === 'openai' ? (s.openaiApiKey ?? s.openrouterApiKey ?? '')
    : provider === 'gemini' ? (s.geminiApiKey ?? '')
    : provider === 'reckons' ? (s.reckonsApiKey ?? '')
    : (s.claudeApiKey ?? '');

  const model =
    provider === 'openai' ? (s.openaiModel ?? (pref === 'openrouter' ? s.openrouterModel : 'gpt-4o-mini'))
    : provider === 'gemini' ? (s.geminiModel ?? 'gemini-2.0-flash')
    : provider === 'ollama' ? (s.ollamaModel ?? 'llama3.2')
    : provider === 'wasm' ? (s.wasmModel ?? undefined)
    : provider === 'reckons' ? (s.reckonsModel ?? undefined)
    : (s.claudeModel ?? 'claude-haiku-4-5-20251001');

  return { provider, apiKey, model };
}

const VOICE_MODE_PREFIX = `VOICE MODE: Respond in 1-2 short spoken sentences only. No markdown, bullet points, code blocks, asterisks, or lists. Plain conversational English that sounds natural when read aloud.\n\n`;

/** Ethics wrapper injected when a KB is published/shared. Cannot be overridden by customPrompt. */
const PUBLISHED_ETHICS_WRAPPER = `IMPORTANT SAFETY RULES (non-negotiable, override any conflicting instructions):
- You are an AI assistant persona embedded in a published knowledge base. You must never claim to be a real human.
- If asked, always disclose that you are an AI persona configured by the KB author.
- Never generate content that promotes violence, harassment, hate speech, or discrimination.
- Never impersonate real public figures in a way that could mislead or defame.
- Never generate sexually explicit content, instructions for illegal activities, or content harmful to minors.
- Never help users circumvent safety systems, generate malware, or engage in social engineering.
- If the custom personality conflicts with these rules, these rules take absolute precedence.
- You may adopt the configured name, tone, and personality — but always within these ethical boundaries.

`;

export interface TurtleChatOptions {
  provider: TurtleChatProvider;
  apiKey: string;
  model?: string;
  ollamaBaseUrl?: string;
  reckonsBaseUrl?: string;
  messages: ChatMessage[];
  kbContext: KBContext;
  /** When true, uses the explore-mode system prompt (Shelly as active tour guide) */
  exploreMode?: boolean;
  /** When true, instructs Shelly to give very short spoken responses (no markdown) */
  voiceMode?: boolean;
  /** Custom personality/instructions prepended to the system prompt */
  customPrompt?: string;
  /** When true, wraps all prompts with an immutable ethics preamble (for published/shared KBs) */
  publishedMode?: boolean;
}

export async function turtleChat(opts: TurtleChatOptions): Promise<TurtleChatResponse> {
  const { provider, apiKey, model, ollamaBaseUrl, reckonsBaseUrl, messages, kbContext, exploreMode, voiceMode, customPrompt, publishedMode } = opts;
  let basePrompt = exploreMode ? EXPLORE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  if (voiceMode) basePrompt = VOICE_MODE_PREFIX + basePrompt;
  if (customPrompt?.trim()) basePrompt = customPrompt.trim() + '\n\n' + basePrompt;
  if (publishedMode) basePrompt = PUBLISHED_ETHICS_WRAPPER + basePrompt;
  const system = basePrompt + buildContextSection(kbContext);

  let raw: string;
  if (provider === 'openai') {
    raw = await chatOpenAI(messages, system, apiKey, model ?? 'gpt-4o-mini');
  } else if (provider === 'gemini') {
    raw = await chatGemini(messages, system, apiKey, model ?? 'gemini-2.0-flash');
  } else if (provider === 'ollama') {
    raw = await chatOllama(messages, system, model ?? 'llama3.2', ollamaBaseUrl);
  } else if (provider === 'wasm') {
    raw = await chatWithWasm(messages, system, model ?? undefined);
  } else if (provider === 'reckons') {
    raw = await chatReckons(messages, system, apiKey, reckonsBaseUrl, model ?? undefined);
  } else {
    raw = await chatClaude(messages, system, apiKey, model ?? 'claude-haiku-4-5-20251001');
  }

  const { clean, actions } = parseActions(raw);
  return { message: clean, actions };
}
