/**
 * ONE READER for a step (F300.1, kb:story-step-vocabulary).
 *
 * A guided sequence used to be read two ways: a `story:Story` in an example (src/lib/rdf/story.ts,
 * the in-app player) and a legacy `ktype:TestWorkflow` in the Testing data (scripts/lib/test-workflow.ts,
 * the docs pages, the e2e test, the recorder). This module reads BOTH into one UnifiedStory, so a
 * story cannot say one thing on its docs page and do another in its test. The two older modules are
 * thin adapters over it.
 *
 * PURE: no n3, no Dexie, no filesystem. It takes quad-shaped objects (an n3 Quad, or a Statement
 * adapted by story.ts), so the app and the scripts import the same file.
 *
 * WHAT IS BUILT: reading, parsing `story:action` and `story:expect` into typed, declarative
 * shapes, and (F300.3, 2026-11-18) a page runner that performs them: src/lib/rdf/story-ops.ts maps
 * each kind to an operation and tests/e2e/story-runner.ts plays a story with recording off or on.
 * WHAT IS NOT: the in-app passive player does not perform actions yet (F300.2); `run-job` is
 * performed only by the e2e page (a synthetic file-queue runner, never a command), not by the app.
 * Expectation kinds: visible, text, attr, elements, media, receipt, count, standing, note. See kb:story-recorder
 * for which walks play through the runner and which steps are still named exceptions.
 *
 * `story:action` and `story:expect` are JSON literals, because a typed shape is unambiguous where
 * a micro-syntax is not. An unknown kind, a missing field or a command-shaped value is REFUSED with
 * a reason on the step (`refusals`), never ignored. A story is data and can arrive from anyone, so
 * the only way to run something is a named, defined job kind with typed parameters.
 */

export interface QuadLike {
  subject: { termType: string; value: string };
  predicate: { value: string };
  object: { termType: string; value: string };
}

const STORY_NS = 'urn:reckons:story/';
const KTYPE = 'urn:kbase:type/';
const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';

/** The story-side predicates, one per mapped meaning. */
export const S = {
  Story: `${STORY_NS}Story`,
  Step: `${STORY_NS}Step`,
  partOf: `${STORY_NS}partOf`,
  order: `${STORY_NS}order`,
  title: `${STORY_NS}title`,
  stepId: `${STORY_NS}stepId`,
  description: `${STORY_NS}description`,
  content: `${STORY_NS}content`,
  question: `${STORY_NS}question`,
  prompt: `${STORY_NS}prompt`,
  storyline: `${STORY_NS}storyline`,
  narrator: `${STORY_NS}narrator`,
  autoplay: `${STORY_NS}autoplay`,
  pace: `${STORY_NS}pace`,
  interaction: `${STORY_NS}interaction`,
  highlight: `${STORY_NS}highlight`,
  target: `${STORY_NS}target`,
  openPage: `${STORY_NS}openPage`,
  offerSetting: `${STORY_NS}offerSetting`,
  layout: `${STORY_NS}layout`,
  filter: `${STORY_NS}filter`,
  action: `${STORY_NS}action`,
  expect: `${STORY_NS}expect`,
  needs: `${STORY_NS}needs`,
  media: `${STORY_NS}media`,
  /** F300.5: what a docs page and a release review need from a step of a story kept in an example's file. All optional. */
  route: `${STORY_NS}page`,
  pageName: `${STORY_NS}pageName`,
  shortLabel: `${STORY_NS}shortLabel`,
  boxTarget: `${STORY_NS}boxTarget`,
  detail: `${STORY_NS}detail`,
  assertion: `${STORY_NS}assertion`,
  shotsNote: `${STORY_NS}shotsNote`,
} as const;

/** The legacy TestWorkflow predicates (the ones scripts/lib/test-workflow.ts always read). */
export const L = {
  TestWorkflow: `${KTYPE}TestWorkflow`,
  TestStep: `${KTYPE}TestStep`,
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
  /** Recorder predicates (the demo narration plan); read when present. */
  narration: `${KPRED}narration`,
  narrationLead: `${KPRED}narration-lead`,
  narrationStoryline: `${KPRED}narration-storyline`,
  narrator: `${KPRED}narrator`,
} as const;

