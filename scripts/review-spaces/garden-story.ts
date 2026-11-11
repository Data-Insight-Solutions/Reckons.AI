/**
 * THE STORY: Maple Row Community Garden (invented). A shared plot wants six more growing beds by spring
 * planting without flooding the footpath. This file is only the CONTENT, written to be read: the places,
 * the three sources and what they say, the facts and which passage each rests on, the two options of a
 * proposal in progress, the questions that block them, a note from a volunteer, the pictures to generate
 * and a first-draft script for a walk-through video.
 *
 * Everything here is made up: the garden, the city, the people, the numbers. No real place or person.
 * build-garden.ts validates it and writes it into a workspace space; it never invents content of its own.
 */

export const SLUG = 'review-community-garden';
export const TITLE = 'Maple Row Community Garden';
export const CONCEPT = 'urn:kbase:concept/';
export const PRED = 'urn:kbase:predicate/';
export const TYPE = 'urn:kbase:type/';

// ── the three sources, in full: the facts below quote these passages exactly ────────────────────────────

export interface StorySource { id: string; title: string; text: string }
export const SOURCES: StorySource[] = [
  {
    id: 'minutes-oct',
    title: "Minutes of the members' meeting, 14 October 2026",
    text: [
      "Maple Row Community Garden, members' meeting, 14 October 2026. Chair: Priya Nair. Present: 23 of the 31 plot holders.",
      'The garden was founded on 12 April 2014 on a former orchard lot leased from the city.',
      'The flood of 18 September left the footpath under ten centimetres of water for two days, and three plots lost their autumn crops.',
      'The treasurer, Tomas Reyes, reported that 4,800 dollars is set aside for new beds.',
      'The members agreed in principle to add six growing beds before spring planting, which begins on 20 March 2027.',
      'The picnic lawn on the north side is where the summer supper is held, and several members asked that it be kept.',
      'The water tap stands beside the tool shed on the west edge of the north lawn.',
      'The next meeting is on 18 November 2026.',
    ].join(' '),
  },
  {
    id: 'soil-test',
    title: 'Soil and drainage test, 2 October 2026',
    text: [
      'Soil and drainage test at Maple Row, 2 October 2026, by two volunteers with a hand auger.',
      'The whole plot measures about 42 by 30 metres, roughly 1,260 square metres.',
      'North lawn: loam, free draining, with soil at least 60 centimetres deep at all five test points.',
      'South slope: clay loam, falling about 1 in 8, and water ran off it toward the footpath during the test.',
      'On the south slope the soil was 35 and 40 centimetres deep at two points; the other three points hit stone before the auger could be sunk.',
      'Full sun reaches the north lawn for about 7 hours a day in June and the south slope for about 5 hours.',
    ].join(' '),
  },
  {
    id: 'city-leaflet',
    title: 'City of Fairmeadow leaflet 14, garden retaining walls',
    text: [
      'City of Fairmeadow, leaflet 14: retaining walls in community gardens.',
      'A wall up to 0.6 metres high needs no approval, and raised beds with timber sides up to 0.6 metres are not counted as walls.',
      'A wall over 0.6 metres may need a building permit and a drawing signed by an engineer; the permit desk decides case by case for city land.',
      'Surface water must not be sent onto a public footpath.',
      'Where a drain is built the leaseholder is responsible for it unless a written agreement names someone else.',
    ].join(' '),
  },
];

// ── entities ───────────────────────────────────────────────────────────────────────────────────────

