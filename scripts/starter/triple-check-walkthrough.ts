/**
 * The Triple Check walkthrough space (F100.1): a fictional home battery described by four documents,
 * two already accepted and two waiting for review, plus a guided story that walks a first-time reader
 * through turning Triple Check on and reading what it finds.
 *
 * Replaced the bare "research validation" starter on 2026-10-27. Matt opened that one and could not
 * tell what to do with it: eight statements about "aster-v1" and no story, so the reader got numbers
 * that disagreed and no reason to care. Every disagreement here teaches one thing the evidence panel
 * shows — a real conflict, agreement that is not proof, two values that are both right, and silence
 * that is not confirmation — and the story names each one.
 *
 * A SECOND SPACE comes with it (2026-10-27): Triple Check proposes only what it finds OUTSIDE the space —
 * Review already compares documents within one — so a walkthrough in one space would show it finding
 * nothing. The owners' forum is that outside: example-space.ts opens it alongside, and what Triple Check
 * finds there arrives in Review as the forum's own pending statements.
 *
 * Synthetic and generic on purpose: no real product, no real lab. Built by scripts/starter/build-research.ts.
 */
import type { Source, Statement, Term } from '../../src/lib/rdf/types.js';

const EX = 'urn:example:battery/', P = 'urn:example:predicate/', STORY = 'urn:reckons:story/', TOUR = 'urn:example:tour/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label', RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';

const iri = (value: string): Term => ({ kind: 'iri', value });
const lit = (value: string, datatype?: string): Term => ({ kind: 'literal', value, ...(datatype ? { datatype } : {}) });

type Row = [subject: string, predicate: string, object: Term];
type Doc = { id: string; title: string; status: Statement['status']; rows: Row[] };

const DOCS: Doc[] = [
  { id: 'datasheet', title: "Harbor 10 datasheet (manufacturer's, synthetic)", status: 'confirmed', rows: [
    [`${EX}harbor-10`, `${P}usable-capacity`, lit('9.5 kWh')],
    [`${EX}harbor-10`, `${P}warranty`, lit('10 years')],
    [`${EX}harbor-10`, `${P}cycle-life`, lit('4,000 cycles to 70% capacity')],
    [`${EX}harbor-10`, `${P}compatible-inverter`, iri(`${EX}harbor-inverter-s`)],
  ] },
  { id: 'bench-test', title: 'Independent bench test (synthetic)', status: 'confirmed', rows: [
    [`${EX}harbor-10`, `${P}usable-capacity`, lit('9.1 kWh')],
    [`${EX}harbor-10`, `${P}round-trip-efficiency`, lit('90%')],
  ] },
  { id: 'brochure', title: 'Sales brochure (synthetic)', status: 'pending', rows: [
    [`${EX}harbor-10`, `${P}usable-capacity`, lit('10 kWh')],
    [`${EX}harbor-10`, `${P}warranty`, lit('15 years')],
    [`${EX}harbor-10`, `${P}round-trip-efficiency`, lit('90%')],
  ] },
  { id: 'installer', title: "Installer's notes (synthetic)", status: 'pending', rows: [
    [`${EX}harbor-10`, `${P}compatible-inverter`, iri(`${EX}model-t-inverter`)],
    [`${EX}harbor-10`, `${P}weight`, lit('95 kg')],
  ] },
];

const STEPS: { title: string; content: string; highlight?: string; offers?: string[]; page?: string }[] = [
  { title: 'What is in this space', highlight: `${EX}harbor-10`,
    content: 'This space collects what four documents say about the Harbor 10, a fictional home battery. You already accepted two of them: the datasheet and an independent bench test. The other two, a sales brochure and an installer\'s notes, are new and waiting in Review.' },
  { title: 'A second space came with it',
    content: 'Opening this walkthrough also added a space called "Harbor 10 owners\' forum", with what owners report about the same battery. Review already compares the documents inside this space. Triple Check looks outside it: your other spaces and, if you allow it, the web.' },
  { title: 'Turn on Triple Check', offers: ['tripleCheckEnabled=true', 'tripleCheckWebEnabled=false'],
    content: 'Press the two buttons below: one turns Triple Check on for this space, the other keeps it off the internet for now. This walkthrough only compares the spaces on this device, so nothing leaves your computer and you need no account or key. The same choices are in Settings, under Triple Check.' },
  { title: 'Give it a few minutes',
    content: 'Triple Check looks at one statement about once a minute while the app is open, starting with the ones waiting for review. Allow about ten minutes for this space. You can keep working meanwhile.' },
  { title: 'What it found is in Review', highlight: `${EX}harbor-10`, page: '/review?group=source',
    content: 'Open Review, grouped by source, with the button below. A new source appears: "Harbor 10 owners\' forum (another space)". Its statements are ordinary pending statements, so you review them the way you review anything else. Triple Check never accepts anything for you.' },
  { title: 'Agreement becomes a second source',
    content: 'The forum also reports 90% round-trip efficiency, like the bench test and the brochure. Accepting it adds the forum as one more source for the same statement. Agreement is support, not proof: if the forum copied the bench test, it is still one measurement said twice.' },
  { title: 'Disagreement becomes its own statement',
    content: 'Owners measured 9.2 kWh of usable capacity. That arrives as its own statement beside the brochure\'s 10 kWh, the datasheet\'s 9.5 and the bench test\'s 9.1. You can keep one, several or none; the others stay on record with their sources.' },
  { title: 'A conflict you should act on',
    content: 'The forum says the warranty is 10 years, agreeing with the datasheet against the brochure\'s 15. A warranty is a written promise, so one of the documents is wrong or out of date. This is the disagreement worth chasing before you rely on the claim.' },
  { title: 'Two different answers can both be right', highlight: `${EX}model-t-inverter`,
    content: 'The forum and the installer both list the Model T inverter as compatible; the datasheet lists Harbor\'s own inverter. A battery can work with more than one inverter, so both can be true. Review shows them side by side because the answers differ. Whether they conflict is your call.' },
  { title: 'No new source is not a confirmation',
    content: 'Nothing outside this space mentions the installer\'s 95 kg weight, so Triple Check adds nothing for it. That means nobody else said anything, not that anybody checked.' },
  { title: 'Accept a whole source at once', page: '/review?group=source',
    content: 'In Review, each source has an accept button that states how many statements it will accept. Statements that disagree with something are held back and listed first, so they get a decision of their own. Here that accepts the efficiency and holds the capacity, the warranty and the inverter for you.' },
  { title: 'Checking the internet too',
    content: 'With a search service and an evidence model chosen in Settings, a web page becomes a source the same way. A page that disputes a statement without saying what is true instead arrives as a question for you to answer. Each web check sends that one statement to the services you chose, and paid services may charge. Leave it off for anything private.' },
];

