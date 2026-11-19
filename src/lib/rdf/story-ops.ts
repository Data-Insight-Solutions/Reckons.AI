/**
 * THE STORY RUNNER'S OPERATIONS (F300.3, kb:story-recorder). Pure: no browser, no filesystem.
 *
 * One runner plays a story: for each step it performs the step's actions and checks every
 * expectation (tests/e2e/story-runner.ts). The e2e test and the demo recorder are that same runner
 * with recording off or on, so a video cannot show a step the test did not pass.
 *
 * This module maps each StepAction kind to an operation on a small `StoryPage`, and each StepExpect
 * kind to a check, so it runs in a unit test against a fake page. Two rules:
 *   - An unknown kind fails loudly BY NAME. Nothing is skipped silently.
 *   - A page that cannot perform an operation (a `run-job` with no runner connected, or `standing` with
 *     no probe for the data) says so by name; it never reports success it did not check.
 *   - `run-job` is never a command: only a job kind in JOB_KINDS, with exactly its typed parameters.
 * The data probes (count, standing) are pure functions over the rows a page reports (countEntitiesIn,
 * standsIn). A check on the page itself (text, attr, elements, media, receipt, count, standing) retries
 * for the page's `patience` before it fails, because a page settles; the last failure is the one named.
 * Targets are stable data-testid references (StepTarget.ref). A target that is not one (a legacy
 * step's plain words) is refused as a target, not guessed at.
 */
import type { Param, StepAction, StepExpect } from './story-steps';

/** What the runner needs from a page. The Playwright adapter in tests/e2e/story-runner.ts implements it. */
export interface StoryPage {
  goto(path: string): Promise<void>;
  /** Click the element with this data-testid. */
  click(testId: string): Promise<void>;
  /** Clear it, then type into the element with this data-testid. */
  fill(testId: string, text: string): Promise<void>;
  /** Press one key. */
  press(key: string): Promise<void>;
  /** Find an entity the way a person does (search, then pick) and select it. */
  selectEntity(iri: string): Promise<void>;
  /** Throws unless the element with this data-testid is visible. */
  expectVisible(testId: string): Promise<void>;
  /** The statements of the open data, flattened; absent when the page has no probe (count and standing then fail by name). */
  statementRows?(): Promise<StatementRow[]>;
  /** The visible text of the element with this data-testid. */
  textOf?(testId: string): Promise<string>;
  /** An attribute of the element with this data-testid, or null when absent. */
  attrOf?(testId: string, name: string): Promise<string | null>;
  /** How many elements carry this data-testid, optionally only those whose attribute `attr` equals `is`. */
  countElements?(testId: string, where?: { attr: string; is: string }): Promise<number>;
  /** Pixel width of the loaded picture or clip with this data-testid; 0 while it has not loaded. */
  mediaWidth?(testId: string): Promise<number>;
  /** Whether the served file of a generated asset matches its receipt. */
  receiptOf?(slug: string, stage: JobStage): Promise<ReceiptCheck>;
  /** How long (ms) a check waits for the page to settle on the expected value before it fails; absent or 0 checks once. */
  patience?: number;
  /** Run one defined job (a stage of the generation queue) with typed parameters, as a person's click would. */
  runJob?(stage: JobStage, params: Record<string, Param>): Promise<void>;
}

export interface ReceiptCheck { generated: boolean; accepted: boolean; matches: boolean; licenses: string[] }

/** A statement as the probes see it: plain strings, no storage types. */
export interface StatementRow { s: string; p: string; o: string; status: string; needsObject?: boolean; proposalOption?: string }

/** A step that did not do or hold what the story says. `kind` names the action or expectation. */
export class StoryStepError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(`${kind}: ${message}`);
    this.name = 'StoryStepError';
  }
}

const TESTID = /^[A-Za-z][\w:.-]*$/;

/** A target must be a data-testid reference. Plain words (a legacy step's description) are refused. */
export function testIdOf(ref: string, what: string): string {
  if (!TESTID.test(ref)) throw new StoryStepError(what, `target "${ref}" is not a data-testid reference (letters, digits, - _ : .)`);
  return ref;
}

export type JobStage = 'image' | 'video' | 'splat';

/** The job kinds a story may start: each is one stage of the generation queue (src/lib/generation/protocol.ts) and its typed parameters. */
export const JOB_KINDS: Record<string, { stage: JobStage; params: Record<string, 'string' | 'number' | 'boolean'> }> = {
  'generate-image': { stage: 'image', params: { prompt: 'string' } },
  'generate-video': { stage: 'video', params: { motion: 'string' } },
  'generate-splat': { stage: 'splat', params: {} },
};

