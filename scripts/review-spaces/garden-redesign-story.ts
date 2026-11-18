/**
 * THE STORY: Larkspur Lane Community Garden (invented). A neighbourhood garden is redesigning its beds
 * before spring planting. This file is only the CONTENT, written to be read: places and people, three
 * sources and what they say, the held facts and the passage each rests on, the open question, a later
 * meeting note that disagrees with some of it, a part to build, the pictures to generate and a guided walk.
 *
 * It is a REVIEW SPACE for one release (v0.2.9), not an example: build-garden-redesign.ts writes it into a
 * private workspace folder and never into this repository. Everything here is made up: the garden, the
 * street, the people (their portraits are illustrations of nobody), the numbers.
 */

export const SLUG = 'review-garden-redesign-v029';
export const TITLE = 'Larkspur Lane Community Garden: bed redesign (review, v0.2.9)';
export const CONCEPT = 'urn:kbase:concept/';
export const PRED = 'urn:kbase:predicate/';
export const TYPE = 'urn:kbase:type/';

export interface StorySource { id: string; title: string; at: string; text: string }
/** Held sources: their facts are confirmed. */
export const SOURCES: StorySource[] = [
  {
    id: 'workshop-oct',
    title: 'Design workshop notes, 24 October 2026',
    at: '2026-10-24',
    text: [
      'Larkspur Lane Community Garden design workshop, 24 October 2026.',
      'The garden was founded on 7 May 2016 and has 6 raised beds along the south fence.',
      'The south terrace gets about 7 hours of sun a day in June.',
      'The north strip gets about 3 hours of sun a day in June.',
      'The only water tap is 28 metres from the south terrace.',
      'Imani coordinates the beds, Joaquin coordinates the water and Mei coordinates the volunteer rota.',
      '14 volunteers signed up to help with the rebuild.',
    ].join(' '),
  },
  {
    id: 'committee-nov',
    title: 'Committee minutes, 4 November 2026',
    at: '2026-11-04',
    text: [
      'Larkspur Lane Community Garden committee, 4 November 2026.',
      'The committee agreed to redesign the beds before planting begins on 10 April 2027.',
      'The budget for the redesign is 3,000 dollars.',
      'The plan is for 6 beds.',
      'Two layouts were put forward: six wide beds in two rows, and eight narrow beds along the fence.',
      'Which layout fits the budget was left open.',
      'Build day is 6 March 2027.',
      'Each raised bed uses four corner brackets that hold the timber sides together.',
      'The compost corner sits at the east end of the south terrace.',
    ].join(' '),
  },
];

/** The later meeting note: its facts arrive PENDING, to be compared against what is held. */
export const LATER_NOTE: StorySource = {
  id: 'volunteer-nov16',
  title: 'Volunteer meeting note, 16 November 2026',
  at: '2026-11-16',
  text: [
    'Volunteer meeting, 16 November 2026.',
    'The south terrace gets about 7 hours of sun a day in June, as measured at the workshop.',
    'The members voted to plan for 8 beds.',
    'The budget is now 2,400 dollars after the supplier quote.',
    'The tap is about 30 metres from the south terrace area.',
    'The path to the compost corner needs to be 1.2 metres wide for wheelbarrows.',
  ].join(' '),
};

// ── entities ───────────────────────────────────────────────────────────────────────────────────────

