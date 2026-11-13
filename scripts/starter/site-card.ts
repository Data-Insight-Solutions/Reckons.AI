/**
 * The business card, its design versions and its print sheets, as entities of the Data Insight Solutions
 * example (F294.8, kb:derived-output-regenerates). Read from the site's PUBLIC brand record
 * (assets/brand/business-card.json), never from any private file.
 *
 * What the space shows: the design (owned by the company, showing the person), its two sides as image nodes,
 * the design versions as a chain, one node per print sheet each DERIVED-FROM the design version it was made from
 * and SUPERSEDED-BY the next sheet, and the rule that a sheet is rebuilt when its design changes. The sheets
 * themselves are private PDFs (they carry the full contact line): only that they exist and what they were
 * made from is recorded. Nothing is invented: a record the JSON lacks produces no node.
 */
import { iri, lit, type Statement, type Term } from '../../src/lib/rdf/types.js';

const KB = 'urn:kbase:concept/';
const TYPE = 'urn:kbase:type/';
const KP = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

export const CARD_MEDIA = { front: '/media/dis-business-card-front.webp', back: '/media/dis-business-card-back.webp' };

export interface CardRecord {
  design: { name: string; owner: string; person: string; size: string; tool: string; brand: { colours: string[]; fonts: string[]; logo: string }; publicCopy: string };
  designVersions: { id: string; date: string; summary: string }[];
  printSheetSpec: { paper: string; layout: string; bleed: string; marks: string; duplex: string; note: string; script: string };
  printSheets: { id: string; madeFrom: string; what: string; why: string }[];
  sheetsPrivate: string;
  process: string[];
}

/** A phone-shaped run of digits anywhere in the record is refused: the public card omits the number by the owner's choice. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const PHONE_LIKE = /\(\d{3}\)\s*\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{10,}\b|\+\d[\d\s().-]{8,}\d/;

/** Parses and checks the public brand record; throws with the reason when it is unusable or carries a phone number. */
export function parseCardRecord(text: string): CardRecord {
  if (PHONE_LIKE.test(text.replace(ISO_DATE, ''))) throw new Error('the business card record contains a phone-number-like string; the public copy must not');
  let j: CardRecord;
  try { j = JSON.parse(text) as CardRecord; } catch { throw new Error('the business card record is not JSON'); }
  const ids = new Set(j.designVersions?.map((v) => v.id));
  if (!j.design?.name || !Array.isArray(j.designVersions) || !Array.isArray(j.printSheets)) throw new Error('the business card record lacks design, designVersions or printSheets');
  for (const s of j.printSheets) if (!ids.has(s.madeFrom)) throw new Error('print sheet ' + s.id + ' is made from an unknown design version: ' + s.madeFrom);
  return j;
}

type Add = (s: string, p: string, o: Term, extra?: Partial<Statement>) => void;
export interface CardSummary { designIri: string; images: string[]; versions: number; sheets: number; ruleIri: string; sheetIris: string[]; versionIris: string[]; changedWhy: string }