// ── typed shapes ─────────────────────────────────────────────────────────────

export type Param = string | number | boolean;

export type StepAction =
  | { kind: 'open-page'; path: string }
  | { kind: 'select'; entities: string[] }
  | { kind: 'click'; target: string }
  | { kind: 'type'; target: string; text: string }
  /** Press one key (Escape, Enter, Tab, ArrowDown...), as a person closing a panel does. */
  | { kind: 'press'; key: string }
  /** A defined job kind with typed parameters (the F303 request rules): never a command. */
  | { kind: 'run-job'; job: string; params: Record<string, Param> };

export type StepExpect =
  | { kind: 'visible'; target: string }
  | { kind: 'count'; type: string; n: number }
  | { kind: 'standing'; subject: string; predicate: string; object: string; status?: string }
  /** The element with this test id shows this text. */
  | { kind: 'text'; target: string; contains: string }
  /** The element with this test id carries this attribute value (for example data-splat-status = ready). */
  | { kind: 'attr'; target: string; name: string; value: string }
  /** The generated file served for this asset is the one its receipt describes (SHA-256), its check accepted it and its models' licenses are open. */
  | { kind: 'receipt'; slug: string; stage: 'image' | 'video' | 'splat' }
  /** The picture or clip with this test id has loaded and is this many pixels wide. */
  | { kind: 'media'; target: string; width: number }
  /** n elements carry this test id, optionally only those whose attribute `attr` is `is`. */
  | { kind: 'elements'; target: string; n: number; attr?: string; is?: string }
  /** Plain words a human judges; what a legacy kpred:assertion becomes. Not machine-checkable. */
  | { kind: 'note'; text: string };

/** A region of the screen: a stable reference (a test id, or plain words for a legacy step) and a short label. */
export interface StepTarget { ref: string; label: string }

export interface Refusal { predicate: string; value: string; reason: string }

export interface UnifiedStep {
  iri: string;
  /** Stable key (kpred:step-id / story:stepId); falls back to the IRI's local name. */
  id: string;
  order: number;
  title: string;
  shortLabel: string;
  pageName: string;
  /** SAID: story:content (legacy kpred:narration, else the step's skos:definition). */
  content: string;
  /** Legacy only: the step's skos:definition, which is what the docs page prints. */
  detail: string;
  /** SAID: the lead-in question (story:question, legacy kpred:narration-lead). */
  question?: string;
  prompt?: string;
  /** SHOWN */
  target?: StepTarget;
  /** The element to point at while the line plays, by data-testid. On a legacy step it is the optional story:target beside the box-target words. */
  focus?: StepTarget;
  openPage?: string;
  /** The app route the step happens on (story:page, F300.5); legacy steps keep theirs in openPage. */
  route?: string;
  /** In plain words, what the highlight box sits on (story:boxTarget). A legacy step keeps it in target.ref. */
  boxTarget?: string;
  layout?: string;
  /** Filter names the step wants active (story:filter, repeatable); raw strings, validated at use like layout. */
  filters?: string[];
  highlights: string[];
  /** One-click offers in authored order (raw; story-offers.ts applies its allowlist). */
  offers: { kind: 'setting' | 'page'; value: string }[];
  /** HAPPENS */
  actions: StepAction[];
  /** TRUE */
  expects: StepExpect[];
  /** NEEDS: capability terms (F269). */
  needs: string[];
  /** RECORDED: the step's screenshot or clip, written by the recorder. */
  media: string | null;
  refusals: Refusal[];
}

export interface UnifiedStory {
  origin: 'story' | 'test-workflow';
  iri: string;
  id: string;
  label: string;
  description: string;
  storyline?: string;
  narrator?: string;
  autoplay: boolean;
  pace: number;
  interaction?: string;
  /** Legacy only: the test file that plays it, and the note on how its shots were made. */
  testFile?: string;
  shotsNote: string;
  steps: UnifiedStep[];
}