/** Perform one action. Throws StoryStepError for an unknown kind or an operation the page cannot do. */
export async function performAction(page: StoryPage, action: StepAction): Promise<void> {
  const a = action as { kind: string };
  switch (action.kind) {
    case 'open-page':
      return page.goto(action.path);
    case 'click':
      return page.click(testIdOf(action.target, 'click'));
    case 'type':
      return page.fill(testIdOf(action.target, 'type'), action.text);
    case 'press':
      return page.press(action.key);
    case 'select':
      for (const e of action.entities) await page.selectEntity(e);
      return;
    case 'run-job': {
      // Never a command: only a job kind listed in JOB_KINDS, with exactly its typed parameters. A story is
      // data and can arrive from anyone (the F303 request rules), so an unlisted name or an extra key is refused.
      const def = JOB_KINDS[action.job];
      if (!def) throw new StoryStepError('run-job', `"${action.job}" is not a defined job kind (${Object.keys(JOB_KINDS).join(', ')})`);
      for (const k of Object.keys(action.params)) if (!(k in def.params)) throw new StoryStepError('run-job', `"${action.job}" takes no parameter "${k}"`);
      for (const [k, type] of Object.entries(def.params)) {
        if (!(k in action.params)) throw new StoryStepError('run-job', `"${action.job}" needs the parameter "${k}"`);
        if (typeof action.params[k] !== type) throw new StoryStepError('run-job', `parameter "${k}" of "${action.job}" must be a ${type}`);
      }
      if (!page.runJob) throw new StoryStepError('run-job', `this page cannot start "${action.job}"; no job runner is connected`);
      return page.runJob(def.stage, action.params);
    }
    default:
      throw new StoryStepError(a.kind ?? 'undefined', `unknown action kind "${a.kind}"; nothing performs it`);
  }
}

/** What a check did: 'checked' passed against the page; 'human' is a note no machine judges (named, never silent). */
export type CheckResult = { kind: string; status: 'checked' | 'human'; text?: string };

