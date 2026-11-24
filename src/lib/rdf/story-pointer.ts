/**
 * A STORY LIVES IN THE SPACE IT WALKS (F300.5, kb:demo-stories-in-spaces).
 *
 * The Testing graph (static/docs-testing.ttl) used to hold every demo walk's steps itself, beside the
 * example space the walk uses. Now the steps are `story:Step` entities inside that example space, and a
 * `ktype:TestWorkflow` keeps only what a docs page and the test runner need that is NOT the walk:
 *
 *   kpred:workflow-id   the docs URL and the screenshot folder
 *   kpred:test-file     the spec that plays the story
 *   kpred:story         <the story:Story IRI in the space>
 *   kpred:story-space   "<example id>"   resolved through EXAMPLE_KBS (src/lib/storage/example-kbs.ts)
 *   + its label, definition, docs placement fields, narrator and storyline
 *
 * PURE: no n3, no filesystem. The caller supplies `loadSpace(id)` (the quads of that example's file), so the
 * scripts read static/ and a unit test reads a string. A pointer that cannot be resolved THROWS with the
 * reason: a docs page must never print a walk with no steps because a path was misspelled.
 */
import { readStoryQuads, type QuadLike, type UnifiedStory } from './story-steps';

const KPRED = 'urn:kbase:predicate/';
export const POINTER = {
  story: `${KPRED}story`,
  space: `${KPRED}story-space`,
} as const;

export interface StoryPointer { workflowIri: string; storyIri: string; spaceId: string }

/** Every TestWorkflow in these quads that points at a story in a space. A half pointer is an error. */
export function readPointers(quads: Iterable<QuadLike>): StoryPointer[] {
  const out: StoryPointer[] = [];
  const subjects = new Map<string, QuadLike[]>();
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const a = subjects.get(q.subject.value) ?? [];
    a.push(q);
    subjects.set(q.subject.value, a);
  }
  for (const [iri, qs] of subjects) {
    const story = qs.find((q) => q.predicate.value === POINTER.story && q.object.termType === 'NamedNode')?.object.value;
    const space = qs.find((q) => q.predicate.value === POINTER.space && q.object.termType === 'Literal')?.object.value.trim();
    if (!story && !space) continue;
    if (!story || !space) throw new Error(`<${iri}> has ${story ? 'kpred:story but no kpred:story-space' : 'kpred:story-space but no kpred:story'}`);
    out.push({ workflowIri: iri, storyIri: story, spaceId: space });
  }
  return out;
}

/**
 * Replace the steps of every pointing workflow with the steps of the story it points at.
 * The workflow keeps its identity, label, description, test file, narrator and storyline; the story
 * supplies the steps, the shots-note, and a narrator when the workflow names none.
 * `stories` are the legacy-read workflows (origin 'test-workflow'); workflows without a pointer pass through.
 */
export function applyPointers(
  stories: UnifiedStory[],
  testingQuads: Iterable<QuadLike>,
  loadSpace: (spaceId: string) => Iterable<QuadLike> | null,
): UnifiedStory[] {
  const pointers = new Map(readPointers(testingQuads).map((p) => [p.workflowIri, p]));
  if (pointers.size === 0) return stories;
  const cache = new Map<string, UnifiedStory[]>();
  return stories.map((w) => {
    const ptr = pointers.get(w.iri);
    if (!ptr) return w;
    if (w.steps.length > 0) throw new Error(`<${w.iri}> has its own steps AND points at <${ptr.storyIri}>: keep one of them`);
    let inSpace = cache.get(ptr.spaceId);
    if (!inSpace) {
      const quads = loadSpace(ptr.spaceId);
      if (!quads) throw new Error(`<${w.iri}> points at example space "${ptr.spaceId}", which is not in EXAMPLE_KBS`);
      inSpace = readStoryQuads(quads).filter((s) => s.origin === 'story');
      cache.set(ptr.spaceId, inSpace);
    }
    const target = inSpace.find((s) => s.iri === ptr.storyIri);
    if (!target) throw new Error(`<${w.iri}> points at <${ptr.storyIri}>, which is not a story:Story in example space "${ptr.spaceId}"`);
    if (target.steps.length === 0) throw new Error(`<${ptr.storyIri}> in "${ptr.spaceId}" has no steps`);
    const ids = target.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) throw new Error(`<${ptr.storyIri}> has two steps with the same story:stepId`);
    const orders = target.steps.map((s) => s.order);
    if (new Set(orders).size !== orders.length) throw new Error(`<${ptr.storyIri}> has two steps with the same story:order`);
    // A docs page prints these for every step, so a pointed story must carry them (the legacy reader requires the same).
    for (const st of target.steps) {
      const missing = [
        !st.detail.trim() && 'story:detail',
        !st.pageName.trim() && 'story:pageName',
        !(st.route || st.openPage || st.actions.some((a) => a.kind === 'open-page')) && 'story:page',
        !(st.boxTarget ?? '').trim() && 'story:boxTarget',
        !st.expects.some((e) => e.kind === 'note') && 'story:assertion',
      ].filter(Boolean);
      if (missing.length) throw new Error(`<${st.iri}> (step "${st.id}" of <${ptr.storyIri}>) has no ${missing.join(', ')}`);
    }
    return {
      ...w,
      steps: target.steps,
      shotsNote: w.shotsNote || target.shotsNote,
      narrator: w.narrator ?? target.narrator,
      storyline: w.storyline ?? target.storyline,
    };
  });
}