export interface Ent { id: string; type: string; label: string; comment?: string; icon?: string; parent?: string; preview?: string }
/** `preview` names a generated picture slot (see SLOTS); a node gets a preview only once that picture exists. */
export const ENTITIES: Ent[] = [
  { id: 'garden', type: 'Place', label: 'Maple Row Community Garden', preview: 'overview', comment: 'A shared garden of 31 plots on a former orchard lot, leased from the city.' },
  { id: 'north-lawn', type: 'Place', label: 'North lawn', parent: 'garden', preview: 'north-lawn', comment: 'Level, free-draining and sunny. The summer supper is held here.' },
  { id: 'south-slope', type: 'Place', label: 'South slope', parent: 'garden', preview: 'south-slope', comment: 'A clay slope that sheds water toward the footpath.' },
  { id: 'footpath', type: 'Place', label: 'Footpath', parent: 'garden', preview: 'flooded-footpath', comment: 'The public path along the bottom of the slope.' },
  { id: 'tool-shed', type: 'Place', label: 'Tool shed', parent: 'garden' },
  { id: 'water-tap', type: 'Place', label: 'Water tap', parent: 'garden' },
  { id: 'association', type: 'Organization', label: 'Maple Row Garden Association', comment: 'The plot holders, who lease the garden from the city.' },
  { id: 'priya', type: 'Person', label: 'Priya Nair', comment: 'Chair of the association.' },
  { id: 'tomas', type: 'Person', label: 'Tomas Reyes', comment: 'Treasurer.' },
  { id: 'wen', type: 'Person', label: 'Wen', comment: 'A volunteer who walks the garden most mornings.' },
  { id: 'founding', type: 'Event', label: 'Garden founded' },
  { id: 'flood', type: 'Event', label: "Last season's flood", comment: 'Ten centimetres of water on the footpath for two days; three plots lost autumn crops.' },
  { id: 'soil-test-day', type: 'Event', label: 'Soil and drainage test' },
  { id: 'meeting-oct', type: 'CalendarEvent', label: "Members' meeting" },
  { id: 'meeting-nov', type: 'CalendarEvent', label: 'Next members\' meeting' },
  { id: 'deadline', type: 'Event', label: 'Spring planting begins', comment: 'The six new beds need to be ready by this day.' },
  { id: 'six-beds', type: 'Concept', label: 'Six more growing beds', comment: 'Agreed in principle at the October meeting.' },
  { id: 'picnic-lawn', type: 'Concept', label: 'Picnic lawn', comment: 'The open part of the north lawn, used for the summer supper.' },
  { id: 'drain', type: 'Concept', label: 'Drain along the slope', comment: 'Needed if the slope is built on; nobody has been named to look after it.' },
  { id: 'city-rule', type: 'Document', label: 'City leaflet 14: retaining walls' },
  { id: 'capture-north', type: 'Video', label: 'Phone capture: north lawn', preview: 'north-lawn', comment: 'A slow walk along the lawn, filmed on a phone.' },
  { id: 'capture-south', type: 'Video', label: 'Phone capture: south slope', preview: 'south-slope', comment: 'Filmed from the footpath, looking up the slope.' },
];

// ── confirmed facts: each rests on one passage of one source, quoted exactly ───────────────────────────