export interface ReadOptions {
  /** Throw on the first structural problem (a missing required legacy field), as the legacy loader always did. */
  strict?: boolean;
}

// ── action / expect parsing ──────────────────────────────────────────────────

const IN_APP_PATH = /^\/(?![/\\])[\w\-/?=&.%]*$/;
const JOB_KIND = /^[a-z][a-z0-9-]*$/;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Parse one story:action literal. Returns the action, or the reason it is refused. */
export function parseAction(raw: string): { ok: true; action: StepAction } | { ok: false; reason: string } {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { ok: false, reason: 'not JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: 'not a JSON object' };
  const o = j as Record<string, unknown>;
  switch (o.kind) {
    case 'open-page':
      return nonEmpty(o.path) && IN_APP_PATH.test(o.path)
        ? { ok: true, action: { kind: 'open-page', path: o.path } }
        : { ok: false, reason: 'open-page needs an in-app path' };
    case 'select':
      return Array.isArray(o.entities) && o.entities.length > 0 && o.entities.every(nonEmpty)
        ? { ok: true, action: { kind: 'select', entities: o.entities as string[] } }
        : { ok: false, reason: 'select needs a non-empty list of entity IRIs' };
    case 'click':
      return nonEmpty(o.target) ? { ok: true, action: { kind: 'click', target: o.target } } : { ok: false, reason: 'click needs a target' };
    case 'type':
      return nonEmpty(o.target) && typeof o.text === 'string'
        ? { ok: true, action: { kind: 'type', target: o.target, text: o.text } }
        : { ok: false, reason: 'type needs a target and text' };
    case 'press':
      return nonEmpty(o.key) && /^[A-Za-z0-9]{1,12}$/.test(o.key) ? { ok: true, action: { kind: 'press', key: o.key } } : { ok: false, reason: 'press needs one key name (Escape, Enter, Tab...)' };
    case 'run-job': {
      if (!nonEmpty(o.job) || !JOB_KIND.test(o.job)) return { ok: false, reason: 'run-job needs a job kind name (lowercase letters, digits, hyphens)' };
      if ('command' in o || 'cmd' in o || 'args' in o) return { ok: false, reason: 'run-job never takes a command; name a defined job kind and typed params' };
      const p = o.params ?? {};
      if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'run-job params must be an object' };
      for (const [k, v] of Object.entries(p)) {
        if (!['string', 'number', 'boolean'].includes(typeof v)) return { ok: false, reason: `run-job param "${k}" must be a string, number or boolean` };
      }
      return { ok: true, action: { kind: 'run-job', job: o.job, params: p as Record<string, Param> } };
    }
    default:
      return { ok: false, reason: `unknown action kind ${JSON.stringify(o.kind ?? null)}` };
  }
}

