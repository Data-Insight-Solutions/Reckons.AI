/**
 * Extraction Prompt Variant Registry
 *
 * A typed registry of named system-prompt variants for triple extraction,
 * used by the bench matrix runner (`run-extraction-matrix.ts`) to compare
 * how different models respond to different prompting strategies.
 *
 * 'full' and 'compact' are imported directly from extractor.ts — the actual
 * production prompts — never copied, so this registry can't drift from what
 * ships. The remaining variants are experimental prompts designed to test
 * distinct prompting hypotheses against the same fixture/scorer used by the
 * rest of tests/bench, so results are comparable across variants and across
 * historical bench runs.
 *
 * Every variant MUST start with ETHICS_PREAMBLE and MUST produce the same
 * ExtractedTriple JSON-array output contract as production — only the
 * instructional framing differs. Do not weaken or omit the preamble.
 */

import { ETHICS_PREAMBLE } from '../../src/lib/safety/content-policy';
// EXTRACTION_SYSTEM_PROMPT_FEWSHOT was named ..._COMPACT until 2026-07-12, when it was renamed
// because "compact" was actively misleading — it is the LARGEST prompt in the app, and the extra
// tokens are the three worked examples that take llama3.2:3b from F1 0.238 to 0.500. Importing
// the old name yields `undefined`, which is how three tests in this suite were failing: the
// variant's systemPrompt was undefined, so even the ETHICS_PREAMBLE assertion never ran green.
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT_FEWSHOT } from '../../src/lib/integrations/llm/extractor';

export type PromptVariantId = 'full' | 'compact' | 'few-shot-3' | 'schema-first' | 'checklist';

export type PromptVariant = {
  /** Stable registry key, also used in result filenames and table columns */
  id: PromptVariantId;
  /** Short human-readable name for console/table display */
  label: string;
  /** What hypothesis this variant tests, for the reader of bench results */
  hypothesis: string;
  /** The full system prompt (always starts with ETHICS_PREAMBLE) */
  systemPrompt: string;
};

// ── Experimental variant: few-shot-3 ────────────────────────────────────────
//
// Hypothesis: small/mid models follow a short rule list better when it's
// paired with several concrete worked examples, and generalize better when
// those examples span unrelated domains (rather than reusing the fixture's
// own subject matter, which EXTRACTION_SYSTEM_PROMPT_COMPACT's octopus
// example risks doing for this specific octopus.txt fixture). All three
// examples below are deliberately off-domain from octopus.txt.

const FEW_SHOT_3_PROMPT = ETHICS_PREAMBLE + `Extract facts from text as a JSON array of triples.

Each triple: {"subject": "kebab-case-slug", "predicate": "kebab-case-verb-phrase", "object": "kebab-case-slug-or-literal", "objectIsLiteral": true|false, "datatype": "string|number|date|boolean", "gloss": "one short sentence", "confidence": 0.0-1.0, "excerpt": "verbatim source sentence"}

Rules: one fact per triple; objectIsLiteral=true for dates/numbers/plain strings; excerpt must be copied exactly from the source; never invent facts; output ONLY the JSON array, no prose, no markdown fences.

Example 1:
Input: "The Eiffel Tower was completed in 1889 and stands 330 meters tall."
Output: [{"subject":"eiffel-tower","predicate":"was-completed-in","object":"1889","objectIsLiteral":true,"datatype":"number","gloss":"The Eiffel Tower was completed in 1889.","confidence":0.95,"excerpt":"The Eiffel Tower was completed in 1889 and stands 330 meters tall."},{"subject":"eiffel-tower","predicate":"has-height-meters","object":"330","objectIsLiteral":true,"datatype":"number","gloss":"The Eiffel Tower stands 330 meters tall.","confidence":0.95,"excerpt":"The Eiffel Tower was completed in 1889 and stands 330 meters tall."}]

Example 2:
Input: "Photosynthesis converts carbon dioxide and water into glucose using light energy."
Output: [{"subject":"photosynthesis","predicate":"converts","object":"carbon-dioxide-and-water","objectIsLiteral":false,"gloss":"Photosynthesis converts carbon dioxide and water.","confidence":0.9,"excerpt":"Photosynthesis converts carbon dioxide and water into glucose using light energy."},{"subject":"photosynthesis","predicate":"produces","object":"glucose","objectIsLiteral":false,"gloss":"Photosynthesis produces glucose.","confidence":0.9,"excerpt":"Photosynthesis converts carbon dioxide and water into glucose using light energy."},{"subject":"photosynthesis","predicate":"requires","object":"light-energy","objectIsLiteral":false,"gloss":"Photosynthesis requires light energy.","confidence":0.85,"excerpt":"Photosynthesis converts carbon dioxide and water into glucose using light energy."}]

Example 3:
Input: "Ada Lovelace, born in London, is regarded as the first computer programmer."
Output: [{"subject":"ada-lovelace","predicate":"was-born-in","object":"london","objectIsLiteral":false,"gloss":"Ada Lovelace was born in London.","confidence":0.9,"excerpt":"Ada Lovelace, born in London, is regarded as the first computer programmer."},{"subject":"ada-lovelace","predicate":"is-regarded-as","object":"first-computer-programmer","objectIsLiteral":false,"gloss":"Ada Lovelace is regarded as the first computer programmer.","confidence":0.85,"excerpt":"Ada Lovelace, born in London, is regarded as the first computer programmer."}]`;

