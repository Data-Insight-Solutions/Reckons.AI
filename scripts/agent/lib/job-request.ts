/**
 * F74.14 — the pure half of the request file: validate a request against the DEFINED job kinds and
 * turn it into an argument list built from that kind's own template, never from request text.
 *
 * A request is the content of one file a writer (the app, or any device that shares the folder)
 * drops in the workspace's request area. It names a job kind from CHANNEL_JOBS and gives typed
 * parameters; it never carries a command. Done-test: a request naming an undefined kind is refused
 * with a reason, and no request text can reach a shell string or change the command.
 *
 * HOW THAT HOLDS (the draft this replaces used a forbidden-character list over free strings, which
 * is a blacklist; this is a whitelist):
 *   - the command (`argv`) belongs to the defined job and is fixed; a request supplies only values
 *     for the parameters that job declares, and each value is checked against its declared type;
 *   - there is no free-text parameter type: integers within bounds, booleans, one of a listed set
 *     of words, or a short lowercase word. None of those can contain a space, quote or metacharacter;
 *   - a parameter the job does not declare is refused, not ignored;
 *   - toArgv returns a LIST (`--flag=value` items appended to the template), and the host spawns
 *     that list without a shell, so even a value that slipped through could not be re-parsed.
 *
 * This module reads no files and runs nothing. The host (scripts/agent/space-channel.ts) calls
 * validateJobRequest, and only on `ok` builds the list with toArgv.
 *
 * WEAKNESS, said here: CHANNEL_JOBS is a table in this file, not derived from static/reckons-jobs.ttl,
 * because that file stores each command as a bash string, which cannot be safely templated. Adding a
 * kind is a code change that needs review, which is deliberate; it also means the two lists can drift.
 */

/** One typed parameter of a defined job kind. */
export type ParamSpec =
  | { type: 'int'; min: number; max: number; required?: boolean }
  | { type: 'bool' }
  | { type: 'enum'; values: readonly string[]; required?: boolean }
  | { type: 'word'; required?: boolean };

/** A job kind a request may name. */
export type ChannelJob = {
  /** What it does, one line, for the status view. */
  does: string;
  /** The fixed command. A request can add `--flag=value` items after it and change nothing else. */
  argv: readonly string[];
  /** Declared parameters: name -> its type. The flag is `--<name>`. */
  params: Readonly<Record<string, ParamSpec>>;
  /** Queue gating: false = script tier (no GPU, no Ollama). */
  gpu: boolean;
  ollama: boolean;
};

/** The job kinds the channel accepts. Script tier only: nothing here needs a model or a GPU. */
export const CHANNEL_JOBS: Readonly<Record<string, ChannelJob>> = {
  'graph-lint': {
    does: 'check the plan graphs parse and keep their invariants',
    argv: ['npx', 'tsx', 'scripts/offline/graph-lint.ts'],
    params: { pending: { type: 'bool' } },
    gpu: false,
    ollama: false,
  },
  'term-usage': {
    does: 'count the retired and ambiguous words against their baselines',
    argv: ['npx', 'tsx', 'scripts/offline/term-usage.ts'],
    params: { check: { type: 'bool' } },
    gpu: false,
    ollama: false,
  },
};

/** The parsed content of one request file. Values are unknown on purpose: this is the gate. */
export type JobRequest = { id: unknown; job: unknown; space: unknown; args?: unknown };

export type JobArgs = Record<string, string | number | boolean>;

export type ValidatedJobRequest = { ok: true; id: string; job: string; space: string; args: JobArgs };
export type RequestRefusal = { ok: false; reason: string };
export type ValidationResult = ValidatedJobRequest | RequestRefusal;

const ID_CHARS = /^[A-Za-z0-9_-]{1,64}$/;
const WORD_CHARS = /^[a-z][a-z0-9-]{0,31}$/;
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const refuse = (reason: string): RequestRefusal => ({ ok: false, reason });

export type ValidateOptions = {
  /** When given, the target must be one of these (the spaces in this workspace). */
  spaces?: readonly string[];
};

/**
 * Validate one request. Pure: same inputs, same result. The refusal reason is a stable sentence
 * naming the rule, and never echoes a free-form value back unbounded (it is truncated).
 */
export function validateJobRequest(
  request: JobRequest,
  jobs: Readonly<Record<string, ChannelJob>> = CHANNEL_JOBS,
  options: ValidateOptions = {},
): ValidationResult {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return refuse('a request must be an object with id, job, space and optional args');
  }
  const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 40) ?? 'undefined';

  const { id, job, space } = request;
  if (typeof id !== 'string' || !ID_CHARS.test(id)) {
    return refuse(`id ${show(id)} must be 1 to 64 letters, digits, dash or underscore`);
  }
  if (typeof job !== 'string' || !own(jobs, job)) {
    return refuse(`job ${show(job)} is not one of the defined jobs`);
  }
  if (typeof space !== 'string' || !ID_CHARS.test(space)) {
    return refuse('the target space is missing or not a plain identifier');
  }
  if (options.spaces && !options.spaces.includes(space)) {
    return refuse(`the target space ${show(space)} is not in this workspace`);
  }

  const spec = jobs[job]!;
  const raw = request.args === undefined ? {} : request.args;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse('args must be an object of typed values');
  }
  const given = raw as Record<string, unknown>;
  const args: JobArgs = {};

  for (const key of Object.keys(given)) {
    if (!own(spec.params, key)) return refuse(`argument ${show(key)} is not a parameter of ${job}`);
  }
  for (const [name, p] of Object.entries(spec.params)) {
    const v = own(given, name) ? given[name] : undefined;
    if (v === undefined) {
      if ('required' in p && p.required) return refuse(`argument '${name}' is required`);
      continue;
    }
    if (p.type === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < p.min || v > p.max) {
        return refuse(`argument '${name}' must be a whole number from ${p.min} to ${p.max}`);
      }
    } else if (p.type === 'bool') {
      if (typeof v !== 'boolean') return refuse(`argument '${name}' must be true or false`);
    } else if (p.type === 'enum') {
      if (typeof v !== 'string' || !p.values.includes(v)) {
        return refuse(`argument '${name}' must be one of: ${p.values.join(', ')}`);
      }
    } else if (typeof v !== 'string' || !WORD_CHARS.test(v)) {
      return refuse(`argument '${name}' must be a short lowercase word`);
    }
    args[name] = v as string | number | boolean;
  }
  return { ok: true, id, job, space, args };
}

/**
 * The argument list for a validated request: the defined job's fixed command, then one item per
 * given parameter, in the job's declared order (deterministic). `true` adds a bare `--name`;
 * `false` adds nothing. A LIST, so each item is its own argument to the spawned process.
 */
export function toArgv(
  validated: ValidatedJobRequest,
  jobs: Readonly<Record<string, ChannelJob>> = CHANNEL_JOBS,
): string[] {
  if (!own(jobs, validated.job)) throw new Error(`not a defined job: ${validated.job}`);
  const spec = jobs[validated.job]!;
  const out = [...spec.argv];
  for (const [name, p] of Object.entries(spec.params)) {
    if (!own(validated.args, name)) continue;
    const v = validated.args[name]!;
    if (p.type === 'bool') { if (v === true) out.push(`--${name}`); }
    else out.push(`--${name}=${String(v)}`);
  }
  return out;
}