const LABELS: Row[] = [
  [`${EX}harbor-10`, RDFS_LABEL, lit('Harbor 10 home battery (fictional)')],
  [`${EX}harbor-inverter-s`, RDFS_LABEL, lit('Harbor S inverter (fictional)')],
  [`${EX}model-t-inverter`, RDFS_LABEL, lit('Model T inverter (fictional)')],
];

function storyRows(): Row[] {
  const tour = `${TOUR}triple-check`;
  const rows: Row[] = [
    [tour, RDF_TYPE, iri(`${STORY}Story`)],
    [tour, RDFS_LABEL, lit('Triple Check: a guided walkthrough')],
    [tour, `${STORY}description`, lit('Turn on Triple Check and review what it brings from outside this space: a second source, a disagreeing statement, two right answers, and silence.')],
    [tour, `${STORY}autoplay`, lit('false')],
  ];
  STEPS.forEach((step, i) => {
    const s = `${tour}/step-${i + 1}`;
    rows.push([s, RDF_TYPE, iri(`${STORY}Step`)], [s, `${STORY}partOf`, iri(tour)], [s, `${STORY}order`, lit(String(i + 1), XSD_INT)],
      [s, `${STORY}title`, lit(step.title)], [s, `${STORY}content`, lit(step.content)]);
    if (step.highlight) rows.push([s, `${STORY}highlight`, iri(step.highlight)]);
    // One-click offers (F261): a setting the reader can apply, a page they can open.
    for (const offer of step.offers ?? []) rows.push([s, `${STORY}offerSetting`, lit(offer)]);
    if (step.page) rows.push([s, `${STORY}openPage`, lit(step.page)]);
  });
  return rows;
}

const GUIDE: Doc = { id: 'guide', title: 'Walkthrough guide', status: 'confirmed', rows: [...LABELS, ...storyRows()] };

const rows = (d: Doc) => d.rows.map(([s, p, o], i): Statement => ({
  id: `walkthrough-${d.id}-${i}`, s: iri(s), p: iri(p), o, g: iri(`urn:kbase:source/${d.id}`), sourceId: d.id,
  status: d.status, confidence: 1, createdAt: 1, updatedAt: 1,
}));
const source = (d: Doc): Source => ({ id: d.id, title: d.title, uri: `note://triple-check-walkthrough/${d.id}`, kind: 'document', trustLevel: 'review', ingestedAt: 1 });

export function walkthroughStatements(): Statement[] { return [...DOCS, GUIDE].flatMap(rows); }
export function walkthroughSources(): Source[] { return [...DOCS, GUIDE].map(source); }

/** The owners' forum: the space Triple Check compares the walkthrough against. Confirmed in its own space. */
const FORUM: Doc = { id: 'forum', title: "Harbor 10 owners' forum (synthetic)", status: 'confirmed', rows: [
  [`${EX}harbor-10`, `${P}usable-capacity`, lit('9.2 kWh')],
  [`${EX}harbor-10`, `${P}warranty`, lit('10 years')],
  [`${EX}harbor-10`, `${P}round-trip-efficiency`, lit('90%')],
  [`${EX}harbor-10`, `${P}compatible-inverter`, iri(`${EX}model-t-inverter`)],
] };

export function forumStatements(): Statement[] { return rows(FORUM); }
export function forumSources(): Source[] { return [source(FORUM)]; }
