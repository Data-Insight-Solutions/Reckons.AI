/**
 * F74.14 — the pure half of the request file: validate a request and turn it into an argument
 * list, never a command string.
 *
 * F74.14 in the roadmap (the job-to-workspace channel) fixes the design: one request file per
 * ask, written by the app when a person asks for a job (regenerate from the start, resume from a
 * stage) and answered by the host beside it. A request "names a job from the defined list and its
 * arguments, never a command". The done-test for that half is: a request naming a job that is not
 * defined is refused, and no test can make the request text reach a shell string.
 *
 * This module is that half as a pure function. It receives the already-parsed request (the content
 * of one request file) and the list of defined job names, and it decides accept or refuse. It reads
 * no files and runs nothing. The host that later spawns the job is a separate piece (a later
 * branch): it calls `validateJobRequest`, and only on `ok` builds the argument list with `toArgv`
 * and spawns that LIST — it never concatenates the parts into one string and hands it to a shell.
 *
 * REFUSE, in the order checked here:
 *   1. a job name that is not one of the defined job names;
 *   2. a missing or empty target (the request's `space` field);
 *   3. an id that carries anything but letters, digits, dash or underscore;
 *   4. args that are not a flat object of strings, numbers and booleans;
 *   5. a string argument that carries any forbidden character (FORBIDDEN_IN_ARG).
 *
 * STATE IS SHOWN, NEVER PROPOSED (the F74.14 principle) does not bind this pure check, but it sets
 * the register: the output is data for the host, not a line a person is asked to accept.
 *
 * FIRST DRAFT, for an overseer to review. The calls it leaves to that review:
 *   - the exact forbidden list (FORBIDDEN_IN_ARG) — a newline and its carriage-return partner are
 *     both refused, on top of the semicolon, pipe, backtick, `$(` and `&&` the roadmap names;
 *   - whether the target itself must also be an identifier here (it is only required to be
 *     present and non-empty, because the target's own shape is settled elsewhere);
 *   - how a boolean argument renders in the argv (`--key=true`, not a bare `--key`), chosen to
 *     keep every item in one `--key=value` shape;
 *   - that the job name and the target are NOT folded into the argv: they are separate fields the
 *     host already holds, so the list is the arguments alone.
 */

/** The shape of the parsed content of one request file. Values are unknown on purpose: this
 *  function is the gate that decides which of them are trustworthy. */
export type JobRequest = {
  id: unknown;
  job: unknown;
  args?: unknown;
  space: unknown;
};

/** A flat object of strings, numbers and booleans: the only argument values the host may pass on. */
export type JobArgs = Record<string, string | number | boolean>;

/** The accepted request, with its parts separated and its args normalized (absent args = `{}`). */
export type ValidatedJobRequest = {
  ok: true;
  job: string;
  args: JobArgs;
  space: string;
};

/** A refused request and the single reason it was refused. */
export type RequestRefusal = {
  ok: false;
  reason: string;
};

export type ValidationResult = ValidatedJobRequest | RequestRefusal;

/**
 * Substrings a string argument must never carry: they are shell metacharacters, so a value with
 * one could break out of its own argument if it were ever interpolated into a command line.
 * The newline and its carriage-return partner are both refused, because either one can split a
 * value across lines; the rest are the semicolon, the pipe, the backtick, command substitution
 * (`$(`) and the AND list (`&&`).
 */
export const FORBIDDEN_IN_ARG = ['\n', '\r', ';', '|', '`', '$(', '&&'] as const;

const ID_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * Validate one request against the list of defined job names. Pure: the same inputs give the same
 * result, and nothing here reads a file, spawns a process or touches the network.
 *
 * The refusal `reason` is a stable, human-readable sentence (it names the offending key or value)
 * so the host can record which rule refused the ask without re-deriving it.
 */
export function validateJobRequest(
  request: JobRequest,
  definedJobs: readonly string[],
): ValidationResult {
  // A request file must parse to an object; a bare string or null has none of the required parts.
  if (typeof request !== 'object' || request === null) {
    return { ok: false, reason: 'a request must be an object with id, job, space and optional args' };
  }

  // 1. The job must be one of the defined job names. Missing, not a string, or not in the list —
  //    all read as "not a defined job" and are refused the same way.
  const job = request.job;
  if (typeof job !== 'string' || job.length === 0 || !definedJobs.includes(job)) {
    return { ok: false, reason: `job '${String(job)}' is not one of the defined jobs` };
  }

  // 2. The target must be present and non-empty. Its own shape is settled elsewhere, so here only
  //    "a string of at least one character" is required.
  const space = request.space;
  if (typeof space !== 'string' || space.length === 0) {
    return { ok: false, reason: 'the target (the request space) is missing or empty' };
  }

  // 3. The id must be letters, digits, dash or underscore only, at least one of them.
  const id = request.id;
  if (typeof id !== 'string' || !ID_CHARS.test(id)) {
    return { ok: false, reason: `id '${String(id)}' must be letters, digits, dash or underscore only` };
  }

  // 4 and 5. args are optional; when present they must be a flat object of strings, numbers and
  // booleans, and no string value may carry a forbidden character. Absent args normalize to {}.
  const argsRaw = request.args;
  if (argsRaw === undefined) {
    return { ok: true, job, args: {}, space };
  }
  if (typeof argsRaw !== 'object' || argsRaw === null || Array.isArray(argsRaw)) {
    return { ok: false, reason: 'args must be a flat object of strings, numbers and booleans' };
  }

  const args: JobArgs = {};
  for (const [key, value] of Object.entries(argsRaw)) {
    if (typeof value === 'string') {
      if (FORBIDDEN_IN_ARG.some((f) => value.includes(f))) {
        return { ok: false, reason: `argument '${key}' carries a forbidden character` };
      }
      args[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      args[key] = value;
    } else {
      return { ok: false, reason: `argument '${key}' must be a string, number or boolean` };
    }
  }
  return { ok: true, job, args, space };
}

/**
 * Build the argument list for a validated request: one `--key=value` item per argument, in sorted
 * key order so the result is deterministic. It returns a LIST, not a single string — the host
 * passes each item as its own argument to the process it spawns, so no item can be read as a
 * joined command and no value can break out of its slot.
 */
export function toArgv(validated: ValidatedJobRequest): string[] {
  return Object.keys(validated.args)
    .sort()
    .map((key) => `--${key}=${validated.args[key]}`);
}
