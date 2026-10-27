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

const STEPS: { title: string; content: string; highlight?: string }[] = [
  { title: 'What is in this space', highlight: `${EX}harbor-10`,
    content: 'This space collects what four documents say about the Harbor 10, a fictional home battery. You already accepted two of them: the datasheet and an independent bench test. The other two, a sales brochure and an installer\'s notes, are new and waiting in Review.' },
  { title: 'Turn on Triple Check',
    content: 'Open Settings, then Triple Check, and tick "Keep Triple Check on for this space". Untick "Check the internet" for now. This walkthrough only compares the spaces on this device, so nothing leaves your computer and you need no account or key.' },
  { title: 'Give it a few minutes',
    content: 'Triple Check looks at one statement about once a minute while the app is open, starting with the ones waiting for review. There are five new statements here, so allow about five minutes. You can keep working meanwhile.' },
  { title: 'Find the flags', highlight: `${EX}harbor-10`,
    content: 'Open Review. A statement that disagrees with something you already have is marked "Possible conflict". The brochure says the usable capacity is 10 kWh; the datasheet says 9.5 and the bench test measured 9.1. Open "Triple Check evidence" under the statement to see who said what.' },
  { title: 'A conflict you should act on',
    content: 'The brochure promises a 15-year warranty; the datasheet says 10 years. A warranty is a written promise, so one of the two documents is wrong or out of date. This is the kind of disagreement worth chasing before you rely on the claim.' },
  { title: 'Agreement is support, not proof',
    content: 'The brochure\'s 90% efficiency matches the bench test. Agreement from a different source is support. But if the brochure simply copied the test result, it is still one measurement said twice. The evidence shows where each claim came from so you can judge.' },
  { title: 'Two different answers can both be right', highlight: `${EX}model-t-inverter`,
    content: 'The installer lists the Model T inverter as compatible; the datasheet lists Harbor\'s own inverter. A battery can work with more than one inverter, so both can be true. Triple Check flags it because the answers differ. Whether they conflict is your call.' },
  { title: 'No flag is not a confirmation',
    content: 'The installer\'s 95 kg weight matches nothing else here, so it has no flag. That means nobody disagreed, not that anybody checked.' },
  { title: 'You decide',
    content: 'Accept, refine or reject each new statement as usual. Triple Check never accepts or changes anything for you. You could refine the brochure\'s capacity to "10 kWh, as advertised" to keep the claim together with where it came from.' },
  { title: 'Checking the internet too',
    content: 'To compare claims with web pages as well, choose a search service in Settings, Triple Check, and add its key under Integrations. Each web check sends that one statement to the search service and the model you choose, and paid services may charge. Leave it off for anything private.' },
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
    [tour, `${STORY}description`, lit('Turn on Triple Check and learn to read what it finds: a real conflict, agreement that is not proof, two right answers, and silence.')],
    [tour, `${STORY}autoplay`, lit('false')],
  ];
  STEPS.forEach((step, i) => {
    const s = `${tour}/step-${i + 1}`;
    rows.push([s, RDF_TYPE, iri(`${STORY}Step`)], [s, `${STORY}partOf`, iri(tour)], [s, `${STORY}order`, lit(String(i + 1), XSD_INT)],
      [s, `${STORY}title`, lit(step.title)], [s, `${STORY}content`, lit(step.content)]);
    if (step.highlight) rows.push([s, `${STORY}highlight`, iri(step.highlight)]);
  });
  return rows;
}

const GUIDE: Doc = { id: 'guide', title: 'Walkthrough guide', status: 'confirmed', rows: [...LABELS, ...storyRows()] };

export function walkthroughStatements(): Statement[] {
  return [...DOCS, GUIDE].flatMap((d) => d.rows.map(([s, p, o], i): Statement => ({
    id: `walkthrough-${d.id}-${i}`, s: iri(s), p: iri(p), o, g: iri(`urn:kbase:source/${d.id}`), sourceId: d.id,
    status: d.status, confidence: 1, createdAt: 1, updatedAt: 1,
  })));
}

export function walkthroughSources(): Source[] {
  return [...DOCS, GUIDE].map((d) => ({ id: d.id, title: d.title, uri: `note://triple-check-walkthrough/${d.id}`, kind: 'document', trustLevel: 'review', ingestedAt: 1 }));
}
