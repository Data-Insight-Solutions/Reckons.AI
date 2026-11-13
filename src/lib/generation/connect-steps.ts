/**
 * The state of the local generation runner connect popup (F166.1.3), as one pure function so the
 * wording and the step logic are testable without a browser. The inputs are what the shared store
 * already exposes; nothing here connects, polls or writes anything.
 */
export type ConnectInputs = {
  supported: boolean;
  workspace: 'none' | 'disconnected' | 'connected';
  connecting: boolean;
  /** True once the runner's heartbeat has been read from the chosen folder. */
  runnerReady: boolean;
  error: string;
  /** The dev-server bridge: can the page start the runner, and is one running? Omitted = not checked. */
  bridge?: { available: boolean; running: boolean };
};
export type ConnectStatus = 'unsupported' | 'need-folder' | 'checking' | 'waiting' | 'failed' | 'connected';
export type StepState = 'todo' | 'active' | 'done';
export type ConnectView = {
  status: ConnectStatus;
  /** Step 1 is advice only: the page cannot see whether a terminal is open, so it never reads "done" on its own. */
  steps: { start: StepState; folder: StepState; check: StepState };
  /** How step 1 is offered: the page can start it, it is already running, or the person starts it once in a terminal. */
  start: 'running' | 'button' | 'command';
  message: string;
  fix: string;
};

export const RUNNER_COMMAND = 'npm run gen:serve -- --workspace=/path/to/workspace';

/** Turn the store's error text into plain words and one thing to try. */
export function explainConnectError(raw: string): { message: string; fix: string } {
  const text = raw.trim();
  if (/original generation workspace|identity changed|folder changed/i.test(text)) {
    return { message: 'This is a different folder from the one these jobs were started with.', fix: 'Choose the original workspace folder again.' };
  }
  if (/permission|denied|NotAllowed/i.test(text)) {
    return { message: 'The browser was not allowed to read that folder.', fix: 'Choose the folder again and allow access when the browser asks.' };
  }
  if (/capabilities|heartbeat|not found|NotFound|no runner|stale/i.test(text)) {
    return { message: 'The runner has not written to this folder yet, or has stopped.', fix: 'Check that the runner from step 1 is running and uses this same folder.' };
  }
  return { message: text || 'The runner could not be reached.', fix: 'Check that the command in step 1 is running, then choose Check again.' };
}

export function connectView(i: ConnectInputs): ConnectView {
  const v = baseView(i);
  const running = i.runnerReady || !!i.bridge?.running;
  const start = running ? 'running' : i.bridge?.available ? 'button' : 'command';
  // A runner that is already running makes step 1 done; it is skipped, not asked for again.
  const steps = running && v.steps.start === 'active' ? { ...v.steps, start: 'done' as const } : v.steps;
  return { ...v, steps, start };
}

function baseView(i: ConnectInputs): Omit<ConnectView, 'start'> {
  const base = { message: '', fix: '' };
  if (i.runnerReady) return { ...base, status: 'connected', steps: { start: 'done', folder: 'done', check: 'done' }, message: 'Connected. The runner is answering.' };
  if (!i.supported) return { ...base, status: 'unsupported', steps: { start: 'active', folder: 'todo', check: 'todo' }, message: 'This browser cannot open a workspace folder.', fix: 'Use desktop Chrome or Edge to connect the runner.' };
  const folderDone = i.workspace === 'connected';
  if (!folderDone) {
    // The store's own prompt to pick a folder is not a failure; it is what step 2 already says.
    const failed = i.error && !/connect your workspace folder/i.test(i.error) ? explainConnectError(i.error) : null;
    return { ...base, ...failed, status: failed ? 'failed' : 'need-folder', steps: { start: 'active', folder: 'active', check: 'todo' }, message: failed?.message ?? 'Choose the workspace folder the runner is using.' };
  }
  if (i.connecting) return { ...base, status: 'checking', steps: { start: 'done', folder: 'done', check: 'active' }, message: 'Checking for the runner…' };
  if (i.error) return { status: 'failed', steps: { start: 'active', folder: 'done', check: 'active' }, ...explainConnectError(i.error) };
  return { status: 'waiting', steps: { start: 'active', folder: 'done', check: 'active' }, message: 'Folder chosen. Waiting for the runner to answer.', fix: 'Check that the runner from step 1 is running and uses this same folder.' };
}