export interface Ent { id: string; type: string; label: string; comment?: string; parent?: string; preview?: string; date?: { p: 'scheduled-at' | 'due-at'; value: string } }
/** `preview` names a generated picture slot (see SLOTS); a hub or person gets a preview only once that picture exists. */
export const ENTITIES: Ent[] = [
  { id: 'garden', type: 'Place', label: 'Larkspur Lane Community Garden', preview: 'garden', comment: 'A neighbourhood garden with 6 raised beds, run by volunteers.' },
  { id: 'south-terrace', type: 'Place', label: 'South terrace', parent: 'garden', preview: 'south-terrace', comment: 'The sunny side, along the south fence, where the beds stand.' },
  { id: 'north-strip', type: 'Place', label: 'North strip', parent: 'garden', comment: 'A shaded strip with little sun.' },
  { id: 'compost-corner', type: 'Place', label: 'Compost corner', parent: 'south-terrace', preview: 'compost-corner', comment: 'The east end of the south terrace.' },
  { id: 'water-tap', type: 'Place', label: 'Water tap', parent: 'garden', comment: 'The only tap in the garden.' },
  { id: 'redesign', type: 'Concept', label: 'Bed redesign', parent: 'garden', comment: 'The plan to rebuild the beds before spring planting.' },
  { id: 'layout-wide', type: 'Concept', label: 'Layout A: six wide beds in two rows', parent: 'redesign' },
  { id: 'layout-narrow', type: 'Concept', label: 'Layout B: eight narrow beds along the fence', parent: 'redesign' },
  { id: 'corner-bracket', type: 'Model3D', label: 'Raised-bed corner bracket', parent: 'redesign', comment: 'Holds two timber sides together at a bed corner. Modelled from parameters, not scanned.' },
  { id: 'committee', type: 'Organization', label: 'Garden committee', parent: 'garden' },
  { id: 'imani', type: 'Person', label: 'Imani', parent: 'committee', preview: 'portrait-imani', comment: 'Coordinates the beds. An invented person; the portrait is an illustration.' },
  { id: 'joaquin', type: 'Person', label: 'Joaquin', parent: 'committee', preview: 'portrait-joaquin', comment: 'Coordinates the water. An invented person; the portrait is an illustration.' },
  { id: 'mei', type: 'Person', label: 'Mei', parent: 'committee', preview: 'portrait-mei', comment: 'Coordinates the volunteer rota. An invented person; the portrait is an illustration.' },
  { id: 'founding', type: 'Event', label: 'Garden founded', parent: 'garden', date: { p: 'scheduled-at', value: '2016-05-07' } },
  { id: 'workshop', type: 'CalendarEvent', label: 'Design workshop', parent: 'redesign', date: { p: 'scheduled-at', value: '2026-10-24' } },
  { id: 'committee-meeting', type: 'CalendarEvent', label: 'Committee meeting', parent: 'redesign', date: { p: 'scheduled-at', value: '2026-11-04' } },
  { id: 'volunteer-meeting', type: 'CalendarEvent', label: 'Volunteer meeting', parent: 'redesign', date: { p: 'scheduled-at', value: '2026-11-16' } },
  { id: 'build-day', type: 'Event', label: 'Build day', parent: 'redesign', date: { p: 'due-at', value: '2027-03-06' } },
  { id: 'planting', type: 'Event', label: 'Spring planting begins', parent: 'redesign', date: { p: 'due-at', value: '2027-04-10' } },
];

// ── held facts: each rests on one passage of one source, quoted exactly ─────────────────────────────────

export interface Fact { s: string; p: string; o: string | { ref: string }; source?: string; excerpt?: string }
const E = (ref: string) => ({ ref });
export const HELD: Fact[] = [
  { s: 'garden', p: 'raised-beds', o: '6 raised beds', source: 'workshop-oct', excerpt: 'has 6 raised beds along the south fence' },
  { s: 'south-terrace', p: 'sun-hours', o: 'about 7 hours a day in June', source: 'workshop-oct', excerpt: 'The south terrace gets about 7 hours of sun a day in June' },
  { s: 'north-strip', p: 'sun-hours', o: 'about 3 hours a day in June', source: 'workshop-oct', excerpt: 'The north strip gets about 3 hours of sun a day in June' },
  { s: 'south-terrace', p: 'tap-distance', o: '28 metres', source: 'workshop-oct', excerpt: 'The only water tap is 28 metres from the south terrace' },
  { s: 'water-tap', p: 'serves', o: E('garden'), source: 'workshop-oct', excerpt: 'The only water tap' },
  { s: 'imani', p: 'coordinates', o: E('redesign'), source: 'workshop-oct', excerpt: 'Imani coordinates the beds' },
  { s: 'joaquin', p: 'coordinates', o: E('water-tap'), source: 'workshop-oct', excerpt: 'Joaquin coordinates the water' },
  { s: 'mei', p: 'coordinates', o: 'the volunteer rota', source: 'workshop-oct', excerpt: 'Mei coordinates the volunteer rota' },
  { s: 'garden', p: 'volunteers', o: '14 volunteers', source: 'workshop-oct', excerpt: '14 volunteers signed up to help with the rebuild' },
  { s: 'redesign', p: 'budget', o: '3,000 dollars', source: 'committee-nov', excerpt: 'The budget for the redesign is 3,000 dollars' },
  { s: 'redesign', p: 'planned-beds', o: '6 beds', source: 'committee-nov', excerpt: 'The plan is for 6 beds' },
  { s: 'redesign', p: 'has-layout', o: E('layout-wide'), source: 'committee-nov', excerpt: 'six wide beds in two rows' },
  { s: 'redesign', p: 'has-layout', o: E('layout-narrow'), source: 'committee-nov', excerpt: 'eight narrow beds along the fence' },
  { s: 'redesign', p: 'deadline', o: E('planting'), source: 'committee-nov', excerpt: 'before planting begins on 10 April 2027' },
  { s: 'corner-bracket', p: 'used-in', o: E('redesign'), source: 'committee-nov', excerpt: 'Each raised bed uses four corner brackets' },
  { s: 'compost-corner', p: 'location', o: 'the east end of the south terrace', source: 'committee-nov', excerpt: 'The compost corner sits at the east end of the south terrace' },
];

