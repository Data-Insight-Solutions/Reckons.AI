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
import { readStoryQuads } from '../../src/lib/rdf/story-steps';
import { applyPointers, readPointers } from '../../src/lib/rdf/story-pointer';
import { EXAMPLE_KBS } from '../../src/lib/storage/example-kbs';

export const ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
export const TESTING_TTL = join(ROOT, 'static', 'docs-testing.ttl');

const KTYPE = 'urn:kbase:type/';
const KPRED = 'urn:kbase:predicate/';

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
  boxTarget: `${KPRED}box-target`,
  pageName: `${KPRED}page-name`,
  shotsNote: `${KPRED}shots-note`,
  shortLabel: `${KPRED}short-label`,
  screenshot: `${KPRED}screenshot`,
  /** F275.1: the line spoken while the step plays in a demo video. */
  narration: `${KPRED}narration`,
  /** F275.1: the Hume voice (name or id) a workflow's demo is narrated in. */
  narrator: `${KPRED}narrator`,
  /** F275: a short question or bridge spoken as the step begins, before the screen changes. */
  narrationLead: `${KPRED}narration-lead`,
  /** F275.22: the rendered video this workflow's pages play, a site-root path under /video/demos/. */
  video: `${KPRED}video`,
  videoCaptions: `${KPRED}video-captions`,
  videoPoster: `${KPRED}video-poster`,
  /** The entity a workflow documents: its page shows the workflow's video too. */
  relatesTo: `${KPRED}relates-to`,
  /** F275.22.2: one sentence on what the viewer understands by the end and how the steps build. */
  narrationStoryline: `${KPRED}narration-storyline`,
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
  /** In plain words, the control or result the box sits on: the thing the step is about. */
  boxTarget: string;
  /** What a person calls the place this step happens, e.g. "the Add tab". */
  pageName: string;
  /** Site-root path of the annotated screenshot, or null when none has been captured. */
  screenshot: string | null;
  /** F275.1: what the demo narrator says during this step, or null when the step plays silent. */
  narration: string | null;
  /** F275: spoken at the step's start, before its pause; null when the step has none. */
  narrationLead: string | null;
}

export interface Workflow {
  iri: string;
  id: string;
  title: string;
  definition: string;
  /** Markdown on how the screenshots were made and what is scripted; shown after the diagram. */
  shotsNote: string;
  testFile: string;
  /** F275.1: the Hume voice its demo is narrated in, or null for the render's default. */
  narrator: string | null;
  /** F275.22: site-root paths of the rendered video, its captions and its poster, or null. */
  video: string | null;
  videoCaptions: string | null;
  videoPoster: string | null;
  /** Entities this workflow documents (kpred:relates-to). */
  relatesTo: string[];
  /** F300.5: the example space the steps live in (kpred:story-space) and the file that holds them, or null for a workflow that keeps its own steps. */
  storySpace: string | null;
  storyFile: string | null;
  steps: WorkflowStep[];
}

/**
 * The story of a space whose file is GENERATED is hand-written in a source fragment the generator copies in
 * (the generator would delete a story written into its output). Screenshot links are written to the source.
 */
export const GENERATED_STORY_SOURCES: Record<string, string> = {
  'generated-assets': join(ROOT, 'scripts', 'content', 'gen-assets-walk.ttl'),
  // static/starter-everyday-reviewed.ttl is GENERATED by scripts/starter/build-everyday.ts from this hand-written file;
  // after `npm run workflow:shots` writes media links here, run build-everyday so the served file carries them.
  'getting-started': join(ROOT, 'static', 'starter-everyday.ttl'),
};

/** Quads of an example space's file, resolved through EXAMPLE_KBS; null for an id that is not an example. */
export function loadExampleSpace(spaceId: string): Quad[] | null {
  const kb = EXAMPLE_KBS.find((k) => k.id === spaceId);
  return kb ? parseTtl(join(ROOT, 'static', kb.file.replace(/^\/+/, ''))) : null;
}

export function exampleSpaceFile(spaceId: string): string | null {
  const kb = EXAMPLE_KBS.find((k) => k.id === spaceId);
  return kb ? join(ROOT, 'static', kb.file.replace(/^\/+/, '')) : null;
}

export function parseTtl(file: string): Quad[] {
  return new Parser().parse(readFileSync(file, 'utf8')) as Quad[];
}

