/**
 * TELL SOMEONE THE GRAPH THEY JUST OPENED HAS A GUIDED STORY IN IT.
 *
 * Matt, 2026-09-04: "Can we notify the user if there is a story in the graph to prompt them to
 * start it?"
 *
 * THE PROBLEM IS DISCOVERABILITY, AND IT IS INVISIBLE FROM THE INSIDE. A story lives in the graph
 * as `story:Step` triples and surfaces only in one tab of the Shelly panel. Someone handed a graph
 * by a colleague has no reason to open that panel, so the author's carefully ordered walk through
 * their own subject is functionally hidden — the reader gets a node cloud and their own guesswork
 * instead. The person who wrote the story cannot see this, because they already know it is there.
 *
 * NOT A TUTORIAL HINT, DELIBERATELY. tutorial.svelte.ts exists and would have been the easy home,
 * but every nudge in it is suppressed by `settings.showTutorialHints`. That flag means "I know my
 * way around this app" — it does not mean "do not tell me what is inside a file someone sent me".
 * A story is a property of the GRAPH, not a lesson about the product, so turning off beginner tips
 * must not hide it.
 *
 * ONCE PER GRAPH, NOT ONCE PER LOAD. The notification id carries the graph's own id, and `oneTime`
 * persists dismissal in localStorage — so it appears when you first open a graph that has a story
 * and never nags again on that graph, while a DIFFERENT graph with a story still announces itself.
 */
import { pushNotification } from './notifications.svelte';
import type { Statement } from '$lib/rdf/types';

const STEP_TYPES = new Set(['urn:reckons:story/Step', 'urn:kbase:type/TestStep']);
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const STORY_TITLE = 'urn:reckons:story/title';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const STORY_TYPE = 'urn:reckons:story/Story';

export interface StoryPresence {
  steps: number;
  /** The story's own label, when it names itself. */
  title?: string;
}

/**
 * How many story steps a graph holds, and what the story calls itself.
 *
 * Counts SUBJECTS rather than triples: a step is one node carrying several predicates, and
 * counting statements would report "17 steps" for a five-step story.
 */
export function detectStory(statements: readonly Statement[]): StoryPresence {
  const stepSubjects = new Set<string>();
  let title: string | undefined;
  const storySubjects = new Set<string>();

  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (st.p.value !== RDF_TYPE) continue;
    if (STEP_TYPES.has(st.o.value)) stepSubjects.add(st.s.value);
    else if (st.o.value === STORY_TYPE) storySubjects.add(st.s.value);
  }

  if (storySubjects.size > 0) {
    for (const st of statements) {
      if (!storySubjects.has(st.s.value)) continue;
      if (st.p.value !== STORY_TITLE && st.p.value !== RDFS_LABEL) continue;
      if (st.o.kind !== 'literal') continue;
      title = st.o.value;
      if (st.p.value === RDFS_LABEL) break;
    }
  }

  return { steps: stepSubjects.size, title };
}

/**
 * Announce a graph's story, at most once per graph.
 *
 * `graphId` scopes the dismissal. Passing a stable id (the KB id) is what makes this
 * once-per-graph rather than once-per-device — dismissing the turtle graph's prompt must not
 * silence the next graph someone sends.
 */
export function promptStoryIfPresent(statements: readonly Statement[], graphId: string): StoryPresence {
  const found = detectStory(statements);
  // One step is a fragment, not a walk. Announcing it would spend the user's attention on nothing.
  if (found.steps < 2) return found;

  pushNotification({
    id: `story:available:${graphId}`,
    type: 'info',
    title: found.title ? `“${found.title}” is a guided story` : 'This graph has a guided story',
    body: `${found.steps} steps, written by whoever built this graph. It changes the view as the question changes.`,
    action: { label: 'Start the story' },
    oneTime: true,
  });
  return found;
}