/** The open question: a partial fact whose object is unknown, naming what it blocks. */
export interface Question { s: string; p: string; question: string; blocks: string[]; source: string; excerpt: string }
export const QUESTION: Question = {
  s: 'redesign', p: 'chosen-layout', question: 'Which layout fits the budget?', blocks: ['layout-wide', 'layout-narrow'],
  source: 'committee-nov', excerpt: 'Which layout fits the budget was left open',
};

/**
 * What the later note says about what is held. `expect` is the outcome the app's comparison should give it;
 * the unit test checks every one against computeDiff, so this table cannot drift from the real behaviour.
 */
export type Outcome = 'repeat' | 'near-duplicate' | 'contradiction' | 'new';
export interface LaterFact { s: string; p: string; o: string; excerpt: string; expect: Outcome }
export const LATER_FACTS: LaterFact[] = [
  { s: 'south-terrace', p: 'sun-hours', o: 'about 7 hours a day in June', excerpt: 'The south terrace gets about 7 hours of sun a day in June', expect: 'repeat' },
  { s: 'south-terrace-area', p: 'tap-distance', o: 'about 30 metres', excerpt: 'The tap is about 30 metres from the south terrace area', expect: 'near-duplicate' },
  { s: 'redesign', p: 'planned-beds', o: '8 beds', excerpt: 'The members voted to plan for 8 beds', expect: 'contradiction' },
  { s: 'redesign', p: 'budget', o: '2,400 dollars', excerpt: 'The budget is now 2,400 dollars after the supplier quote', expect: 'contradiction' },
  { s: 'compost-corner', p: 'path-width', o: '1.2 metres wide for wheelbarrows', excerpt: 'The path to the compost corner needs to be 1.2 metres wide for wheelbarrows', expect: 'new' },
];

/** The entity that only the later note names; it exists so its statement has a subject on the canvas. */
export const LATER_ENTITIES: Ent[] = [
  { id: 'south-terrace-area', type: 'Place', label: 'South terrace area', comment: 'Named in the 16 November note; probably the south terrace again.' },
];

// ── the reckonings: a situation chosen from the held facts, a target ─────────────────────────────────────

export interface ReckoningStory {
  id: string; note: string;
  /** [subject, predicate] pairs of held facts, plus the question when its subject and predicate are given. */
  situation: [string, string][];
  target: { question: boolean; assetType: string | null; note: string };
}
export const RECKONINGS: ReckoningStory[] = [
  {
    id: 'layout-for-budget', note: 'Which layout can this garden afford, given its sun, water and volunteers?',
    situation: [['redesign', 'budget'], ['south-terrace', 'sun-hours'], ['south-terrace', 'tap-distance'], ['garden', 'volunteers']],
    target: { question: true, assetType: null, note: '' },
  },
  {
    id: 'layout-picture', note: 'Show the six-bed layout on the south terrace.',
    situation: [['garden', 'raised-beds'], ['south-terrace', 'sun-hours'], ['compost-corner', 'location']],
    target: { question: false, assetType: 'urn:kbase:type/Image', note: 'A plan view of six wide raised beds in two rows on a sunny terrace beside a compost corner, flat illustration, labelled in plain shapes' },
  },
];

// ── the part to build: a corner bracket from numbers ─────────────────────────────────────────────────────

export const BRACKET_SPEC = {
  kind: 'bracket' as const, name: 'garden-corner-bracket',
  params: { width_mm: 70, height_mm: 90, depth_mm: 45, thickness_mm: 5, hole_diameter_mm: 6, hole_count: 3, fillet_mm: 8 },
};

