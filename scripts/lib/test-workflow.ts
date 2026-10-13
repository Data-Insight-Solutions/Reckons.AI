/**
 * Test workflows (F34.2) — read a ktype:TestWorkflow and its ordered ktype:TestStep entities from
 * the Testing graph, and compute everything that must agree with them.
 *
 * THIS FILE IS THE ONE PLACE THE STEP LIST IS READ. Four things consume it, and none of them keeps
 * its own copy:
 *   - scripts/docs-pages.ts      the step sections of the workflow page, AND the flow diagram
 *   - scripts/docs-diagrams.ts   collects the diagram source so it is rendered into the cache
 *   - tests/e2e/workflow-*.ts    the test that RUNS the steps (it fails on a missing/extra step)
 *   - scripts/offline/test-workflow-check.ts   every step has a screenshot and the file exists
 *
 * So the diagram cannot show a step the test does not run, and the test cannot run a step the page
 * does not show: both come from the same triples. What is NOT guaranteed by construction is that
 * the test body of a step really does what its text says; that is a human review, and the
 * assertion text on the page is how a reader can judge it.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Parser } from 'n3';

import type { Quad } from '@rdfjs/types';

export const ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
export const TESTING_TTL = join(ROOT, 'static', 'docs-testing.ttl');

const KTYPE = 'urn:kbase:type/';
const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';

/** Every flagship screenshot is captured at this viewport, so the page can reserve the space. */
export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 800;

export const TEST_WORKFLOW = `${KTYPE}TestWorkflow`;
export const TEST_STEP = `${KTYPE}TestStep`;
export const P = {
  partOf: `${KPRED}part-of`,
  stepOrder: `${KPRED}step-order`,
  workflowId: `${KPRED}workflow-id`,
  stepId: `${KPRED}step-id`,
  testFile: `${KPRED}test-file`,
  page: `${KPRED}page`,
  assertion: `${KPRED}assertion`,
  boxLabel: `${KPRED}box-label`,
  shortLabel: `${KPRED}short-label`,
  screenshot: `${KPRED}screenshot`,
} as const;

export interface WorkflowStep {
  iri: string;
  /** Stable key the test implements the step under, e.g. "add-source". */
  id: string;
  order: number;
  title: string;
  /** What the person does or sees, in plain words. */
  text: string;
  /** The app route the step happens on. */
  page: string;
  /** What the test checks at this step, in plain words. */
  assertion: string;
  /** Short words for the diagram node; falls back to the title. */
  shortLabel: string;
  /** The label drawn on the highlight box in the screenshot. */
  boxLabel: string;
  /** Site-root path of the annotated screenshot, or null when none has been captured. */
  screenshot: string | null;
}

export interface Workflow {
  iri: string;
  id: string;
  title: string;
  definition: string;
  testFile: string;
  steps: WorkflowStep[];
}

export function parseTtl(file: string): Quad[] {
  return new Parser().parse(readFileSync(file, 'utf8')) as Quad[];
}

/** Every workflow in these quads, steps in their declared order. Throws on a malformed graph. */
export function loadWorkflows(quads: Quad[]): Workflow[] {
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const arr = bySubject.get(q.subject.value) ?? [];
    arr.push(q);
    bySubject.set(q.subject.value, arr);
  }
  const lit = (iri: string, p: string): string | null =>
    bySubject.get(iri)?.find((q) => q.predicate.value === p && q.object.termType === 'Literal')?.object.value ?? null;
  const isType = (iri: string, t: string) =>
    !!bySubject.get(iri)?.some((q) => q.predicate.value === RDF_TYPE && q.object.value === t);
  const need = (iri: string, p: string, what: string): string => {
    const v = lit(iri, p);
    if (v === null || v.trim() === '') throw new Error(`<${iri}> has no ${what}`);
    return v;
  };

  const workflows: Workflow[] = [];
  for (const iri of bySubject.keys()) {
    if (!isType(iri, TEST_WORKFLOW)) continue;
    const steps: WorkflowStep[] = [];
    for (const [sIri, sQuads] of bySubject) {
      if (!isType(sIri, TEST_STEP)) continue;
      if (!sQuads.some((q) => q.predicate.value === P.partOf && q.object.value === iri)) continue;
      const order = parseInt(need(sIri, P.stepOrder, 'kpred:step-order'), 10);
      if (!Number.isFinite(order)) throw new Error(`<${sIri}> has a non-numeric kpred:step-order`);
      const title = need(sIri, RDFS_LABEL, 'rdfs:label');
      steps.push({
        iri: sIri,
        id: need(sIri, P.stepId, 'kpred:step-id'),
        order,
        title,
        text: need(sIri, SKOS_DEFINITION, 'skos:definition'),
        page: need(sIri, P.page, 'kpred:page'),
        assertion: need(sIri, P.assertion, 'kpred:assertion'),
        shortLabel: lit(sIri, P.shortLabel) ?? title,
        boxLabel: lit(sIri, P.boxLabel) ?? title,
        screenshot: lit(sIri, P.screenshot),
      });
    }
    steps.sort((a, b) => a.order - b.order);
    const orders = steps.map((s) => s.order);
    if (new Set(orders).size !== orders.length) throw new Error(`<${iri}> has two steps with the same kpred:step-order`);
    const ids = steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) throw new Error(`<${iri}> has two steps with the same kpred:step-id`);
    workflows.push({
      iri,
      id: need(iri, P.workflowId, 'kpred:workflow-id'),
      title: need(iri, RDFS_LABEL, 'rdfs:label'),
      definition: lit(iri, SKOS_DEFINITION) ?? '',
      testFile: need(iri, P.testFile, 'kpred:test-file'),
      steps,
    });
  }
  return workflows.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadWorkflowsFromFile(file = TESTING_TTL): Workflow[] {
  return loadWorkflows(parseTtl(file));
}