// ── Experimental variant: schema-first ──────────────────────────────────────
//
// Hypothesis: leading with the exact output schema (before any behavioral
// rules) anchors the model on structure first, reducing schema drift for
// models that otherwise attend more to early tokens than late ones. Prose is
// kept intentionally minimal — rules are one line each, no worked examples.

const SCHEMA_FIRST_PROMPT = ETHICS_PREAMBLE + `Output format (JSON array, no other text):

[
  {
    "subject": string,       // kebab-case concept slug
    "predicate": string,     // kebab-case verb phrase
    "object": string,        // kebab-case slug, or literal value if objectIsLiteral
    "objectIsLiteral": boolean,
    "datatype": "string" | "number" | "date" | "boolean",  // only when objectIsLiteral
    "gloss": string,         // one short human-readable sentence
    "confidence": number,    // 0.0-1.0
    "excerpt": string        // verbatim source sentence this triple came from
  }
]

Task: read the source text below and emit triples matching the schema above exactly.

Constraints:
- One atomic fact per triple.
- excerpt is copied verbatim from the source — never paraphrased.
- Never invent facts absent from the source.
- No markdown fences, no prose before or after the array.`;

// ── Experimental variant: checklist ─────────────────────────────────────────
//
// Hypothesis: a numbered, ordered extraction procedure (entities, then
// relations between them, then literal attributes) reduces missed/merged
// facts versus a flat rule list by giving the model an explicit pass
// structure to follow, similar to how a human annotator would work.

const CHECKLIST_PROMPT = ETHICS_PREAMBLE + `You are an information extraction system. Convert source text into a JSON array of RDF-style triples by following this procedure in order:

STEP 1 — Identify entities. Read the text and list the distinct real-world concepts, people, places, and things it mentions. Give each a kebab-case slug (e.g. "coffee-bean", "marie-curie").

STEP 2 — Extract relations between entities. For each pair of entities the text directly relates, emit a triple: {subject, predicate, object} where predicate is a kebab-case verb phrase (e.g. "is-located-in", "was-founded-by") and object is another entity's slug. Set objectIsLiteral=false.

STEP 3 — Extract literal attributes. For each entity, emit a triple for every date, number, or descriptive string the text states about it. Set objectIsLiteral=true and datatype to "string", "number", "date", or "boolean" as appropriate.

STEP 4 — Annotate each triple from steps 2-3 with:
- gloss: one short human-readable sentence describing the fact
- confidence: 0.0-1.0, how clearly the source supports it
- excerpt: the verbatim source sentence or phrase it was derived from (copy exactly, never paraphrase)

STEP 5 — Consolidate. Merge triples that restate the same fact; do not invent facts absent from the text. A 500-word text should typically yield 8-20 triples.

Output ONLY the final JSON array from steps 2-4 combined. No prose, no markdown fences, no step labels in the output.`;

// ── Registry ─────────────────────────────────────────────────────────────────

export const PROMPT_VARIANTS: Record<PromptVariantId, PromptVariant> = {
  full: {
    id: 'full',
    label: 'full (production)',
    hypothesis: 'Baseline: the full 11-rule production prompt used for large models.',
    systemPrompt: EXTRACTION_SYSTEM_PROMPT
  },
  compact: {
    // Variant id stays 'compact' so existing result files and column order keep working; the
    // LABEL says few-shot, because the app deliberately stopped calling this prompt compact.
    id: 'compact',
    label: 'few-shot (production)',
    hypothesis: 'Baseline: the production small-model prompt — restated schema + 3 worked examples.',
    systemPrompt: EXTRACTION_SYSTEM_PROMPT_FEWSHOT
  },
  'few-shot-3': {
    id: 'few-shot-3',
    label: 'few-shot-3',
    hypothesis: 'Compact rules + 3 off-domain worked examples generalize better than domain-adjacent examples.',
    systemPrompt: FEW_SHOT_3_PROMPT
  },
  'schema-first': {
    id: 'schema-first',
    label: 'schema-first',
    hypothesis: 'Leading with the exact output schema (minimal prose, no examples) reduces schema drift.',
    systemPrompt: SCHEMA_FIRST_PROMPT
  },
  checklist: {
    id: 'checklist',
    label: 'checklist',
    hypothesis: 'A numbered entities-then-relations-then-literals procedure reduces missed/merged facts.',
    systemPrompt: CHECKLIST_PROMPT
  }
};

/** Ordered list of variant ids — controls column order in the matrix table. */
export const PROMPT_VARIANT_IDS: PromptVariantId[] = ['full', 'compact', 'few-shot-3', 'schema-first', 'checklist'];

export function getPromptVariant(id: PromptVariantId): PromptVariant {
  const variant = PROMPT_VARIANTS[id];
  if (!variant) throw new Error(`Unknown prompt variant: ${id}`);
  return variant;
}