export interface Fact { s: string; p: string; o: string | { ref: string }; source?: string; excerpt?: string }
const E = (ref: string) => ({ ref });
export const CONFIRMED: Fact[] = [
  { s: 'garden', p: 'plot-holders', o: '31 plot holders', source: 'minutes-oct', excerpt: '23 of the 31 plot holders' },
  { s: 'garden', p: 'size', o: 'about 1,260 square metres (42 by 30 metres)', source: 'soil-test', excerpt: 'roughly 1,260 square metres' },
  { s: 'garden', p: 'budget-for-beds', o: '4,800 dollars', source: 'minutes-oct', excerpt: '4,800 dollars is set aside for new beds' },
  { s: 'garden', p: 'leased-from', o: 'the city of Fairmeadow', source: 'minutes-oct', excerpt: 'leased from the city' },
  { s: 'garden', p: 'has-event', o: E('founding') }, { s: 'garden', p: 'has-event', o: E('flood') },
  { s: 'garden', p: 'has-event', o: E('deadline') },
  { s: 'association', p: 'looks-after', o: E('garden') },
  { s: 'priya', p: 'chairs', o: E('association'), source: 'minutes-oct', excerpt: 'Chair: Priya Nair' },
  { s: 'tomas', p: 'is-treasurer-of', o: E('association'), source: 'minutes-oct', excerpt: 'The treasurer, Tomas Reyes' },
  { s: 'water-tap', p: 'stands-beside', o: E('tool-shed'), source: 'minutes-oct', excerpt: 'The water tap stands beside the tool shed' },
  { s: 'tool-shed', p: 'stands-on', o: E('north-lawn'), source: 'minutes-oct', excerpt: 'on the west edge of the north lawn' },
  { s: 'north-lawn', p: 'soil', o: 'loam, free draining, at least 60 cm deep', source: 'soil-test', excerpt: 'loam, free draining, with soil at least 60 centimetres deep' },
  { s: 'north-lawn', p: 'sun-hours', o: 'about 7 hours a day in June', source: 'soil-test', excerpt: 'north lawn for about 7 hours a day in June' },
  { s: 'north-lawn', p: 'holds', o: E('picnic-lawn'), source: 'minutes-oct', excerpt: 'The picnic lawn on the north side' },
  { s: 'picnic-lawn', p: 'used-for', o: 'the summer supper', source: 'minutes-oct', excerpt: 'where the summer supper is held' },
  { s: 'south-slope', p: 'slope', o: 'about 1 in 8', source: 'soil-test', excerpt: 'falling about 1 in 8' },
  { s: 'south-slope', p: 'soil', o: 'clay loam; water runs off toward the footpath', source: 'soil-test', excerpt: 'water ran off it toward the footpath' },
  { s: 'south-slope', p: 'sun-hours', o: 'about 5 hours a day in June', source: 'soil-test', excerpt: 'the south slope for about 5 hours' },
  { s: 'south-slope', p: 'drains-toward', o: E('footpath'), source: 'soil-test', excerpt: 'toward the footpath' },
  { s: 'flood', p: 'flooded', o: E('footpath'), source: 'minutes-oct', excerpt: 'left the footpath under ten centimetres of water for two days' },
  { s: 'six-beds', p: 'agreed-at', o: E('meeting-oct'), source: 'minutes-oct', excerpt: 'agreed in principle to add six growing beds' },
  { s: 'city-rule', p: 'says', o: 'a wall up to 0.6 metres needs no approval; timber-sided raised beds up to 0.6 metres are not walls', source: 'city-leaflet', excerpt: 'raised beds with timber sides up to 0.6 metres are not counted as walls' },
  { s: 'city-rule', p: 'says', o: 'surface water must not be sent onto a public footpath', source: 'city-leaflet', excerpt: 'Surface water must not be sent onto a public footpath' },
  { s: 'drain', p: 'is-looked-after-by-default', o: 'the leaseholder, unless a written agreement names someone else', source: 'city-leaflet', excerpt: 'the leaseholder is responsible for it unless a written agreement names someone else' },
];

/** Dates (predicates the time layout reads) on the events. */
export const DATES: { s: string; p: 'scheduled-at' | 'due-at'; value: string; source?: string; excerpt?: string }[] = [
  { s: 'founding', p: 'scheduled-at', value: '2014-04-12', source: 'minutes-oct', excerpt: 'founded on 12 April 2014' },
  { s: 'flood', p: 'scheduled-at', value: '2026-09-18', source: 'minutes-oct', excerpt: 'The flood of 18 September' },
  { s: 'soil-test-day', p: 'scheduled-at', value: '2026-10-02', source: 'soil-test', excerpt: '2 October 2026' },
  { s: 'meeting-oct', p: 'scheduled-at', value: '2026-10-14', source: 'minutes-oct', excerpt: '14 October 2026' },
  { s: 'meeting-nov', p: 'scheduled-at', value: '2026-11-18', source: 'minutes-oct', excerpt: 'The next meeting is on 18 November 2026' },
  { s: 'deadline', p: 'due-at', value: '2027-03-20', source: 'minutes-oct', excerpt: 'which begins on 20 March 2027' },
];

// ── a reckoning in progress: the target and two options, each with pending facts and what it rests on ──