/** Mermaid labels are quoted strings; keep user text from closing the quote or injecting markup. */
function mm(s: string): string {
  return s.replace(/["<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Wrap a short label onto lines of at most ~`width` characters, joined with mermaid's <br/>. */
function wrap(s: string, width = 18): string {
  const out: string[] = [];
  let line = '';
  for (const word of mm(s).split(' ')) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join('<br/>');
}

/**
 * The flow diagram, as mermaid source, computed from the steps and nothing else.
 *
 * Deterministic: the same steps always give the same string, so its hash (the render cache key) only
 * changes when a step is added, removed, reordered or renamed.
 */
export function workflowDiagram(w: Workflow): string {
  if (!w.steps.length) throw new Error(`<${w.iri}> has no steps, so there is no diagram to draw`);
  const lines = ['flowchart LR'];
  w.steps.forEach((s, i) => {
    lines.push(`  S${i + 1}["${i + 1}. ${wrap(s.shortLabel)}<br/><i>${mm(s.page)}</i>"]`);
  });
  lines.push('  ' + w.steps.map((_, i) => `S${i + 1}`).join(' --> '));
  return lines.join('\n');
}

/** Every workflow diagram in the Testing graph, for scripts/docs-diagrams.ts to render. */
export function allWorkflowDiagrams(file = TESTING_TTL): string[] {
  return loadWorkflowsFromFile(file).map(workflowDiagram);
}

/** Where a step's screenshot lives on disk, for a site-root path such as /workflows/x/01-a.webp. */
export function screenshotFile(sitePath: string): string {
  return join(ROOT, 'static', sitePath.replace(/^\/+/, ''));
}

/** The site-root path a step's screenshot is written to, by convention. */
export function conventionalScreenshotPath(w: Workflow, s: WorkflowStep): string {
  return `/workflows/${w.id}/${String(s.order).padStart(2, '0')}-${s.id}.webp`;
}

/**
 * Set (or replace) a step's `kpred:screenshot` line in the Testing graph's text, leaving every
 * other byte alone. The step is addressed by the local name after its `test:` prefix, which is how
 * docs-testing.ttl writes it. Throws if the step block is not found, so a typo cannot silently
 * link nothing.
 */
export function setScreenshotLink(ttl: string, stepIri: string, sitePath: string): string {
  const local = stepIri.replace('urn:reckons:test/', '');
  const lines = ttl.split('\n');
  const start = lines.findIndex((l) => l.trim() === `test:${local}`);
  if (start < 0) throw new Error(`No block for test:${local} in the Testing graph`);
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  const block = lines.slice(start, end + 1);
  const link = `    kpred:screenshot    "${sitePath}" ;`;
  const existing = block.findIndex((l) => l.includes('kpred:screenshot'));
  if (existing >= 0) {
    lines[start + existing] = link;
  } else {
    const at = block.findIndex((l) => l.includes('kpred:page'));
    lines.splice(start + (at >= 0 ? at : 0) + 1, 0, link);
  }
  return lines.join('\n');
}
