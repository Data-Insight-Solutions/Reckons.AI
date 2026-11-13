/**
 * Turns an extracted Profile (site-profile.ts) into entities of the Data Insight Solutions example (F274.7).
 *
 * Every entity is stated on the public page that states it (the `stated-on` predicate the expiry facts already use),
 * so a visitor can follow any claim back to the address it came from. Nothing here invents a fact: a record the
 * profile did not extract produces no node, and a link is made only when both ends exist in the example.
 * Returns the summary the story's "who is behind the site" step counts from.
 */
import { createHash } from 'node:crypto';
import { iri, lit, type Statement, type Term } from '../../src/lib/rdf/types.js';
import { STATED_ON_PREDICATE } from '../../src/lib/publish/site-expiry.js';
import type { Profile } from './site-profile.js';
import type { StoryWho } from './site-story.js';

const KB = 'urn:kbase:concept/';
const TYPE = 'urn:kbase:type/';
const KP = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const LEAP = 'urn:reckons:leap';
const LEAP_LABEL = 'urn:reckons:leap/label';

type Add = (s: string, p: string, o: Term, extra?: Partial<Statement>) => void;
export interface ProfileContext {
  orgIri: string;
  siteIri: string;
  /** Page slug to the node of that published page. */
  nodeBySlug: Map<string, string>;
  /** Expiry fact label to the node of that fact, so a credential with a valid-until date IS that fact. */
  factIris: Map<string, string>;
  base: string;
}

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