export interface Option {
  id: string; entity: string; label: string; comment: string; recommended?: boolean;
  /** Pending facts of the option, each carrying the option in proposalOption. */
  facts: { p: string; o: string | { ref: string } }[];
  /** The confirmed facts this option rests on: [subject, predicate] pairs that must exist in CONFIRMED. */
  rests: [string, string][];
}
export const PROPOSAL = {
  entity: 'beds-proposal',
  label: 'Six more beds without flooding the footpath',
  target: { entity: 'six-dry-beds', label: 'Six beds in place by 20 March 2027, footpath kept dry', comment: 'The state the garden wants to reach: six new growing beds ready for spring planting, and no more water reaching the footpath than before.' },
};
export const OPTIONS: Option[] = [
  {
    id: 'cedar-beds-north-lawn', entity: 'opt-cedar', label: 'Raised cedar beds on the north lawn', recommended: true,
    comment: 'Cheaper and quicker: two weekends of work on level, well-drained ground. It uses the picnic lawn, so the summer supper would need a new home.',
    facts: [
      { p: 'would-build-on', o: { ref: 'north-lawn' } },
      { p: 'estimated-cost', o: 'about 3,200 dollars' },
      { p: 'estimated-work', o: 'two weekends of volunteer work' },
      { p: 'would-remove', o: { ref: 'picnic-lawn' } },
    ],
    rests: [['north-lawn', 'soil'], ['north-lawn', 'sun-hours'], ['garden', 'budget-for-beds'], ['city-rule', 'says']],
  },
  {
    id: 'timber-terraces-south-slope', entity: 'opt-terraces', label: 'Timber terraces on the south slope',
    comment: 'Dearer, and it needs a drain behind the terraces, but it keeps the picnic lawn and uses ground that is wasted today.',
    facts: [
      { p: 'would-build-on', o: { ref: 'south-slope' } },
      { p: 'estimated-cost', o: 'about 5,600 dollars, more than the 4,800 set aside' },
      { p: 'needs', o: { ref: 'drain' } },
      { p: 'would-keep', o: { ref: 'picnic-lawn' } },
    ],
    rests: [['south-slope', 'slope'], ['south-slope', 'soil'], ['south-slope', 'drains-toward'], ['garden', 'budget-for-beds'], ['flood', 'flooded']],
  },
];

// ── questions that genuinely block an option (partial facts: the object is open) ──────────────────────

export interface Question { s: string; p: string; question: string; blocks: string[] /* entity ids */; source?: string; excerpt?: string }
export const QUESTIONS: Question[] = [
  { s: 'south-slope', p: 'soil-depth', question: 'How deep is the soil on the south slope?', blocks: ['opt-terraces', 'south-slope'], source: 'soil-test', excerpt: 'the other three points hit stone' },
  { s: 'city-rule', p: 'permit-needed-over', question: 'Does the city need a permit for a wall over 0.6 metres on this lot?', blocks: ['opt-terraces'], source: 'city-leaflet', excerpt: 'may need a building permit' },
  { s: 'drain', p: 'maintained-by', question: 'Who maintains the drain?', blocks: ['opt-terraces', 'drain'], source: 'city-leaflet', excerpt: 'unless a written agreement names someone else' },
];

// ── a volunteer's note, just ingested: pending, belongs to no option ─────────────────────────────────

export const VOLUNTEER_NOTE = {
  id: 'wen-note', title: "Wen's note, 3 November 2026",
  text: 'Walked the garden at seven. Water was standing at the bottom of the south slope again after last night\'s rain, and the tap by the shed is dripping. I think the old drain pipe runs under the slope. Two members asked whether the supper could move to the shed side of the lawn.',
  facts: [
    { s: 'south-slope', p: 'water-standing-after-rain', o: 'at the bottom of the slope, seen 3 November', excerpt: 'Water was standing at the bottom of the south slope again' },
    { s: 'water-tap', p: 'condition', o: 'dripping', excerpt: 'the tap by the shed is dripping' },
    { s: 'drain', p: 'may-run-under', o: { ref: 'south-slope' }, excerpt: 'the old drain pipe runs under the slope' },
    { s: 'wen', p: 'walked', o: { ref: 'garden' }, excerpt: 'Walked the garden at seven' },
  ] as { s: string; p: string; o: string | { ref: string }; excerpt?: string }[],
};

// ── pictures to generate (the slots stay EMPTY until a local job has made them) ────────────────────

