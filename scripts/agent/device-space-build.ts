/** Builds the private device space text from measured values (F269). Pure; the IO is measure-device.ts. */
import { DEVICE_IRI, DEVICE_TYPE, MEASUREMENT_TYPE, P, termIri, type Measured } from './device-capabilities.js';
import { renderSpace, type Fact } from './queue-to-space.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ENTITY_TYPE = 'urn:kbase:type/EntityType';
const SOURCE_IRI = 'urn:kbase:source/device-measurement';
const SOURCE_TITLE = 'Measured by script on this device';
const SCHEMA_CREATED = '1970-01-01T00:00:00.000Z';

/**
 * The device-only space text for measured values. Pure and deterministic apart from the generated
 * line. Each measurement is a confirmed, dated, derived fact, never a proposal.
 */
export function buildMeasuredSpaceText(m: Measured, stableId: string, nowMs: number): string {
  const facts: Fact[] = [];
  const at = m.measuredAt;
  const typeFact = (iri: string, label: string, color: string, icon: string): void => {
    for (const [p, o] of [[RDF_TYPE, ENTITY_TYPE], [RDFS_LABEL, label], [`${P}icon`, icon], [`${P}color`, color]] as const)
      facts.push({ s: iri, p, o, created: SCHEMA_CREATED });
  };
  typeFact(DEVICE_TYPE, 'Device', '#2a6f86', 'box');
  typeFact(MEASUREMENT_TYPE, 'Measurement', '#3a8fa6', 'circle');
  const F = (s: string, p: string, o: string, dt?: string): void => { facts.push({ s, p, o, ...(dt ? { dt } : {}), created: at }); };
  F(DEVICE_IRI, RDF_TYPE, DEVICE_TYPE);
  F(DEVICE_IRI, RDFS_LABEL, 'This device');
  F(DEVICE_IRI, `${P}measured`, at, 'http://www.w3.org/2001/XMLSchema#dateTime');
  for (const term of Object.keys(m.values).sort()) {
    const iri = `urn:kbase:concept/measured-${term.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;
    const val = m.values[term];
    F(iri, RDF_TYPE, MEASUREMENT_TYPE);
    F(iri, RDFS_LABEL, term);
    F(iri, `${P}capability`, termIri(term));
    F(iri, `${P}measured-value`, String(val), typeof val === 'number' ? 'http://www.w3.org/2001/XMLSchema#decimal' : 'http://www.w3.org/2001/XMLSchema#boolean');
    F(iri, `${P}measured`, at, 'http://www.w3.org/2001/XMLSchema#dateTime');
    F(DEVICE_IRI, `${P}has-measurement`, iri);
  }
  return renderSpace(facts, nowMs, { stableId, sourceIri: SOURCE_IRI, sourceTitle: SOURCE_TITLE, deviceOnly: true });
}

