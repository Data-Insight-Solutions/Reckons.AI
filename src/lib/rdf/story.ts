/**
 * Story system — extract structured stories from KB triples.
 *
 * Stories are defined in the KB using the story: vocabulary:
 *
 *   story:MyStory  rdf:type         story:Story ;
 *                  rdfs:label       "My Story Title" ;
 *                  story:description "Overview text" ;
 *                  story:autoplay   "true" ;
 *                  story:pace       "8" .   ## seconds between auto-advance
 *
 *   story:Step1    rdf:type         story:Step ;
 *                  story:partOf     story:MyStory ;
 *                  story:order      "1"^^xsd:integer ;
 *                  story:title      "Welcome" ;
 *                  story:content    "What Shelly says at this step" ;
 *                  story:highlight  <urn:kbase:concept/SomeEntity> ;
 *                  story:prompt     "Optional LLM prompt for elaboration" ;
 *                  story:question   "Optional question for the user" .
 */

import type { Statement } from './types';
import { readStoryQuads, type QuadLike, type UnifiedStep } from './story-steps';
import { parsePageOffer, parseSettingOffer, type StoryOffer } from './story-offers';

const STORY_NS = 'urn:reckons:story/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface StoryStep {
  id: string;
  order: number;
  title: string;
  content: string;
  /** Entity IRIs to highlight in the graph during this step */
  highlights: string[];
  /** Optional prompt for Shelly to elaborate when user asks */
  prompt?: string;
  /** Optional question to pose to the user */
  question?: string;
  /**
   * Graph layout this step should switch to (story:layout).
   *
   * PARSED SINCE 2026-09-04 — the predicate was already being authored in story graphs and NOTHING
   * READ IT. The player only ever chose 'focus' (when a step highlighted one or two entities) or
   * nothing at all, so a step that said "switch to the hierarchy layout" left the reader to do it
   * by hand while the graph sat in whatever view the previous step left behind.
   *
   * Deliberately NOT validated against a layout union here: story.ts parses graphs that may be
   * authored for a newer or older build than the one reading them. An unknown value is passed
   * through and the renderer ignores it, which degrades to today's behaviour instead of throwing.
   */
  layout?: string;
  /** The step's whole view as URL query parameters (story:view, F309): anything the UI can show. */
  view?: string;
  /**
   * Filter names this step wants active (story:filter, repeatable). F304.
   *
   * PARSED PERMISSIVELY like story:layout — the values stay raw strings, because story.ts parses
   * graphs that may be authored for a newer or older build than the one reading them. A step WITH
   * story:filter applies exactly those filters (names this build does not know are dropped at use, in
   * TurtleChatPanel); a step WITHOUT it leaves the filters as they are, the same rule as no layout.
   */
  filters?: string[];
  /** One-click settings and pages the step offers the reader (story:offerSetting, story:openPage; F261). */
  offers?: StoryOffer[];
}

export interface Story {
  id: string;
  label: string;
  description: string;
  steps: StoryStep[];
  autoplay: boolean;
  /** Seconds between auto-advance steps */
  pace: number;
  /** An explicit built-in interaction; graph prose never becomes executable code. */
  interaction?: 'generate-assets';
}

/** Authored offers, in order; anything off the allowlist is dropped (story-offers.ts). */
function stepOffers(raw: UnifiedStep['offers']): StoryOffer[] {
  const out: StoryOffer[] = [];
  for (const o of raw) {
    const offer = o.kind === 'setting' ? parseSettingOffer(o.value) : parsePageOffer(o.value);
    if (offer) out.push(offer);
  }
  return out;
}

/** Statements as the quads the one reader takes (src/lib/rdf/story-steps.ts, F300.1). */
function toQuads(stmts: Statement[]): QuadLike[] {
  return stmts.map(s => ({
    subject: { termType: s.s.kind === 'iri' ? 'NamedNode' : 'Literal', value: s.s.value },
    predicate: { value: s.p.value },
    object: { termType: s.o.kind === 'iri' ? 'NamedNode' : 'Literal', value: s.o.value },
  }));
}

/**
 * Extract all stories defined in the KB from confirmed/refined statements.
 * A thin adapter over readStoryQuads, which also reads legacy test workflows; those are not
 * player stories, so only story:Story resources are kept here.
 */
export function extractStories(stmts: Statement[]): Story[] {
  const confirmed = stmts.filter(
    s => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending'
  );

  const stories: Story[] = readStoryQuads(toQuads(confirmed))
    .filter(u => u.origin === 'story')
    .map(u => ({
      id: u.iri,
      label: u.label,
      description: u.description,
      autoplay: u.autoplay,
      pace: u.pace,
      interaction: u.interaction === 'generate-assets' ? 'generate-assets' as const : undefined,
      steps: u.steps.map((t): StoryStep => ({
        id: t.iri,
        order: t.order,
        title: t.title,
        content: t.content,
        highlights: t.highlights,
        prompt: t.prompt,
        question: t.question,
        layout: t.layout,
        filters: t.filters,
        view: t.view,
        offers: stepOffers(t.offers),
      })),
    }));

  // Previously imported Generated assets examples predate the story triples. Offer the same
  // built-in interaction without rewriting the person's graph or making them re-import it.
  if (!stories.some(s => s.interaction === 'generate-assets')
    && confirmed.some(s => s.s.kind === 'iri' && s.s.value === 'urn:kbase:concept/generated-assets'
      && s.p.value === RDF_TYPE && s.o.value === 'urn:kbase:type/Concept')) {
    stories.push({
      id: `${STORY_NS}create-generated-asset`, label: 'Create an asset with Shelly',
      description: 'Describe an image, generate it locally, then choose a derivation.',
      autoplay: false, pace: 8, interaction: 'generate-assets',
      steps: [
        { id: `${STORY_NS}generate-image`, order: 1, title: 'Imagine an image', content: 'What image would you like me to generate?', highlights: [] },
        { id: `${STORY_NS}derive-asset`, order: 2, title: 'Choose what happens next', content: 'Choose a video, Gaussian splat or another image.', highlights: [] },
      ],
    });
  }
  return stories.sort((a, b) => a.label.localeCompare(b.label));
}
