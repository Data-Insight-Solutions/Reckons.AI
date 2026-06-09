/**
 * Starter templates — pre-seeded KB scenarios for onboarding.
 *
 * Each template provides a small set of confirmed statements and a source
 * record that the user can explore immediately, without needing to configure
 * an AI backend or ingest their own content first.
 *
 * Templates are intentionally minimal — enough to show the app is useful,
 * not so much that they overwhelm a new user.
 */

import type { Statement } from '$lib/rdf/types';
import type { Source } from '$lib/rdf/types';
import { v4 as uuid } from 'uuid';

export interface OnboardingTemplate {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** One-line scenario context shown in the picker */
  scenario: string;
  /** What the user can try first after loading */
  hint: string;
  buildData(): { source: Source; statements: Statement[] };
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function iri(value: string): { kind: 'iri'; value: string } {
  return { kind: 'iri', value };
}
function lit(value: string): { kind: 'literal'; value: string } {
  return { kind: 'literal', value };
}

function triple(
  sourceId: string,
  graphIri: string,
  s: string,
  p: string,
  o: string,
  oIsLit = true
): Statement {
  const now = Date.now();
  return {
    id: uuid(),
    sourceId,
    status: 'confirmed',
    confidence: 1,
    s: iri(s),
    p: iri(p),
    o: oIsLit ? lit(o) : iri(o),
    g: iri(graphIri),
    createdAt: now,
    updatedAt: now,
  };
}

function typeTriple(sourceId: string, graphIri: string, subject: string, typeIri: string): Statement {
  return triple(sourceId, graphIri, subject, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', typeIri, false);
}

function label(sourceId: string, graphIri: string, subject: string, text: string): Statement {
  return triple(sourceId, graphIri, subject, 'http://www.w3.org/2000/01/rdf-schema#label', text, true);
}

const KB = 'urn:kbase:';
const TYPE = `${KB}type/`;
const PRED = `${KB}predicate/`;

// ── Template definitions ───────────────────────────────────────────────────────

export const ONBOARDING_TEMPLATES: OnboardingTemplate[] = [
  // ── 1. Float Trip ────────────────────────────────────────────────────────────
  {
    id: 'float-trip',
    label: 'Float Trip',
    icon: '🛶',
    description: 'Plan a river float with friends. Track who is coming, the launch site, and weather. Share the plan so everyone has the same picture.',
    scenario: 'Group river float · weather-dependent · shared organizer plan',
    hint: 'Try asking Shelly: "What time should we launch if it rains in the morning?"',
    buildData() {
      const sourceId = 'template-float-trip';
      const g = `urn:source:${sourceId}`;
      const now = Date.now();
      const source: Source = {
        id: sourceId,
        title: 'Starter Template — Float Trip Plan',
        uri: `urn:kbase:source/${sourceId}`,
        ingestedAt: now,
        kind: 'note',
        trustLevel: 'trusted',
      };

      const stmts: Statement[] = [
        // ── People ──────────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}person/alice`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/alice`, 'Alice'),
        triple(sourceId, g, `${KB}person/alice`, `${PRED}occupation`, 'Trip organizer'),

        typeTriple(sourceId, g, `${KB}person/bob`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/bob`, 'Bob'),

        typeTriple(sourceId, g, `${KB}person/carol`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/carol`, 'Carol'),

        // ── Event ───────────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}event/float-trip`, `${TYPE}Event`),
        label(sourceId, g, `${KB}event/float-trip`, 'Meramec River Float — Summer 2026'),
        triple(sourceId, g, `${KB}event/float-trip`, `${PRED}scheduled-at`, '2026-07-19'),
        triple(sourceId, g, `${KB}event/float-trip`, `${PRED}description`, '11-mile float, 5–6 hours, rain delay possible'),
        // Event → Place
        triple(sourceId, g, `${KB}event/float-trip`, `${PRED}location`, `${KB}place/route-66-access`, false),
        // Attendees (Person → Event)
        triple(sourceId, g, `${KB}person/alice`, `${PRED}attendee`, `${KB}event/float-trip`, false),
        triple(sourceId, g, `${KB}person/bob`, `${PRED}attendee`, `${KB}event/float-trip`, false),
        triple(sourceId, g, `${KB}person/carol`, `${PRED}attendee`, `${KB}event/float-trip`, false),

        // ── Launch site ─────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}place/route-66-access`, `${TYPE}Place`),
        label(sourceId, g, `${KB}place/route-66-access`, 'Route 66 State Park Access'),
        triple(sourceId, g, `${KB}place/route-66-access`, `${PRED}address`, 'Route 66 State Park, Eureka MO'),
        triple(sourceId, g, `${KB}place/route-66-access`, `${PRED}description`, 'Parking for 12 cars · shuttle $25/car via Old Canoe Outfitters'),

        // ── Weather note (Concept — an observation/condition) ───────────────────
        typeTriple(sourceId, g, `${KB}concept/weather-july-19`, `${TYPE}Concept`),
        label(sourceId, g, `${KB}concept/weather-july-19`, 'Weather Forecast — July 19'),
        triple(sourceId, g, `${KB}concept/weather-july-19`, `${PRED}definition`, '70% rain chance morning, clearing by 10am, sunny afternoon high 88°F'),
        // Event → Concept (weather affects the event)
        triple(sourceId, g, `${KB}event/float-trip`, `${PRED}related-to`, `${KB}concept/weather-july-19`, false),
      ];

      return { source, statements: stmts };
    }
  },

  // ── 2. Home Project Coordination ─────────────────────────────────────────────
  {
    id: 'home-project',
    label: 'Home Project',
    icon: '🔨',
    description: 'Coordinate a home renovation. Track contractors, task dependencies, and change orders. Subcontractors import your plan to know their scope.',
    scenario: 'Kitchen remodel · schedule coordination · contractor network',
    hint: 'Try asking Shelly: "What work depends on the plumbing being finished?"',
    buildData() {
      const sourceId = 'template-home-project';
      const g = `urn:source:${sourceId}`;
      const now = Date.now();
      const source: Source = {
        id: sourceId,
        title: 'Starter Template — Kitchen Renovation',
        uri: `urn:kbase:source/${sourceId}`,
        ingestedAt: now,
        kind: 'note',
        trustLevel: 'trusted',
      };

      const stmts: Statement[] = [
        // ── People ──────────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}person/rosa`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/rosa`, 'Rosa'),
        triple(sourceId, g, `${KB}person/rosa`, `${PRED}occupation`, 'Plumber'),

        typeTriple(sourceId, g, `${KB}person/jerome`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/jerome`, 'Jerome'),
        triple(sourceId, g, `${KB}person/jerome`, `${PRED}occupation`, 'Electrician'),

        // ── Place ───────────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}place/oak-street-house`, `${TYPE}Place`),
        label(sourceId, g, `${KB}place/oak-street-house`, 'Oak Street House'),
        triple(sourceId, g, `${KB}place/oak-street-house`, `${PRED}address`, '42 Oak Street'),

        // ── Renovation event ────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}event/kitchen-reno`, `${TYPE}Event`),
        label(sourceId, g, `${KB}event/kitchen-reno`, 'Kitchen Renovation 2026'),
        triple(sourceId, g, `${KB}event/kitchen-reno`, `${PRED}scheduled-at`, '2026-06-01'),
        triple(sourceId, g, `${KB}event/kitchen-reno`, `${PRED}ends-at`, '2026-07-15'),
        triple(sourceId, g, `${KB}event/kitchen-reno`, `${PRED}description`, 'Permit approved · demo complete June 2'),
        // Event → Place
        triple(sourceId, g, `${KB}event/kitchen-reno`, `${PRED}location`, `${KB}place/oak-street-house`, false),

        // ── Tasks as Concepts ───────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}concept/plumbing-rough-in`, `${TYPE}Concept`),
        label(sourceId, g, `${KB}concept/plumbing-rough-in`, 'Plumbing Rough-In'),
        triple(sourceId, g, `${KB}concept/plumbing-rough-in`, `${PRED}definition`, '3-day rough-in · inspection required'),
        // Contractor → Task
        triple(sourceId, g, `${KB}person/rosa`, `${PRED}part-of`, `${KB}event/kitchen-reno`, false),

        typeTriple(sourceId, g, `${KB}concept/panel-upgrade`, `${TYPE}Concept`),
        label(sourceId, g, `${KB}concept/panel-upgrade`, 'Panel Upgrade (200A)'),
        triple(sourceId, g, `${KB}concept/panel-upgrade`, `${PRED}definition`, '10-day inspection lead time · depends on plumbing rough-in'),
        triple(sourceId, g, `${KB}person/jerome`, `${PRED}part-of`, `${KB}event/kitchen-reno`, false),
        // Task dependency (Concept → Concept)
        triple(sourceId, g, `${KB}concept/panel-upgrade`, `${PRED}related-to`, `${KB}concept/plumbing-rough-in`, false),

        // Change order (Concept)
        typeTriple(sourceId, g, `${KB}concept/co-pot-filler`, `${TYPE}Concept`),
        label(sourceId, g, `${KB}concept/co-pot-filler`, 'CO-3: Add Pot-Filler'),
        triple(sourceId, g, `${KB}concept/co-pot-filler`, `${PRED}definition`, 'Approved · $340 · +1 day to plumbing rough-in'),
        triple(sourceId, g, `${KB}concept/co-pot-filler`, `${PRED}related-to`, `${KB}concept/plumbing-rough-in`, false),
      ];

      return { source, statements: stmts };
    }
  },

  // ── 3. Research Notes ─────────────────────────────────────────────────────────
  {
    id: 'research-notes',
    label: 'Research Notes',
    icon: '🔬',
    description: 'Build a literature-based knowledge graph. Track papers, authors, and conflicting findings. Run a Reckoning to identify the strongest next hypothesis.',
    scenario: 'Lab research · literature review · conflicting findings',
    hint: 'Try asking Shelly: "Which papers support the calcium hypothesis?"',
    buildData() {
      const sourceId = 'template-research';
      const g = `urn:source:${sourceId}`;
      const now = Date.now();
      const source: Source = {
        id: sourceId,
        title: 'Starter Template — Neuroscience Literature Review',
        uri: `urn:kbase:source/${sourceId}`,
        ingestedAt: now,
        kind: 'note',
        trustLevel: 'trusted',
      };

      const stmts: Statement[] = [
        // ── People ──────────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}person/dr-chen`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/dr-chen`, 'Dr. Chen'),
        triple(sourceId, g, `${KB}person/dr-chen`, `${PRED}occupation`, 'Neuroscientist'),
        triple(sourceId, g, `${KB}person/dr-chen`, `${PRED}affiliation`, 'Westbrook Neuroscience Lab'),

        // ── Concept: calcium hypothesis ─────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}concept/calcium-hypothesis`, `${TYPE}Concept`),
        label(sourceId, g, `${KB}concept/calcium-hypothesis`, 'Calcium Concentration Hypothesis'),
        triple(sourceId, g, `${KB}concept/calcium-hypothesis`, `${PRED}definition`, 'Higher Ca²⁺ concentration reduces neural activation latency'),

        // ── Paper A (Document) ──────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}document/huang-2022`, `${TYPE}Document`),
        label(sourceId, g, `${KB}document/huang-2022`, 'Huang et al. (2022)'),
        triple(sourceId, g, `${KB}document/huang-2022`, `${PRED}published-at`, '2022-03-15'),
        triple(sourceId, g, `${KB}document/huang-2022`, `${PRED}description`, 'Activation latency ~120ms at 1.2mM Ca²⁺'),
        triple(sourceId, g, `${KB}document/huang-2022`, `${PRED}url`, 'https://doi.org/10.1016/j.neuron.2022.03.001'),
        // Paper → Concept
        triple(sourceId, g, `${KB}document/huang-2022`, `${PRED}related-to`, `${KB}concept/calcium-hypothesis`, false),

        // ── Paper B (Document) ──────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}document/liu-2023`, `${TYPE}Document`),
        label(sourceId, g, `${KB}document/liu-2023`, 'Liu et al. (2023)'),
        triple(sourceId, g, `${KB}document/liu-2023`, `${PRED}published-at`, '2023-07-22'),
        triple(sourceId, g, `${KB}document/liu-2023`, `${PRED}description`, 'Activation latency ~80ms at 2.0mM Ca²⁺ — 40ms faster than Huang'),
        triple(sourceId, g, `${KB}document/liu-2023`, `${PRED}url`, 'https://doi.org/10.1016/j.neuron.2023.07.015'),
        triple(sourceId, g, `${KB}document/liu-2023`, `${PRED}related-to`, `${KB}concept/calcium-hypothesis`, false),

        // ── Experiment (Event) ──────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}event/ana-study-2026`, `${TYPE}Event`),
        label(sourceId, g, `${KB}event/ana-study-2026`, 'Ana — Activation Latency Study 2026'),
        triple(sourceId, g, `${KB}event/ana-study-2026`, `${PRED}description`, '~82ms at 2.0mM Ca²⁺ (n=3) — replicates Liu within 2ms'),
        // Experiment cites papers (Event → Document)
        triple(sourceId, g, `${KB}event/ana-study-2026`, `${PRED}related-to`, `${KB}document/liu-2023`, false),
        triple(sourceId, g, `${KB}event/ana-study-2026`, `${PRED}related-to`, `${KB}document/huang-2022`, false),
        // Dr. Chen runs the experiment
        triple(sourceId, g, `${KB}person/dr-chen`, `${PRED}attendee`, `${KB}event/ana-study-2026`, false),
      ];

      return { source, statements: stmts };
    }
  },

  // ── 4. Emergency Preparedness ─────────────────────────────────────────────────
  {
    id: 'emergency-prep',
    label: 'Emergency Prep',
    icon: '⚡',
    description: 'Track neighborhood resources, contacts, and shelter locations. Share the plan so neighbors know what\'s available and where to go.',
    scenario: 'Severe weather · resource coordination · community network',
    hint: 'Try asking Shelly: "Who has a generator and who needs power during outages?"',
    buildData() {
      const sourceId = 'template-emergency';
      const g = `urn:source:${sourceId}`;
      const now = Date.now();
      const source: Source = {
        id: sourceId,
        title: 'Starter Template — Neighborhood Emergency Plan',
        uri: `urn:kbase:source/${sourceId}`,
        ingestedAt: now,
        kind: 'note',
        trustLevel: 'trusted',
      };

      const stmts: Statement[] = [
        // ── People ──────────────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}person/kenji`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/kenji`, 'Kenji'),
        triple(sourceId, g, `${KB}person/kenji`, `${PRED}description`, '5500W generator — offered to neighbors in last drill'),

        typeTriple(sourceId, g, `${KB}person/paul`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/paul`, 'Paul'),
        triple(sourceId, g, `${KB}person/paul`, `${PRED}description`, '3000W generator'),

        typeTriple(sourceId, g, `${KB}person/marias-mother`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/marias-mother`, "Maria's Mother"),
        triple(sourceId, g, `${KB}person/marias-mother`, `${PRED}description`, 'CPAP + refrigerator · 1800W peak · mobility limited — needs evac help'),

        typeTriple(sourceId, g, `${KB}person/maria`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/maria`, 'Maria'),

        typeTriple(sourceId, g, `${KB}person/sam`, `${TYPE}Person`),
        label(sourceId, g, `${KB}person/sam`, 'Sam'),
        triple(sourceId, g, `${KB}person/sam`, `${PRED}occupation`, 'Block coordinator'),

        // ── Person → Person connections ─────────────────────────────────────────
        // Kenji offers power to Maria's Mother
        triple(sourceId, g, `${KB}person/kenji`, `${PRED}affiliation`, `${KB}person/marias-mother`, false),
        // Maria is family of her mother
        triple(sourceId, g, `${KB}person/maria`, `${PRED}affiliation`, `${KB}person/marias-mother`, false),

        // ── Shelter (Place) ─────────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}place/community-center`, `${TYPE}Place`),
        label(sourceId, g, `${KB}place/community-center`, 'Oak Park Community Center'),
        triple(sourceId, g, `${KB}place/community-center`, `${PRED}address`, '4400 Manchester Ave'),
        triple(sourceId, g, `${KB}place/community-center`, `${PRED}description`, '120-person capacity · 20kW backup generator'),

        // ── Protocol (Concept) ──────────────────────────────────────────────────
        typeTriple(sourceId, g, `${KB}concept/severe-weather-protocol`, `${TYPE}Concept`),
        label(sourceId, g, `${KB}concept/severe-weather-protocol`, 'Severe Weather Protocol'),
        triple(sourceId, g, `${KB}concept/severe-weather-protocol`, `${PRED}definition`, 'Triggered by NWS warning — Sam texts generator owners and power-dependent neighbors first'),
        // Protocol → Place (shelter destination)
        triple(sourceId, g, `${KB}concept/severe-weather-protocol`, `${PRED}related-to`, `${KB}place/community-center`, false),
        // Sam coordinates the protocol (Person → Concept)
        triple(sourceId, g, `${KB}person/sam`, `${PRED}related-to`, `${KB}concept/severe-weather-protocol`, false),
      ];

      return { source, statements: stmts };
    }
  },
];

/** Template to show when user wants to start empty (no pre-loaded data) */
export const BLANK_TEMPLATE = {
  id: 'blank',
  label: 'Start from scratch',
  icon: '＋',
  description: 'Begin with an empty KB. Ingest your first source — a URL, note, or document.',
  scenario: 'Your own knowledge · any topic',
  hint: 'Head to Ingest to add your first source.',
};