/** Parse one story:expect literal. Returns the expectation, or the reason it is refused. */
export function parseExpect(raw: string): { ok: true; expect: StepExpect } | { ok: false; reason: string } {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { ok: false, reason: 'not JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: 'not a JSON object' };
  const o = j as Record<string, unknown>;
  switch (o.kind) {
    case 'visible':
      return nonEmpty(o.target) ? { ok: true, expect: { kind: 'visible', target: o.target } } : { ok: false, reason: 'visible needs a target' };
    case 'count':
      return nonEmpty(o.type) && Number.isInteger(o.n) && (o.n as number) >= 0
        ? { ok: true, expect: { kind: 'count', type: o.type, n: o.n as number } }
        : { ok: false, reason: 'count needs a type and a non-negative whole number n' };
    case 'standing':
      return nonEmpty(o.subject) && nonEmpty(o.predicate) && nonEmpty(o.object)
        ? { ok: true, expect: { kind: 'standing', subject: o.subject, predicate: o.predicate, object: o.object, ...(nonEmpty(o.status) ? { status: o.status } : {}) } }
        : { ok: false, reason: 'standing needs subject, predicate and object' };
    case 'text':
      return nonEmpty(o.target) && nonEmpty(o.contains) ? { ok: true, expect: { kind: 'text', target: o.target, contains: o.contains } } : { ok: false, reason: 'text needs a target and the words it contains' };
    case 'attr':
      return nonEmpty(o.target) && nonEmpty(o.name) && typeof o.value === 'string'
        ? { ok: true, expect: { kind: 'attr', target: o.target, name: o.name, value: o.value } }
        : { ok: false, reason: 'attr needs a target, an attribute name and a value' };
    case 'elements':
      if (!(nonEmpty(o.target) && Number.isInteger(o.n) && (o.n as number) >= 0)) return { ok: false, reason: 'elements needs a target and a non-negative whole number n' };
      if ((o.attr === undefined) !== (o.is === undefined) || (o.attr !== undefined && !(nonEmpty(o.attr) && typeof o.is === 'string'))) return { ok: false, reason: 'elements takes attr and is together' };
      return { ok: true, expect: { kind: 'elements', target: o.target, n: o.n as number, ...(o.attr !== undefined ? { attr: o.attr as string, is: o.is as string } : {}) } };
    case 'receipt':
      return nonEmpty(o.slug) && ['image', 'video', 'splat'].includes(o.stage as string)
        ? { ok: true, expect: { kind: 'receipt', slug: o.slug, stage: o.stage as 'image' | 'video' | 'splat' } }
        : { ok: false, reason: 'receipt needs a slug and a stage (image, video or splat)' };
    case 'media':
      return nonEmpty(o.target) && Number.isInteger(o.width) && (o.width as number) > 0
        ? { ok: true, expect: { kind: 'media', target: o.target, width: o.width as number } }
        : { ok: false, reason: 'media needs a target and a width in pixels' };
    case 'note':
      return nonEmpty(o.text) ? { ok: true, expect: { kind: 'note', text: o.text } } : { ok: false, reason: 'note needs text' };
    default:
      return { ok: false, reason: `unknown expect kind ${JSON.stringify(o.kind ?? null)}` };
  }
}

/** A story:target literal is "ref" or "ref :: short label". */
export function parseTarget(raw: string): StepTarget {
  const i = raw.indexOf('::');
  return i < 0 ? { ref: raw.trim(), label: '' } : { ref: raw.slice(0, i).trim(), label: raw.slice(i + 2).trim() };
}

// ── the reader ───────────────────────────────────────────────────────────────

/** Read every story in these quads: story:Story resources and legacy ktype:TestWorkflow resources. */
export function readStoryQuads(quads: Iterable<QuadLike>, opts: ReadOptions = {}): UnifiedStory[] {
  const bySubject = new Map<string, QuadLike[]>();
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const arr = bySubject.get(q.subject.value) ?? [];
    arr.push(q);
    bySubject.set(q.subject.value, arr);
  }
  const lits = (iri: string, p: string): string[] =>
    (bySubject.get(iri) ?? []).filter((q) => q.predicate.value === p && q.object.termType === 'Literal').map((q) => q.object.value);
  const lit = (iri: string, p: string): string | null => lits(iri, p)[0] ?? null;
  const iris = (iri: string, p: string): string[] =>
    (bySubject.get(iri) ?? []).filter((q) => q.predicate.value === p && q.object.termType === 'NamedNode').map((q) => q.object.value);
  const isType = (iri: string, ...types: string[]) =>
    !!bySubject.get(iri)?.some((q) => q.predicate.value === RDF_TYPE && types.includes(q.object.value));
  const linksTo = (iri: string, p: string, target: string) =>
    !!bySubject.get(iri)?.some((q) => q.predicate.value === p && q.object.termType === 'NamedNode' && q.object.value === target);
  const local = (iri: string) => iri.split('/').pop() ?? iri;

  const problem = (msg: string, sink: string[]): void => {
    if (opts.strict) throw new Error(msg);
    sink.push(msg);
  };
  const problems: string[] = [];
  const need = (iri: string, p: string, what: string): string => {
    const v = lit(iri, p);
    if (v === null || v.trim() === '') { problem(`<${iri}> has no ${what}`, problems); return ''; }
    return v;
  };

  /** Fields shared by both forms: actions, expectations, needs, highlights. */
  const common = (iri: string) => {
    const refusals: Refusal[] = [];
    const actions: StepAction[] = [];
    // A space's own file may be re-serialized (the Getting started space is regenerated from its parts), and a
    // serializer keeps no order among the values of one predicate. An action may therefore carry `"at": n` (its
    // 1-based place in the step); when any does, they are played in that order.
    const placed: { at: number; i: number; action: StepAction }[] = [];
    let anyAt = false;
    for (const raw of lits(iri, S.action)) {
      const r = parseAction(raw);
      if (!r.ok) { refusals.push({ predicate: S.action, value: raw, reason: r.reason }); continue; }
      let at = Number.MAX_SAFE_INTEGER;
      try { const n = (JSON.parse(raw) as { at?: unknown }).at; if (typeof n === 'number' && Number.isFinite(n)) { at = n; anyAt = true; } } catch { /* parseAction already accepted it */ }
      placed.push({ at, i: placed.length, action: r.action });
    }
    if (anyAt) placed.sort((a, b) => a.at - b.at || a.i - b.i);
    for (const p of placed) actions.push(p.action);
    const expects: StepExpect[] = [];
    for (const raw of lits(iri, S.expect)) {
      const r = parseExpect(raw);
      if (r.ok) expects.push(r.expect); else refusals.push({ predicate: S.expect, value: raw, reason: r.reason });
    }
    const needs = [...lits(iri, S.needs).map((s) => s.trim()), ...iris(iri, S.needs)].filter((s) => s !== '');
    return { refusals, actions, expects, needs, highlights: iris(iri, S.highlight) };
  };

  const stories: UnifiedStory[] = [];

  // ── story:Story resources ──
  for (const iri of bySubject.keys()) {
    if (!isType(iri, S.Story, 'Story')) continue;
    const steps: UnifiedStep[] = [];
    for (const sIri of bySubject.keys()) {
      if (!linksTo(sIri, S.partOf, iri)) continue;
      const tgt = lit(sIri, S.target);
      const offers = (bySubject.get(sIri) ?? [])
        .filter((q) => q.object.termType === 'Literal' && (q.predicate.value === S.offerSetting || q.predicate.value === S.openPage))
        .map((q) => ({ kind: q.predicate.value === S.offerSetting ? 'setting' as const : 'page' as const, value: q.object.value }));
      const title = lit(sIri, S.title) ?? lit(sIri, RDFS_LABEL) ?? 'Step';
      // PARSE PERMISSIVELY, like story:layout: the values stay raw strings — a story may name filters
      // this build does not know, so the check belongs at use (TurtleChatPanel), where an unknown name
      // is dropped rather than throwing. Absent stays undefined (a step with no story:filter names none).
      const rawFilters = lits(sIri, S.filter).map((s) => s.trim()).filter((s) => s !== '');
      steps.push({
        iri: sIri,
        id: lit(sIri, S.stepId) ?? local(sIri),
        order: parseInt(lit(sIri, S.order) ?? '0', 10),
        title,
        shortLabel: lit(sIri, S.shortLabel) ?? title,
        pageName: lit(sIri, S.pageName) ?? '',
        content: lit(sIri, S.content) ?? '',
        detail: lit(sIri, S.detail) ?? '',
        route: lit(sIri, S.route) ?? undefined,
        boxTarget: lit(sIri, S.boxTarget) ?? undefined,
        question: lit(sIri, S.question) ?? undefined,
        prompt: lit(sIri, S.prompt) ?? undefined,
        target: tgt === null ? undefined : parseTarget(tgt),
        focus: tgt === null ? undefined : parseTarget(tgt),
        openPage: offers.find((o) => o.kind === 'page')?.value,
        layout: lit(sIri, S.layout) ?? undefined,
        filters: rawFilters.length > 0 ? rawFilters : undefined,
        offers,
        media: lit(sIri, S.media),
        ...(() => {
          const c = common(sIri);
          const note = lit(sIri, S.assertion);
          return { ...c, expects: [...(note ? [{ kind: 'note', text: note } as StepExpect] : []), ...c.expects] };
        })(),
      });
    }
    steps.sort((a, b) => a.order - b.order);
    stories.push({
      origin: 'story', iri, id: local(iri),
      label: lit(iri, RDFS_LABEL) ?? lit(iri, S.title) ?? local(iri) ?? 'Untitled Story',
      description: lit(iri, S.description) ?? '',
      storyline: lit(iri, S.storyline) ?? undefined,
      narrator: lit(iri, S.narrator) ?? undefined,
      autoplay: lit(iri, S.autoplay) === 'true',
      pace: parseInt(lit(iri, S.pace) ?? '8', 10),
      interaction: lit(iri, S.interaction) ?? undefined,
      shotsNote: lit(iri, S.shotsNote) ?? '',
      steps,
    });
  }

  // ── legacy ktype:TestWorkflow ──
  for (const iri of bySubject.keys()) {
    if (!isType(iri, L.TestWorkflow)) continue;
    const steps: UnifiedStep[] = [];
    for (const sIri of bySubject.keys()) {
      if (!isType(sIri, L.TestStep) || !linksTo(sIri, L.partOf, iri)) continue;
      const order = parseInt(need(sIri, L.stepOrder, 'kpred:step-order'), 10);
      if (!Number.isFinite(order)) problem(`<${sIri}> has a non-numeric kpred:step-order`, problems);
      const title = need(sIri, RDFS_LABEL, 'rdfs:label');
      const stepId = need(sIri, L.stepId, 'kpred:step-id');
      const detail = need(sIri, SKOS_DEFINITION, 'skos:definition');
      const page = need(sIri, L.page, 'kpred:page');
      const assertion = need(sIri, L.assertion, 'kpred:assertion');
      const target = need(sIri, L.boxTarget, 'kpred:box-target');
      const pageName = need(sIri, L.pageName, 'kpred:page-name');
      const c = common(sIri);
      steps.push({
        iri: sIri,
        id: stepId,
        order,
        title,
        shortLabel: lit(sIri, L.shortLabel) ?? title,
        pageName,
        content: lit(sIri, L.narration) ?? detail,
        detail,
        question: lit(sIri, L.narrationLead) ?? undefined,
        target: { ref: target, label: lit(sIri, L.boxLabel) ?? title },
        focus: lit(sIri, S.target) === null ? undefined : parseTarget(lit(sIri, S.target) as string),
        openPage: page,
        highlights: c.highlights,
        offers: [],
        actions: c.actions,
        expects: [...(assertion ? [{ kind: 'note', text: assertion } as StepExpect] : []), ...c.expects],
        needs: c.needs,
        media: lit(sIri, L.screenshot),
        refusals: c.refusals,
      });
    }
    steps.sort((a, b) => a.order - b.order);
    const orders = steps.map((s) => s.order);
    if (new Set(orders).size !== orders.length) problem(`<${iri}> has two steps with the same kpred:step-order`, problems);
    const ids = steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) problem(`<${iri}> has two steps with the same kpred:step-id`, problems);
    stories.push({
      origin: 'test-workflow', iri,
      id: need(iri, L.workflowId, 'kpred:workflow-id'),
      label: need(iri, RDFS_LABEL, 'rdfs:label'),
      description: lit(iri, SKOS_DEFINITION) ?? '',
      storyline: lit(iri, L.narrationStoryline) ?? undefined,
      narrator: lit(iri, L.narrator) ?? undefined,
      autoplay: false,
      pace: 8,
      testFile: need(iri, L.testFile, 'kpred:test-file'),
      shotsNote: lit(iri, L.shotsNote) ?? '',
      steps,
    });
  }
  return stories;
}

/** Every refusal across these stories, for a caller (a test, the lint) that must fail on any. */
export function allRefusals(stories: UnifiedStory[]): { story: string; step: string; refusal: Refusal }[] {
  return stories.flatMap((st) => st.steps.flatMap((s) => s.refusals.map((refusal) => ({ story: st.iri, step: s.iri, refusal }))));
}
