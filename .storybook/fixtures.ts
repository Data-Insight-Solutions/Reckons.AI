/**
 * Shared seed data for Storybook stories and visual tests.
 *
 * ~15 confirmed statements across 5 entities (2 persons, 1 place, 1 event,
 * 1 concept) with two sources so graph stories render a meaningful KB.
 */
import type { Statement, Source } from '$lib/rdf/types';

const NOW = 1_700_000_000_000;
const g = (v: string) => ({ kind: 'iri' as const, value: v });
const n = (v: string) => ({ kind: 'iri' as const, value: v });
const l = (v: string) => ({ kind: 'literal' as const, value: v, datatype: 'http://www.w3.org/2001/XMLSchema#string' });

const RDF_TYPE  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SCHEMA    = 'https://schema.org/';

export const SEED_SOURCES: Source[] = [
  {
    id: 'src-wiki',
    title: 'Wikipedia — Ada Lovelace',
    uri: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    ingestedAt: NOW - 86_400_000 * 3,
    kind: 'url',
    trustLevel: 'trusted',
    trustScore: 0.9,
  },
  {
    id: 'src-note',
    title: 'Research notes',
    uri: 'note://research-2024',
    ingestedAt: NOW - 86_400_000,
    kind: 'note',
    trustLevel: 'review',
    trustScore: 0.6,
  },
];

export const SEED_STATEMENTS: Statement[] = [
  // ── Ada Lovelace ──────────────────────────────────────────────────────────
  {
    id: 'st-01', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.98,
    s: n('urn:kb/Ada_Lovelace'), p: n(RDF_TYPE), o: n('urn:kbase:type/Person'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 1000, updatedAt: NOW - 1000,
    gloss: 'Ada Lovelace is a Person',
  },
  {
    id: 'st-02', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.99,
    s: n('urn:kb/Ada_Lovelace'), p: n(RDFS_LABEL), o: l('Ada Lovelace'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 1000, updatedAt: NOW - 1000,
    gloss: 'Ada Lovelace rdfs:label "Ada Lovelace"',
  },
  {
    id: 'st-03', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.95,
    s: n('urn:kb/Ada_Lovelace'), p: n(`${SCHEMA}birthDate`), o: l('1815-12-10'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 1000, updatedAt: NOW - 1000,
    gloss: 'Ada Lovelace born 1815-12-10',
  },
  {
    id: 'st-04', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.92,
    s: n('urn:kb/Ada_Lovelace'), p: n(`${SCHEMA}knowsAbout`), o: n('urn:kb/Analytical_Engine'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 900, updatedAt: NOW - 900,
    gloss: 'Ada Lovelace knowsAbout Analytical Engine',
  },
  {
    id: 'st-05', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.88,
    s: n('urn:kb/Ada_Lovelace'), p: n(`${SCHEMA}birthPlace`), o: n('urn:kb/London'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 900, updatedAt: NOW - 900,
    gloss: 'Ada Lovelace born in London',
  },

  // ── Charles Babbage ───────────────────────────────────────────────────────
  {
    id: 'st-06', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.97,
    s: n('urn:kb/Charles_Babbage'), p: n(RDF_TYPE), o: n('urn:kbase:type/Person'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 800, updatedAt: NOW - 800,
    gloss: 'Charles Babbage is a Person',
  },
  {
    id: 'st-07', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.99,
    s: n('urn:kb/Charles_Babbage'), p: n(RDFS_LABEL), o: l('Charles Babbage'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 800, updatedAt: NOW - 800,
    gloss: 'Charles Babbage rdfs:label "Charles Babbage"',
  },
  {
    id: 'st-08', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.93,
    s: n('urn:kb/Charles_Babbage'), p: n(`${SCHEMA}knows`), o: n('urn:kb/Ada_Lovelace'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 800, updatedAt: NOW - 800,
    gloss: 'Charles Babbage knows Ada Lovelace',
  },
  {
    id: 'st-09', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.91,
    s: n('urn:kb/Charles_Babbage'), p: n(`${SCHEMA}invented`), o: n('urn:kb/Analytical_Engine'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 750, updatedAt: NOW - 750,
    gloss: 'Charles Babbage invented the Analytical Engine',
  },

  // ── Analytical Engine ─────────────────────────────────────────────────────
  {
    id: 'st-10', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.96,
    s: n('urn:kb/Analytical_Engine'), p: n(RDF_TYPE), o: n('urn:kbase:type/Concept'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 700, updatedAt: NOW - 700,
    gloss: 'Analytical Engine is a Concept',
  },
  {
    id: 'st-11', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.99,
    s: n('urn:kb/Analytical_Engine'), p: n(RDFS_LABEL), o: l('Analytical Engine'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 700, updatedAt: NOW - 700,
    gloss: 'Analytical Engine rdfs:label "Analytical Engine"',
  },
  {
    id: 'st-12', sourceId: 'src-wiki', status: 'confirmed', confidence: 0.85,
    s: n('urn:kb/Analytical_Engine'), p: n(`${SCHEMA}description`),
    o: l('An early mechanical general-purpose computer designed by Charles Babbage, with a design first described in 1837. Ada Lovelace wrote the first algorithm intended to be processed by it, making her arguably the first computer programmer in history.'),
    g: g('urn:graph/src-wiki'), createdAt: NOW - 700, updatedAt: NOW - 700,
    gloss: 'Analytical Engine description (long)',
  },

  // ── London ────────────────────────────────────────────────────────────────
  {
    id: 'st-13', sourceId: 'src-note', status: 'confirmed', confidence: 0.94,
    s: n('urn:kb/London'), p: n(RDF_TYPE), o: n('urn:kbase:type/Place'),
    g: g('urn:graph/src-note'), createdAt: NOW - 600, updatedAt: NOW - 600,
    gloss: 'London is a Place',
  },
  {
    id: 'st-14', sourceId: 'src-note', status: 'confirmed', confidence: 0.99,
    s: n('urn:kb/London'), p: n(RDFS_LABEL), o: l('London'),
    g: g('urn:graph/src-note'), createdAt: NOW - 600, updatedAt: NOW - 600,
    gloss: 'London rdfs:label "London"',
  },

  // ── Pending statement (for review stories) ────────────────────────────────
  {
    id: 'st-15', sourceId: 'src-note', status: 'pending', confidence: 0.72,
    s: n('urn:kb/Ada_Lovelace'), p: n(`${SCHEMA}occupation`), o: l('Mathematician'),
    g: g('urn:graph/src-note'), createdAt: NOW - 300, updatedAt: NOW - 300,
    gloss: 'Ada Lovelace occupation: Mathematician',
  },
];
