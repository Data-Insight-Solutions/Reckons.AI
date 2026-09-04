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

const STORY_NS = 'urn:reckons:story/';
const STORY_TYPE = `${STORY_NS}Story`;
const STEP_TYPE = `${STORY_NS}Step`;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
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
}

export interface Story {
  id: string;
  label: string;
  description: string;
  steps: StoryStep[];
  autoplay: boolean;
  /** Seconds between auto-advance steps */
  pace: number;
}

/**
 * Extract all stories defined in the KB from confirmed/refined statements.
 */
export function extractStories(stmts: Statement[]): Story[] {
  const confirmed = stmts.filter(
    s => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending'
  );

  // Find story entities (match both IRI and literal type values)
  const storyIris = new Set<string>();
  for (const st of confirmed) {
    if (st.p.value !== RDF_TYPE || st.s.kind !== 'iri') continue;
    const val = st.o.value;
    if (val === STORY_TYPE || val === 'Story') {
      storyIris.add(st.s.value);
    }
  }

  const stories: Story[] = [];

  for (const storyIri of storyIris) {
    const getLiteral = (pred: string): string | null => {
      const st = confirmed.find(
        s => s.s.kind === 'iri' && s.s.value === storyIri && s.p.value === pred
      );
      return st && st.o.kind === 'literal' ? st.o.value : null;
    };

    const label = getLiteral(RDFS_LABEL) ?? getLiteral(`${STORY_NS}title`) ?? storyIri.split('/').pop() ?? 'Untitled Story';
    const description = getLiteral(`${STORY_NS}description`) ?? '';
    const autoplay = getLiteral(`${STORY_NS}autoplay`) === 'true';
    const pace = parseInt(getLiteral(`${STORY_NS}pace`) ?? '8', 10);

    // Find steps linked to this story
    const stepIris = new Set<string>();
    for (const st of confirmed) {
      if (
        st.p.value === `${STORY_NS}partOf` &&
        st.o.kind === 'iri' && st.o.value === storyIri &&
        st.s.kind === 'iri'
      ) {
        stepIris.add(st.s.value);
      }
    }

    const steps: StoryStep[] = [];
    for (const stepIri of stepIris) {
      const getStepLit = (pred: string): string | null => {
        const st = confirmed.find(
          s => s.s.kind === 'iri' && s.s.value === stepIri && s.p.value === pred
        );
        return st && st.o.kind === 'literal' ? st.o.value : null;
      };

      // Collect all highlights for this step
      const highlights: string[] = [];
      for (const st of confirmed) {
        if (
          st.s.kind === 'iri' && st.s.value === stepIri &&
          st.p.value === `${STORY_NS}highlight` &&
          st.o.kind === 'iri'
        ) {
          highlights.push(st.o.value);
        }
      }

      steps.push({
        id: stepIri,
        order: parseInt(getStepLit(`${STORY_NS}order`) ?? '0', 10),
        title: getStepLit(`${STORY_NS}title`) ?? getStepLit(RDFS_LABEL) ?? `Step`,
        content: getStepLit(`${STORY_NS}content`) ?? '',
        highlights,
        prompt: getStepLit(`${STORY_NS}prompt`) ?? undefined,
        question: getStepLit(`${STORY_NS}question`) ?? undefined,
        layout: getStepLit(`${STORY_NS}layout`) ?? undefined
      });
    }

    // Sort by order
    steps.sort((a, b) => a.order - b.order);

    stories.push({ id: storyIri, label, description, steps, autoplay, pace });
  }

  return stories.sort((a, b) => a.label.localeCompare(b.label));
}