export function addCard(add: Add, c: CardRecord, ctx: { orgIri: string; siteIri: string; personIri?: string }): CardSummary {
  const typed = (node: string, type: string, label: string, comment?: string): void => {
    add(node, RDF_TYPE, iri(TYPE + type));
    add(node, RDFS_LABEL, lit(label));
    if (comment) add(node, RDFS_COMMENT, lit(comment));
  };
  const designIri = KB + 'dis-business-card';
  typed(designIri, 'Design', c.design.name, 'A two-sided business card made in ' + c.design.tool + ' from the website\'s own colours, fonts and logo. ' + c.design.publicCopy);
  add(designIri, KP + 'owned-by', iri(ctx.orgIri));
  if (ctx.personIri) add(designIri, KP + 'shows', iri(ctx.personIri));
  add(designIri, KP + 'part-of', iri(ctx.siteIri));
  add(designIri, KP + 'size', lit(c.design.size));
  add(designIri, KP + 'made-with', lit(c.design.tool));
  for (const col of c.design.brand.colours) add(designIri, KP + 'uses-colour', lit(col));
  for (const f of c.design.brand.fonts) add(designIri, KP + 'uses-font', lit(f));
  add(designIri, KP + 'uses-logo', lit(c.design.brand.logo));
  c.process.forEach((p, k) => add(designIri, KP + 'process-step', lit((k + 1) + '. ' + p)));

  const sides: [string, string, string][] = [
    ['front', CARD_MEDIA.front, 'Business card, front: the name, both roles, and the website\'s node-graph mark ending the rule.'],
    ['back', CARD_MEDIA.back, 'Business card, back, as shown publicly: email, website and a LinkedIn QR code. The phone number is left out of this copy by the owner\'s choice.'],
  ];
  const images: string[] = [];
  for (const [side, path, text] of sides) {
    const img = KB + 'dis-business-card-' + side;
    typed(img, 'Image', 'Business card, ' + side, text);
    add(img, KP + 'icon2d', lit(path));
    add(img, KP + 'side', lit(side));
    add(img, KP + 'part-of', iri(designIri));
    add(designIri, KP + 'has-side', iri(img));
    images.push(img);
  }

  const vIri = (id: string): string => KB + 'dis-business-card-design-' + id;
  const sIri = (id: string): string => KB + 'dis-business-card-sheet-' + id;
  c.designVersions.forEach((v, k) => {
    const n = vIri(v.id);
    typed(n, 'DesignVersion', 'Business card design ' + v.id, v.summary);
    add(n, KP + 'version-of', iri(designIri));
    add(n, KP + 'date', lit(v.date));
    const next = c.designVersions[k + 1];
    if (next) add(n, KP + 'superseded-by', iri(vIri(next.id)));
  });
  c.printSheets.forEach((s, k) => {
    const n = sIri(s.id);
    typed(n, 'PrintSheet', 'Print sheet ' + s.id, s.what + ' Why: ' + s.why);
    add(n, KP + 'derived-from', iri(vIri(s.madeFrom)));
    add(n, KP + 'made-for', iri(designIri));
    add(n, KP + 'visibility', lit('private'));
    add(n, KP + 'layout', lit(c.printSheetSpec.paper + '; ' + c.printSheetSpec.layout + '; bleed ' + c.printSheetSpec.bleed + '; ' + c.printSheetSpec.marks));
    add(n, KP + 'made-by', lit(c.printSheetSpec.script));
    const next = c.printSheets[k + 1];
    if (next) add(n, KP + 'superseded-by', iri(sIri(next.id)));
  });
  const last = c.printSheets[c.printSheets.length - 1];
  const ruleIri = KB + 'dis-business-card-rule';
  typed(ruleIri, 'Rule', 'Regenerate the print sheet when the card design changes',
    'A print sheet is an output of the design: it records which design version it was made from. When the design is exported again and differs, the sheet made from the old version is out of date and a new one is built from the new export (' + c.printSheetSpec.script + ', which writes a receipt of what it was built from). Earlier sheets are kept. ' + c.sheetsPrivate);
  add(ruleIri, KP + 'applies-to', iri(designIri));
  if (last) add(ruleIri, KP + 'regenerates', iri(sIri(last.id)));
  add(designIri, KP + 'governed-by', iri(ruleIri));

  return {
    designIri, images, versions: c.designVersions.length, sheets: c.printSheets.length, ruleIri,
    sheetIris: c.printSheets.map((s) => sIri(s.id)), versionIris: c.designVersions.map((v) => vIri(v.id)),
    changedWhy: c.printSheets.slice(1).map((s) => 'sheet ' + s.id + ': ' + s.why.charAt(0).toLowerCase() + s.why.slice(1).replace(/\.$/, '')).join('; '),
  };
}