/**
 * Every workflow in these quads, steps in their declared order. Throws on a malformed input.
 * A thin adapter: the reading is src/lib/rdf/story-steps.ts (F300.1), shared with the in-app player.
 */
export function loadWorkflows(quads: Quad[], loadSpace: (id: string) => Quad[] | null = loadExampleSpace): Workflow[] {
  const pointers = new Map(readPointers(quads).map((p) => [p.workflowIri, p]));
  // Recorder-only predicates (F275.22) that the shared reader does not carry.
  const extra = (iri: string, p: string): string | null =>
    quads.find((q) => q.subject.value === iri && q.predicate.value === p && q.object.termType === 'Literal')?.object.value.trim() || null;
  return applyPointers(readStoryQuads(quads, { strict: true }).filter((s) => s.origin === 'test-workflow'), quads, loadSpace)
    .map((s): Workflow => ({
      iri: s.iri,
      id: s.id,
      title: s.label,
      definition: s.description,
      shotsNote: s.shotsNote,
      testFile: s.testFile ?? '',
      narrator: s.narrator?.trim() || null,
      video: extra(s.iri, P.video),
      videoCaptions: extra(s.iri, P.videoCaptions),
      videoPoster: extra(s.iri, P.videoPoster),
      storySpace: pointers.get(s.iri)?.spaceId ?? null,
      storyFile: pointers.has(s.iri) ? (GENERATED_STORY_SOURCES[pointers.get(s.iri)!.spaceId] ?? exampleSpaceFile(pointers.get(s.iri)!.spaceId)) : null,
      relatesTo: quads.filter((q) => q.subject.value === s.iri && q.predicate.value === P.relatesTo && q.object.termType === 'NamedNode').map((q) => q.object.value),
      steps: s.steps.map((t): WorkflowStep => ({
        iri: t.iri,
        id: t.id,
        order: t.order,
        title: t.title,
        text: t.detail,
        page: t.route ?? t.openPage ?? t.actions.find((a) => a.kind === 'open-page')?.path ?? '',
        assertion: t.expects.find((e) => e.kind === 'note')?.text ?? '',
        shortLabel: t.shortLabel,
        boxLabel: t.target?.label ?? t.title,
        boxTarget: t.boxTarget ?? t.target?.ref ?? '',
        pageName: t.pageName,
        screenshot: t.media,
        // A story in a space says its line once, as story:content; a legacy step keeps kpred:narration.
        narration: pointers.has(s.iri) ? (t.content.trim() || null) : extra(t.iri, P.narration),
        narrationLead: t.question?.trim() || null,
      })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every story in the Testing graph as the unified model, pointers resolved to the steps in their space (F300.5). */
export function loadStoriesFromFile(file = TESTING_TTL, loadSpace: (id: string) => Quad[] | null = loadExampleSpace) {
  const quads = parseTtl(file);
  return applyPointers(readStoryQuads(quads, { strict: true }), quads, loadSpace);
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
  const lines = ['flowchart TB'];
  w.steps.forEach((s, i) => {
    lines.push(`  S${i + 1}["${i + 1}. ${wrap(s.shortLabel, 30)}<br/><i>${mm(s.pageName)}</i>"]`);
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

/**
 * Set (or replace) a story step's `story:media` line in the text of the file that holds the story, leaving every
 * other byte alone (the F300.5 counterpart of setScreenshotLink). The step is the `story:<local>` block. Throws if
 * the block is not found or is a single-line statement, so a typo cannot silently link nothing.
 */
export function setStoryMediaLink(ttl: string, stepIri: string, sitePath: string): string {
  const local = stepIri.replace('urn:reckons:story/', '');
  const lines = ttl.split('\n');
  const start = lines.findIndex((l) => l === `story:${local}` || l.startsWith(`story:${local} `));
  if (start < 0) throw new Error(`No block for story:${local}`);
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].trim() !== '' && !/^[\w-]*:[\w-]+(\s|$)/.test(lines[end + 1])) end++;
  const block = lines.slice(start, end + 1);
  const link = `    story:media "${sitePath}" ;`;
  const existing = block.findIndex((l) => l.trim().startsWith('story:media '));
  if (existing >= 0) { lines[start + existing] = link; return lines.join('\n'); }
  if (/\.\s*$/.test(block[0])) throw new Error(`story:${local} is a one-line statement; cannot add story:media`);
  lines.splice(start + 1, 0, link);
  return lines.join('\n');
}
