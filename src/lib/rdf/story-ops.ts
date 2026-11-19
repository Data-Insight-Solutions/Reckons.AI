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
 *   - A page that cannot perform an operation (for example `run-job`, or `standing` with no probe
 *     for the data) says so by name; it never reports success it did not check.
 * Targets are stable data-testid references (StepTarget.ref). A target that is not one (a legacy
 * step's plain words) is refused as a target, not guessed at.
 */
import type { StepAction, StepExpect } from './story-steps';

/** What the runner needs from a page. The Playwright adapter in tests/e2e/story-runner.ts implements it. */
export interface StoryPage {
  goto(path: string): Promise<void>;
  /** Click the element with this data-testid. */
  click(testId: string): Promise<void>;
  /** Clear it, then type into the element with this data-testid. */
  fill(testId: string, text: string): Promise<void>;
  /** Find an entity the way a person does (search, then pick) and select it. */
  selectEntity(iri: string): Promise<void>;
  /** Throws unless the element with this data-testid is visible. */
  expectVisible(testId: string): Promise<void>;
  /** How many entities of a type are open; absent when the page has no probe. */
  countEntities?(type: string): Promise<number>;
  /** Whether a statement stands in the open data; absent when the page has no probe. */
  hasStanding?(s: { subject: string; predicate: string; object: string; status?: string }): Promise<boolean>;
}

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
    case 'select':
      for (const e of action.entities) await page.selectEntity(e);
      return;
    case 'run-job':
      // No page operation exists for a job: a story that needs one is played by the app's player (F300.2),
      // and silently skipping it here would let a test pass over a step it never ran.
      throw new StoryStepError('run-job', `the page runner cannot start the job "${action.job}"; no operation exists for it yet`);
    default:
      throw new StoryStepError(a.kind ?? 'undefined', `unknown action kind "${a.kind}"; nothing performs it`);
  }
}

/** What a check did: 'checked' passed against the page; 'human' is a note no machine judges (named, never silent). */
export type CheckResult = { kind: string; status: 'checked' | 'human'; text?: string };

/** Check one expectation. A false expectation, an unknown kind or a missing probe throws StoryStepError. */
export async function checkExpect(page: StoryPage, expect: StepExpect): Promise<CheckResult> {
  const e = expect as { kind: string };
  switch (expect.kind) {
    case 'visible':
      try { await page.expectVisible(testIdOf(expect.target, 'visible')); }
      catch (err) {
        if (err instanceof StoryStepError) throw err;
        throw new StoryStepError('visible', `"${expect.target}" is not visible (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      }
      return { kind: 'visible', status: 'checked' };
    case 'count': {
      if (!page.countEntities) throw new StoryStepError('count', 'this page has no way to count entities yet');
      const n = await page.countEntities(expect.type);
      if (n !== expect.n) throw new StoryStepError('count', `expected ${expect.n} of ${expect.type}, found ${n}`);
      return { kind: 'count', status: 'checked' };
    }
    case 'standing': {
      if (!page.hasStanding) throw new StoryStepError('standing', 'this page has no way to look up a statement yet');
      if (!(await page.hasStanding(expect))) throw new StoryStepError('standing', `${expect.subject} ${expect.predicate} ${expect.object} does not stand`);
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
