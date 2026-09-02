/**
 * Validation and routing for the workspace pending JSONL queue.
 *
 * The queue crosses a trust boundary: many scripts and MCP clients can append text, while the app
 * turns accepted rows into graph statements. A TypeScript cast is not validation, and an unscoped
 * row must never be consumed by whichever graph happens to be open.
 */

export const PENDING_ENTRY_TYPES = [
  'observation',
  'question',
  'suggestion',
  'status-update',
  'drift-warning',
] as const;

export type PendingEntryType = (typeof PENDING_ENTRY_TYPES)[number];
export type PendingPriority = 'low' | 'normal' | 'high';
export type PendingFindingClass = 'form' | 'drift' | 'defect';

export interface PendingEntry {
  subject: string;
  predicate: string;
  /** Explicit destination graph name. Unscoped legacy rows are retained, never guessed. */
  kb?: string;
  object?: string;
  objectKind?: 'literal' | 'iri';
  question?: string;
  blocks?: string | string[];
  note?: string;
  addedByMcp?: boolean;
  addedAt?: string;
  type?: PendingEntryType;
  findingClass?: PendingFindingClass;
  commitSha?: string;
  agent?: string;
  priority?: PendingPriority;
  askedByGraph?: string;
  /**
   * Legacy, self-attested verifier label.
   *
   * A queue row can be written by an MCP client or any local process, so this string is not an
   * authentication credential and MUST NOT authorize confirmation. It is retained only for
   * compatibility with old queue files; new verifier runs write `verificationClaim` instead.
   */
  verifiedBy?: string;
  /**
   * Advisory result of a deterministic check, such as `script:queue-verify/path-exists`.
   *
   * This is deliberately named a claim: it travels in the same untrusted JSON object as the fact
   * and therefore cannot prove who ran the check. Queue drains preserve the human review boundary
   * regardless of this value. A future auto-settle lane needs a separately authenticated channel.
   */
  verificationClaim?: string;
  [key: string]: unknown;
}

export type PendingEntryIssueCode =
  | 'malformed-json'
  | 'not-an-object'
  | 'missing-subject'
  | 'invalid-subject-iri'
  | 'missing-predicate'
  | 'invalid-predicate-iri'
  | 'missing-content'
  | 'invalid-object'
  | 'invalid-object-kind'
  | 'invalid-object-iri'
  | 'missing-kb'
  | 'invalid-kb'
  | 'invalid-type'
  | 'invalid-priority'
  | 'invalid-finding-class'
  | 'invalid-added-at'
  | 'invalid-blocks'
  | 'invalid-block-iri';

export type PendingEntryParseResult =
  | { ok: true; entry: PendingEntry }
  | { ok: false; code: PendingEntryIssueCode; message: string };

const ENTRY_TYPES = new Set<string>(PENDING_ENTRY_TYPES);
const PRIORITIES = new Set(['low', 'normal', 'medium', 'high']);
const FINDING_CLASSES = new Set(['form', 'drift', 'defect']);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * RDF named nodes carry absolute IRIs. `new URL()` alone is too forgiving for this boundary — it
 * silently percent-encodes spaces and accepts malformed percent escapes — so reject characters
 * forbidden by RFC 3987 first, then require an absolute scheme and a parseable URL/URN.
 */