/** Run a check until it passes or the page's patience runs out; the last failure is the one reported. */
async function settle<T>(page: StoryPage, check: () => Promise<T>): Promise<T> {
  const until = Date.now() + (page.patience ?? 0);
  for (;;) {
    try { return await check(); }
    catch (err) {
      if (Date.now() >= until) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Check one expectation. A false expectation, an unknown kind or a missing probe throws StoryStepError. */
export async function checkExpect(page: StoryPage, expect: StepExpect): Promise<CheckResult> {
  const e = expect as { kind: string };
  if (expect.kind === 'visible' || expect.kind === 'note') return checkOnce(page, expect);
  if (!['text', 'attr', 'elements', 'media', 'receipt', 'count', 'standing'].includes(expect.kind)) return checkOnce(page, expect);
  return settle(page, () => checkOnce(page, expect));
}

async function checkOnce(page: StoryPage, expect: StepExpect): Promise<CheckResult> {
  const e = expect as { kind: string };
  switch (expect.kind) {
    case 'visible':
      try { await page.expectVisible(testIdOf(expect.target, 'visible')); }
      catch (err) {
        if (err instanceof StoryStepError) throw err;
        throw new StoryStepError('visible', `"${expect.target}" is not visible (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      }
      return { kind: 'visible', status: 'checked' };
    case 'text': {
      if (!page.textOf) throw new StoryStepError('text', 'this page cannot read the text of an element');
      const t = await page.textOf(testIdOf(expect.target, 'text'));
      if (!t.includes(expect.contains)) throw new StoryStepError('text', `"${expect.target}" does not contain "${expect.contains}" (it shows "${t.slice(0, 80)}")`);
      return { kind: 'text', status: 'checked' };
    }
    case 'attr': {
      if (!page.attrOf) throw new StoryStepError('attr', 'this page cannot read the attribute of an element');
      const v = await page.attrOf(testIdOf(expect.target, 'attr'), expect.name);
      if (v !== expect.value) throw new StoryStepError('attr', `"${expect.target}" ${expect.name} is ${v === null ? 'absent' : `"${v}"`}, expected "${expect.value}"`);
      return { kind: 'attr', status: 'checked' };
    }
    case 'elements': {
      if (!page.countElements) throw new StoryStepError('elements', 'this page cannot count elements');
      const where = expect.attr !== undefined ? { attr: expect.attr, is: expect.is as string } : undefined;
      const n = await page.countElements(testIdOf(expect.target, 'elements'), where);
      if (n !== expect.n) throw new StoryStepError('elements', `expected ${expect.n} of "${expect.target}"${where ? ` with ${where.attr}="${where.is}"` : ''}, found ${n}`);
      return { kind: 'elements', status: 'checked' };
    }
    case 'media': {
      if (!page.mediaWidth) throw new StoryStepError('media', 'this page cannot measure a picture or clip');
      const w = await page.mediaWidth(testIdOf(expect.target, 'media'));
      if (w !== expect.width) throw new StoryStepError('media', `"${expect.target}" is ${w} pixels wide, expected ${expect.width}`);
      return { kind: 'media', status: 'checked' };
    }
    case 'receipt': {
      if (!page.receiptOf) throw new StoryStepError('receipt', 'this page cannot read a receipt');
      const r = await page.receiptOf(expect.slug, expect.stage);
      if (!r.generated) throw new StoryStepError('receipt', `the receipt of ${expect.slug} does not mark the asset as generated`);
      if (!r.accepted) throw new StoryStepError('receipt', `the ${expect.stage} check of ${expect.slug} did not accept it`);
      if (!r.matches) throw new StoryStepError('receipt', `the served ${expect.stage} of ${expect.slug} is not the file its receipt describes`);
      for (const l of r.licenses) if (!/^(MIT|Apache-2\.0)$/.test(l)) throw new StoryStepError('receipt', `license "${l}" of ${expect.slug} is not MIT or Apache-2.0`);
      return { kind: 'receipt', status: 'checked' };
    }
    case 'count': {
      if (!page.statementRows) throw new StoryStepError('count', 'this page has no way to count entities yet');
      const n = countEntitiesIn(await page.statementRows(), expect.type);
      if (n !== expect.n) throw new StoryStepError('count', `expected ${expect.n} of ${expect.type}, found ${n}`);
      return { kind: 'count', status: 'checked' };
    }
    case 'standing': {
      if (!page.statementRows) throw new StoryStepError('standing', 'this page has no way to look up a statement yet');
      if (!standsIn(await page.statementRows(), expect)) {
        throw new StoryStepError('standing', `${expect.subject} ${expect.predicate} ${expect.object} does not stand${expect.status ? ` as ${expect.status}` : ''}`);
      }
      return { kind: 'standing', status: 'checked' };
    }
    case 'note':
      return { kind: 'note', status: 'human', text: expect.text };
    default:
      throw new StoryStepError(e.kind ?? 'undefined', `unknown expectation kind "${e.kind}"; nothing checks it`);
  }
}

/** Check every expectation in order; the first failure throws. */
export async function checkAll(page: StoryPage, expects: StepExpect[]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const e of expects) out.push(await checkExpect(page, e));
  return out;
}

// ── the data probes: pure functions over the rows a page reports ──────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/** A story names a term in full or by its last segment (`urn:kbase:concept/x` or `x`). */
const sameTerm = (value: string, want: string) => value === want || value.endsWith('/' + want) || value.endsWith('#' + want) || value.endsWith(':' + want);

/** What a statement counts as. `held` is confirmed or refined; `proposed` is pending and part of a proposal option; `question` has an open object. */
export type Standing = 'held' | 'pending' | 'proposed' | 'question' | 'superseded' | 'rejected';
const STANDINGS: Standing[] = ['held', 'pending', 'proposed', 'question', 'superseded', 'rejected'];

export function standingOf(r: StatementRow): Standing[] {
  const out: Standing[] = [];
  if (r.status === 'confirmed' || r.status === 'refined') out.push('held');
  if (r.status === 'pending') out.push(r.proposalOption ? 'proposed' : 'pending');
  if (r.status === 'pending' && r.proposalOption) out.push('pending');
  if (r.needsObject) out.push('question');
  if (r.status === 'superseded') out.push('superseded');
  if (r.status === 'rejected') out.push('rejected');
  return out;
}

/** Distinct subjects of a type, among statements that are held. */
export function countEntitiesIn(rows: StatementRow[], type: string): number {
  const subjects = new Set<string>();
  for (const r of rows) if (r.p === RDF_TYPE && sameTerm(r.o, type) && standingOf(r).includes('held')) subjects.add(r.s);
  return subjects.size;
}

/** True when a statement with this subject, predicate and object stands as `status` (default: held). */
export function standsIn(rows: StatementRow[], q: { subject: string; predicate: string; object: string; status?: string }): boolean {
  const want = (q.status ?? 'held') as Standing;
  if (!STANDINGS.includes(want)) throw new StoryStepError('standing', `unknown standing "${q.status}" (${STANDINGS.join(', ')})`);
  return rows.some((r) => sameTerm(r.s, q.subject) && sameTerm(r.p, q.predicate) && (r.o === q.object || sameTerm(r.o, q.object)) && standingOf(r).includes(want));
}