export interface Slot { id: string; prompt: string; seed: number; splat?: { forCapture?: string; label: string } }
export const SLOTS: Slot[] = [
  { id: 'overview', seed: 11, prompt: 'A small community vegetable garden seen from a high corner on a clear autumn morning, a green lawn on the left with a few raised wooden beds, a grassy slope on the right, a gravel footpath along the bottom, a small wooden tool shed and a water tap, soft natural light, photo' },
  { id: 'north-lawn', seed: 12, splat: { forCapture: 'capture-north', label: 'Scan of the north lawn' }, prompt: 'A level green lawn in a community garden with a wooden picnic table, a small tool shed at its left edge, a garden hose tap beside the shed, bright morning sun, whole scene visible, photo' },
  { id: 'south-slope', seed: 13, splat: { forCapture: 'capture-south', label: 'Scan of the south slope' }, prompt: 'A grassy clay slope in a community garden falling toward a gravel footpath, wet patches in the grass at the bottom, a few stones showing, overcast light, whole slope visible, photo' },
  { id: 'flooded-footpath', seed: 14, splat: { label: 'Scan of a footpath, no capture named' }, prompt: 'A gravel footpath along the bottom of a garden slope covered by a shallow sheet of rainwater, reflections of the sky on the water, grass banks either side, overcast light, photo' },
];

// ── a first-draft walk-through for a tutorial or marketing video (NOT approved; no audio, nothing rendered) ──
// Matt, 2026-11-11: "We need to prepare a space for key features, and then be able to make a tutorial video
// or marketing video content for docs pages like the asset generation video."
// Every narration line is a DRAFT awaiting Matt's approval. The F275 render pipeline is not on dev yet
// (open PR #592), so this is the step list in plain data, ready to move into a TestWorkflow when it lands.

export interface WalkStep { n: number; show: string; seen: string; narration: string }
export const WALK_STATUS = 'DRAFT: narration awaiting Matt\'s approval; no audio synthesized, nothing rendered';
export const WALK: WalkStep[] = [
  { n: 1, show: 'Open the Maple Row Community Garden space.', seen: 'The garden appears with its pictures, areas and dated events.', narration: 'This is a community garden. The members want six more growing beds by spring, and everything they know about the garden is gathered here.' },
  { n: 2, show: 'A scan arrives and is linked to the phone capture it came from.', seen: 'A scan of the north lawn appears with a line to the north lawn capture.', narration: 'Someone filmed the north lawn on a phone. The scan made from it arrives already joined to the video it came from, so nothing is left floating.' },
  { n: 3, show: 'The scan that arrived with no link.', seen: 'A scan of the footpath sits next to a hollow question mark.', narration: 'This scan came in with no note about where it was taken. The garden does not guess. It asks: which capture is this a scan of?' },
  { n: 4, show: 'Open the plan the members are weighing.', seen: 'Two dashed groups of ideas appear on top of the solid, confirmed facts.', narration: 'The members are weighing two plans. They sit on top of what is already known, drawn with dashed lines so nobody mistakes a plan for a fact.' },
  { n: 5, show: 'Turn on the Proposed filter, then show the first plan, then the second.', seen: 'Only the dashed lines stay bright; switching plans lights one group and then the other without moving anything.', narration: 'Show only the plans, and then one at a time. Cedar beds on the lawn are cheaper and quick, but cost the picnic lawn. Terraces on the slope keep the lawn, but cost more.' },
  { n: 6, show: 'Turn on the Questions filter.', seen: 'Three hollow gaps light up, each joined to the plan it holds up.', narration: 'Some things are not known yet, and each gap says what it is holding up. How deep is the soil on the slope? Does the city want a permit? Who looks after the drain?' },
  { n: 7, show: 'Switch to the tree layout.', seen: 'The garden spreads into its areas: lawn, slope, path, shed and tap.', narration: 'Arranged as a tree, the garden shows how it is built: the lawn, the slope, the footpath, the shed and the tap all belong to one place.' },
  { n: 8, show: 'Switch to the time layout.', seen: 'Events line up along a date line: founded, the flood, the test, the meetings, the spring deadline.', narration: 'Arranged by date, the story reads left to right, from the day the garden began, through the flood, to the spring day the beds must be ready.' },
];