export function isAbsoluteRdfIri(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const iri = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri)) return false;
  if (/[\u0000-\u0020<>"{}|\\^`]/u.test(iri)) return false;
  if (/%(?![0-9A-Fa-f]{2})/.test(iri)) return false;
  try {
    new URL(iri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse and validate one JSONL row. `medium` is accepted as a legacy spelling and normalized to
 * `normal`; producers historically used both words for the same confidence band.
 */
export function parsePendingEntryLine(
  line: string,
  options: { requireKb?: boolean } = {},
): PendingEntryParseResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: 'malformed-json', message: 'row is not valid JSON' };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'not-an-object', message: 'row must be a JSON object' };
  }

  const row = value as Record<string, unknown>;
  if (!nonEmptyString(row.subject)) {
    return { ok: false, code: 'missing-subject', message: 'subject must be a non-empty string' };
  }
  if (!isAbsoluteRdfIri(row.subject)) {
    return { ok: false, code: 'invalid-subject-iri', message: 'subject must be an absolute RDF IRI' };
  }
  if (!nonEmptyString(row.predicate)) {
    return { ok: false, code: 'missing-predicate', message: 'predicate must be a non-empty string' };
  }
  if (!isAbsoluteRdfIri(row.predicate)) {
    return { ok: false, code: 'invalid-predicate-iri', message: 'predicate must be an absolute RDF IRI' };
  }

  if (row.object !== undefined && typeof row.object !== 'string') {
    return { ok: false, code: 'invalid-object', message: 'object must be a string when supplied' };
  }
  const object = typeof row.object === 'string' ? row.object : undefined;
  const hasObject = object !== undefined && object.length > 0;
  const hasQuestion = nonEmptyString(row.question);
  const hasNote = nonEmptyString(row.note);
  if (!hasObject && !hasQuestion && !hasNote) {
    return {
      ok: false,
      code: 'missing-content',
      message: 'row needs an object, question, or note',
    };
  }
  if (
    row.objectKind !== undefined &&
    row.objectKind !== 'literal' &&
    row.objectKind !== 'iri'
  ) {
    return {
      ok: false,
      code: 'invalid-object-kind',
      message: 'objectKind must be literal or iri',
    };
  }
  // `objectTerm()` infers urn:* objects as named nodes even when objectKind is omitted, so validate
  // both the explicit and inferred IRI paths here rather than letting malformed RDF reach storage.
  const objectIsIri = hasObject && (
    row.objectKind === 'iri' || (row.objectKind === undefined && object?.startsWith('urn:'))
  );
  if (objectIsIri && !isAbsoluteRdfIri(object)) {
    return { ok: false, code: 'invalid-object-iri', message: 'IRI object must be an absolute RDF IRI' };
  }

  if (row.kb !== undefined && !nonEmptyString(row.kb)) {
    return { ok: false, code: 'invalid-kb', message: 'kb must be a non-empty graph name' };
  }
  if (options.requireKb && !nonEmptyString(row.kb)) {
    return { ok: false, code: 'missing-kb', message: 'row has no destination graph' };
  }
  if (row.type !== undefined && (typeof row.type !== 'string' || !ENTRY_TYPES.has(row.type))) {
    return { ok: false, code: 'invalid-type', message: `unknown entry type: ${String(row.type)}` };
  }
  if (row.priority !== undefined && (typeof row.priority !== 'string' || !PRIORITIES.has(row.priority))) {
    return {
      ok: false,
      code: 'invalid-priority',
      message: `unknown priority: ${String(row.priority)}`,
    };
  }
  if (
    row.findingClass !== undefined &&
    (typeof row.findingClass !== 'string' || !FINDING_CLASSES.has(row.findingClass))
  ) {
    return {
      ok: false,
      code: 'invalid-finding-class',
      message: `unknown finding class: ${String(row.findingClass)}`,
    };
  }
  if (
    row.addedAt !== undefined &&
    (!nonEmptyString(row.addedAt) || Number.isNaN(Date.parse(row.addedAt)))
  ) {
    return { ok: false, code: 'invalid-added-at', message: 'addedAt must be a valid date string' };
  }
  if (
    row.blocks !== undefined &&
    !nonEmptyString(row.blocks) &&
    !(Array.isArray(row.blocks) && row.blocks.every(nonEmptyString))
  ) {
    return { ok: false, code: 'invalid-blocks', message: 'blocks must be a string or string array' };
  }
  const blocks = Array.isArray(row.blocks) ? row.blocks : row.blocks === undefined ? [] : [row.blocks];
  if (blocks.some((block) => !isAbsoluteRdfIri(block))) {
    return { ok: false, code: 'invalid-block-iri', message: 'every blocker must be an absolute RDF IRI' };
  }

  const entry = {
    ...row,
    subject: row.subject.trim(),
    predicate: row.predicate.trim(),
    ...(objectIsIri && object ? { object: object.trim() } : {}),
    ...(nonEmptyString(row.kb) ? { kb: row.kb.trim() } : {}),
    ...(row.priority === 'medium' ? { priority: 'normal' as const } : {}),
    ...(typeof row.blocks === 'string'
      ? { blocks: row.blocks.trim() }
      : Array.isArray(row.blocks)
        ? { blocks: row.blocks.map((block) => block.trim()) }
        : {}),
  } as PendingEntry;

  return { ok: true, entry };
}