export function addProfile(add: Add, p: Profile, c: ProfileContext): StoryWho | undefined {
  const aboutNode = c.nodeBySlug.get('about'), servicesNode = c.nodeBySlug.get('services');
  const typed = (node: string, type: string, label: string, comment: string | undefined, page: string | undefined): void => {
    add(node, RDF_TYPE, iri(TYPE + type));
    add(node, RDFS_LABEL, lit(label));
    if (comment) add(node, RDFS_COMMENT, lit(comment));
    if (page) add(node, STATED_ON_PREDICATE, iri(page));
  };

  let placeIri: string | undefined;
  if (p.org) {
    add(c.orgIri, KP + 'legal-form', lit((p.org.state ? p.org.state + ' ' : '') + 'limited liability company'));
    if (p.org.formed) add(c.orgIri, KP + 'formed', lit(p.org.formed, 'http://www.w3.org/2001/XMLSchema#gYear'));
    if (p.org.remote) add(c.orgIri, KP + 'works', lit('remotely, with teams anywhere'));
    if (p.org.city && p.org.region) {
      placeIri = KB + 'dis-place-' + slugOf(p.org.city + '-' + p.org.region);
      typed(placeIri, 'Place', p.org.city + ', ' + p.org.region, undefined, aboutNode);
      add(c.orgIri, KP + 'located-in', iri(placeIri));
    }
    if (aboutNode) add(c.orgIri, STATED_ON_PREDICATE, iri(aboutNode));
  }

  // The product the About page says the owner is building.
  let productIri: string | undefined;
  const svcCard = p.services.find((s) => p.product && s.title.includes(p.product.name));
  if (p.product) {
    productIri = KB + 'dis-product-' + slugOf(p.product.name);
    typed(productIri, 'Tool', p.product.name, svcCard?.honestStatus ? 'Honest status: ' + svcCard.honestStatus : undefined, aboutNode);
    for (const t of p.product.traits) add(productIri, KP + 'trait', lit(t));
    if (svcCard?.tag) add(productIri, KP + 'status', lit(svcCard.tag));
    add(c.orgIri, KP + 'home-of', iri(productIri));
    if (servicesNode && svcCard) add(productIri, STATED_ON_PREDICATE, iri(servicesNode));
  }

  let personIri: string | undefined;
  if (p.person) {
    personIri = KB + 'dis-person-' + slugOf(p.person.name);
    typed(personIri, 'Person', p.person.name, undefined, aboutNode);
    add(personIri, KP + 'role', lit(p.person.role));
    for (const t of p.person.titles) add(personIri, KP + 'title', lit(t));
    add(personIri, KP + 'works-for', iri(c.orgIri));
    add(personIri, KP + 'owns', iri(c.orgIri));
    add(personIri, KP + 'published', iri(c.siteIri));
    if (productIri) add(personIri, KP + 'builds', iri(productIri));
  }

  // Services, each with the posts the Services page links for it.
  let specialties = 0;
  for (const s of p.services) {
    const node = KB + 'dis-service-' + slugOf(s.title);
    typed(node, 'Service', s.title, undefined, servicesNode);
    add(c.orgIri, KP + 'offers', iri(node));
    if (productIri && s === svcCard) add(node, KP + 'delivers', iri(productIri));
    for (const slug of s.postSlugs) { const post = c.nodeBySlug.get(slug); if (post) add(node, KP + 'covered-in', iri(post)); }
    for (const sp of s.specialties) {
      const sn = KB + 'dis-specialty-' + slugOf(sp.label);
      typed(sn, 'Concept', sp.label, sp.text, servicesNode);
      add(sn, KP + 'part-of', iri(node));
      const post = sp.slug ? c.nodeBySlug.get(sp.slug) : undefined;
      if (post) add(sn, KP + 'covered-in', iri(post));
      specialties++;
    }
  }
  let damIri: string | undefined;
  if (p.dam) {
    damIri = KB + 'dis-concept-' + slugOf(p.dam.short);
    typed(damIri, 'Concept', p.dam.label + ' (' + p.dam.short + ')', p.dam.text, servicesNode);
    add(c.orgIri, KP + 'specializes-in', iri(damIri));
  }

  // Mission and the principles stated beside it.
  let missionIri: string | undefined;
  if (p.mission) {
    missionIri = KB + 'dis-mission';
    typed(missionIri, 'Mission', 'Mission', p.mission.text, aboutNode);
    if (p.mission.tenet) add(missionIri, KP + 'tenet', lit(p.mission.tenet));
    add(c.orgIri, KP + 'mission', iri(missionIri));
  }
  for (const pr of p.principles) {
    const node = KB + 'dis-principle-' + slugOf(pr.name);
    typed(node, 'Principle', pr.name, pr.text, aboutNode);
    add(c.orgIri, KP + 'follows', iri(node));
    if (missionIri) add(node, KP + 'part-of', iri(missionIri));
  }

  // Credentials: a credential that carries a valid-until date IS the dated fact the expiry check watches (F293).
  for (const cr of p.credentials) {
    const node = (cr.hasMarker ? c.factIris.get(cr.label) : undefined) ?? KB + 'dis-credential-' + slugOf(cr.label).slice(0, 40) + '-' + hash(cr.label);
    if (cr.hasMarker && c.factIris.has(cr.label)) { add(node, RDF_TYPE, iri(TYPE + 'Credential')); }
    else typed(node, 'Credential', cr.label, undefined, aboutNode);
    if (cr.group) add(node, KP + 'listed-under', lit(cr.group));
    if (cr.year) add(node, KP + 'year', lit(cr.year));
    if (cr.verify) add(node, KP + 'verify-at', lit(cr.verify));
    if (personIri) add(personIri, KP + 'holds', iri(node));
  }
  const orgs = new Map<string, string>();
  for (const ed of p.education) {
    const node = KB + 'dis-education-' + slugOf(ed.label).slice(0, 40) + '-' + hash(ed.label);
    typed(node, 'Education', ed.label, undefined, aboutNode);
    add(node, KP + 'years', lit(ed.years));
    let inst = orgs.get(ed.institution);
    if (!inst) { inst = KB + 'dis-org-' + slugOf(ed.institution); orgs.set(ed.institution, inst); typed(inst, 'Organization', ed.institution, undefined, aboutNode); }
    add(node, KP + 'awarded-by', iri(inst));
    if (personIri) add(personIri, KP + 'earned', iri(node));
  }
  for (const r of p.recognition) {
    const node = KB + 'dis-recognition-' + slugOf(r) + '-' + hash(r);
    typed(node, 'Recognition', r.charAt(0).toUpperCase() + r.slice(1), undefined, aboutNode);
    if (personIri) add(personIri, KP + 'received', iri(node));
  }

  // The scanned ring: an asset, labelled reconstructed, with a leap to the ring's own example.
  if (p.ring) {
    const node = KB + 'dis-ring';
    typed(node, 'GaussianSplat', p.ring.label, p.ring.text, aboutNode);
    if (p.ring.reconstructed) add(node, KP + 'provenance', lit('reconstructed from photographs of the real object, not generated by a model'));
    if (p.ring.viewerPath) add(node, KP + 'url', lit(c.base + p.ring.viewerPath));
    if (p.ring.leapPath) { add(node, LEAP, lit(p.ring.leapPath)); add(node, LEAP_LABEL, lit(p.ring.leapLabel ?? 'Open the ring example')); }
    if (productIri && p.product && p.ring.text.includes(p.product.name)) add(node, KP + 'made-with', iri(productIri));
    add(node, KP + 'part-of', iri(c.siteIri));
  }

  if (!personIri || !p.person) return undefined;
  return {
    personIri, personName: p.person.name, role: p.person.role, titles: p.person.titles, orgIri: c.orgIri,
    orgName: p.org?.legalName ?? null, formed: p.org?.formed ?? null, place: p.org && p.org.city && p.org.region ? p.org.city + ', ' + p.org.region : null,
    services: p.services.length, credentials: p.credentials.length, recognition: p.recognition.length,
    highlights: [personIri, c.orgIri, ...(placeIri ? [placeIri] : [])],
  };
}