// ── pictures to generate (each slot stays EMPTY until a local job has made it) ──────────────────────────

export interface Slot { id: string; kind: 'hub' | 'portrait'; seed: number; prompt: string; splat?: boolean }
export const SLOTS: Slot[] = [
  { id: 'garden', kind: 'hub', seed: 2901, splat: true, prompt: 'A small neighbourhood vegetable garden seen from a high corner on a clear autumn morning, six raised wooden beds in two rows on a sunny terrace along a fence, a gravel path, a water tap and a compost corner, soft natural light, photo' },
  { id: 'south-terrace', kind: 'hub', seed: 2902, prompt: 'A sunny paved terrace along a wooden fence in a community garden with raised timber vegetable beds, bright midday light, whole scene visible, photo' },
  { id: 'compost-corner', kind: 'hub', seed: 2903, prompt: 'A tidy compost corner at the end of a garden terrace with two wooden compost bins and a wheelbarrow on a wide gravel path, soft light, photo' },
  { id: 'portrait-imani', kind: 'portrait', seed: 2911, prompt: 'A neutral flat illustrated portrait of an imaginary person, a smiling gardener with short curly hair wearing a green work shirt, plain pale background, simple shapes, not a photograph, not a real person' },
  { id: 'portrait-joaquin', kind: 'portrait', seed: 2912, prompt: 'A neutral flat illustrated portrait of an imaginary person, a friendly gardener with a straw hat and a blue shirt, plain pale background, simple shapes, not a photograph, not a real person' },
  { id: 'portrait-mei', kind: 'portrait', seed: 2913, prompt: 'A neutral flat illustrated portrait of an imaginary person, a cheerful volunteer with a ponytail wearing a yellow jacket, plain pale background, simple shapes, not a photograph, not a real person' },
];

// ── the guided walk: one step per feature, each highlighting the entities it is about ───────────────────

export type Feature = 'intro' | 'reckoning' | 'compare' | 'cad' | 'hub-assets';
export interface WalkStep { feature: Feature; title: string; content: string; question?: string; layout?: string; highlights: string[] }
export const WALK: WalkStep[] = [
  {
    feature: 'intro', title: 'A garden that wants new beds', layout: 'hierarchy', highlights: ['garden', 'redesign', 'south-terrace'],
    content: 'Larkspur Lane is an invented neighbourhood garden with 6 raised beds. The committee wants to rebuild them before spring planting. Everything the volunteers know is gathered here, with the passage each fact came from.',
  },
  {
    feature: 'reckoning', title: 'Reckon: which layout fits the budget?', highlights: ['redesign', 'layout-wide', 'layout-narrow'],
    question: 'Which layout would you pick, knowing only the budget, the sun and the distance to the tap?',
    content: 'Two layouts are on the table and the committee left one question open: which fits the budget. Open the Reckoning page from the entity, choose the budget, sun, tap and volunteer statements as the situation, target the question, and generate a proposal. Accept an option yourself.',
  },
  {
    feature: 'compare', title: 'Compare: a later note disagrees', layout: 'timeline', highlights: ['volunteer-meeting', 'redesign', 'south-terrace', 'compost-corner'],
    question: 'Which of these changes would you take, and which would you keep as they were?',
    content: 'A volunteer note from 16 November is waiting as a pending source. Against what is held it repeats the sun hours, restates the tap distance in other words, contradicts the bed count and the budget, and adds one new fact about the compost path. Open it in Review and decide in place.',
  },
  {
    feature: 'cad', title: 'Build: the corner bracket', highlights: ['corner-bracket', 'redesign'],
    content: 'Each bed uses four corner brackets. This one was made from a part spec (width, height, depth, thickness, three holes) by the CAD pipeline, then rendered to a 3D model. It is labeled modelled from parameters: exact numbers, not a scan.',
  },
  {
    feature: 'hub-assets', title: 'Hubs and people get pictures', layout: 'hub', highlights: ['garden', 'south-terrace', 'compost-corner', 'imani', 'joaquin', 'mei'],
    question: 'Do these pictures say what the facts say, and nothing more?',
    content: 'The garden and its two main places have generated pictures, one has a splat, and each volunteer coordinator has an illustrated portrait of an invented person. They were queued as local jobs, not run inline; a picture only appears here once its job finished and its check passed.',
  },
];