/** Match display names and folder slugs without making graph selection fuzzy. */
export function normalizePendingGraphName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
}

export interface PendingQueueIssue {
  line: number;
  code: PendingEntryIssueCode;
  message: string;
}

export interface PendingQueuePartition {
  entries: PendingEntry[];
  /** Original text of rows selected for this graph, used for post-commit acknowledgement. */
  consumedLines: string[];
  /** Original text of rows not consumed, including malformed and invalid rows. */
  retainedLines: string[];
  issues: PendingQueueIssue[];
}

/**
 * Select only valid rows explicitly addressed to the active graph. Everything else is retained in
 * its original form so a drain cannot become data loss or wrong-graph import.
 *
 * `activeKb` accepts SEVERAL aliases for the same graph, and a row matching any of them is
 * consumed. The caller passes both the registry display name and the graph id because they are
 * not the same string and either can be what a producer wrote: `?kb=roadmap` sets the *id*, while
 * this function historically compared only the *name*, which resolves to 'Default Graph' for any
 * graph absent from the registry. A correctly targeted `{"kb":"roadmap"}` row therefore imported
 * nowhere, and the failure was silent — the drain reported success having delivered nothing.
 * Aliases are normalized and de-duplicated, so passing the same string twice is harmless.
 */
export function partitionPendingJsonl(
  text: string,
  activeKb: string | readonly string[],
): PendingQueuePartition {
  const entries: PendingEntry[] = [];
  const consumedLines: string[] = [];
  const retainedLines: string[] = [];
  const issues: PendingQueueIssue[] = [];
  const active = new Set(
    (typeof activeKb === 'string' ? [activeKb] : activeKb)
      .filter((alias) => typeof alias === 'string' && alias.trim())
      .map(normalizePendingGraphName),
  );

  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parsePendingEntryLine(trimmed, { requireKb: true });
    if (!parsed.ok) {
      retainedLines.push(line);
      issues.push({ line: index + 1, code: parsed.code, message: parsed.message });
      continue;
    }

    if (!active.has(normalizePendingGraphName(parsed.entry.kb!))) {
      retainedLines.push(line);
      continue;
    }
    entries.push(parsed.entry);
    consumedLines.push(line);
  }

  return { entries, consumedLines, retainedLines, issues };
}

/**
 * Remove exactly the queue rows that a successful import consumed.
 *
 * This is a multiset subtraction over the original bytes. If another writer appended rows while
 * IndexedDB was committing, those rows survive the acknowledgement; an identical append also
 * survives once the number of originally consumed copies has been removed. At worst a failed
 * acknowledgement imports a duplicate next time — it never loses an uncommitted proposal.
 */
export function acknowledgePendingJsonl(text: string, consumedLines: readonly string[]): string {
  const remainingCounts = new Map<string, number>();
  for (const line of consumedLines) {
    remainingCounts.set(line, (remainingCounts.get(line) ?? 0) + 1);
  }

  const retained: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const remaining = remainingCounts.get(line) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) remainingCounts.delete(line);
      else remainingCounts.set(line, remaining - 1);
    } else {
      retained.push(line);
    }
  }
  return retained.length ? `${retained.join('\n')}\n` : '';
}

export interface PendingQueueInspection {
  total: number;
  valid: number;
  malformed: number;
  invalid: number;
  untargeted: number;
  entries: PendingEntry[];
  issues: PendingQueueIssue[];
}

/** Read-only queue diagnostics for scripts such as `npm run brief`. */
export function inspectPendingJsonl(text: string): PendingQueueInspection {
  const entries: PendingEntry[] = [];
  const issues: PendingQueueIssue[] = [];
  let total = 0;

  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;
    const parsed = parsePendingEntryLine(trimmed);
    if (parsed.ok) entries.push(parsed.entry);
    else issues.push({ line: index + 1, code: parsed.code, message: parsed.message });
  }

  const malformed = issues.filter((issue) => issue.code === 'malformed-json').length;
  return {
    total,
    valid: entries.length,
    malformed,
    invalid: issues.length - malformed,
    untargeted: entries.filter((entry) => !entry.kb).length,
    entries,
    issues,
  };
}
