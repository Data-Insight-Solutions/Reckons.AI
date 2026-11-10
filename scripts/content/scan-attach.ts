/**
 * Attach a finished scan's splat to a space (F58.9.20 / kb:scan-auto-attach).
 *
 * Two things happen, and neither confirms anything:
 *   1. the compressed splat is copied to <workspace>/kbs/<slug>/assets/splats/<content id>.<ext>
 *      (content-addressed: the id is the first 32 hex of the file's SHA-256, so writing the same
 *      result twice changes nothing);
 *   2. the statement set the app uses for an imported scan (scanStatements, src/lib/3d/splat.ts) is
 *      appended to the workspace pending queue as rows that each carry `kb: <slug>`. The app's
 *      drain stores the file from the folder and imports the rows as PENDING facts for review.
 *
 * A row WITHOUT a kb target is refused here, at write time: on 2026-11-10 six untargeted attach rows
 * nearly landed in whichever space was open. (The app's drain also retains such a row, but the
 * writer is the place that can still say no.)
 *
 * The id is NOT the one the app computes when a person picks a file (it hashes size plus three
 * samples); the row names the file, and the drain stores it under the name the row uses.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendQueueText } from '../offline/pending-queue.js';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { scanStatements, scanEntityIri, SPLAT_PREDICATE, type SplatOrigin } from '../../src/lib/3d/splat.js';
import { isAbsoluteRdfIri } from '../../src/lib/rdf/pending-entry.js';
import { validateReceipt, type ScanReceipt } from './scan-room-lib.js';

/** A space name safe to use as a folder and as a row's `kb`: no separators, no traversal. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class AttachError extends Error {}

export interface AttachRow {
  subject: string; predicate: string; object?: string; objectKind?: 'literal' | 'iri'; question?: string;
  kb: string; type: 'suggestion' | 'question'; agent: 'scan-room'; priority: 'normal'; note: string;
  /** What a verdict does (F89.4.3): claim for the attach and link rows, question for the capture question. */
  lane: 'claim' | 'question';
}

/** prov:wasDerivedFrom, the predicate the app already uses for provenance (serialize.ts, personal-notes.ts). */
export const DERIVED_FROM = 'http://www.w3.org/ns/prov#wasDerivedFrom';
export const CAPTURE_QUESTION = 'Which capture is this a scan of?';

export interface Links {
  /** Nodes this splat was reconstructed from: `<splat> prov:wasDerivedFrom <iri>`. */
  derivedFrom?: readonly string[];
  /** `[subject, predicate]`: `<subject> <predicate> <splat>`, a relation the space already has. */
  linkFrom?: readonly (readonly [string, string])[];
}

/** Parse the CLI's `--link-from=<subject IRI>,<predicate IRI>` values. Refuses anything that is not two absolute IRIs. */
export function parseLinkFrom(values: readonly string[]): [string, string][] {
  return values.map((v) => {
    const parts = v.split(',').map((x) => x.trim());
    if (parts.length !== 2) throw new AttachError(`--link-from needs "<subject IRI>,<predicate IRI>", got "${v}"`);
    return [parts[0], parts[1]] as [string, string];
  });
}

/** Refuse a link value that is not an absolute IRI, before anything is copied or written. */
export function assertLinkIris(links: Links): void {
  const bad = [...(links.derivedFrom ?? []), ...(links.linkFrom ?? []).flat()].filter((v) => !isAbsoluteRdfIri(v));
  if (bad.length) throw new AttachError(`not an absolute IRI: ${bad.map((b) => `"${b}"`).join(', ')}`);
}

/**
 * The rows that join the splat node to the rest of the space. With no link at all, ONE question row
 * (a partial fact, no object) so the splat does not arrive as a silent island. Pure.
 */
export function linkRows(slug: string, id: string, links: Links, withQuestion: boolean): AttachRow[] {
  assertLinkIris(links);
  const splat = scanEntityIri(`asset:splat/${id}`);
  const base = { kb: slug, agent: 'scan-room' as const, priority: 'normal' as const };
  const rows: AttachRow[] = [];
  for (const iri of links.derivedFrom ?? []) rows.push({ ...base, subject: splat, predicate: DERIVED_FROM, object: iri, objectKind: 'iri', type: 'suggestion', lane: 'claim', note: 'scan reconstructed from this node, stated by the person running scan:room' });
  for (const [subject, predicate] of links.linkFrom ?? []) rows.push({ ...base, subject, predicate, object: splat, objectKind: 'iri', type: 'suggestion', lane: 'claim', note: 'relation to the attached scan, stated by the person running scan:room' });
  if (!rows.length && withQuestion) rows.push({ ...base, subject: splat, predicate: DERIVED_FROM, question: CAPTURE_QUESTION, type: 'question', lane: 'question', note: 'scan:room attached this splat with no link to a capture' });
  return rows;
}

export interface AttachResult {
  space: string; id: string; url: string; file: string; copied: boolean; rows: number; rowsAlreadyQueued: number; entity: string;
}

/** The workspace folder: --workspace, else RECKONS_WORKSPACE, else the main checkout's reckons-workspace. */
export function resolveWorkspace(explicit?: string): string {
  return resolve(explicit ?? process.env.RECKONS_WORKSPACE ?? join(mainCheckoutRoot(), 'reckons-workspace'));
}

/** The folder of a space that exists in the workspace, or a refusal that says what was looked for. */
export function requireSpace(workspace: string, slug: string): string {
  if (!SLUG.test(slug) || slug.includes('..')) throw new AttachError(`"${slug}" is not a usable space name (letters, digits, . _ - only)`);
  const dir = join(workspace, 'kbs', slug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AttachError(`no space "${slug}" in ${join(workspace, 'kbs')}; refusing to create one`);
  return dir;
}

/** Content id: first 32 hex of the SHA-256 of the bytes, plus the extension. */
export function contentId(bytes: Uint8Array, ext: string): string {
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
}

/**
 * Copy `src` into the space's assets/splats under its content id. Returns the id and whether a
 * write happened; an identical file already there is left untouched (idempotent).
 */
export function copySplatToSpace(src: string, spaceDir: string): { id: string; dest: string; copied: boolean } {
  const bytes = readFileSync(src);
  const ext = /\.(ply|spz|sog)$/i.exec(src)?.[1].toLowerCase();
  if (!ext) throw new AttachError(`${src} is not a .ply, .spz or .sog file`);
  const id = contentId(bytes, ext);
  const dir = join(spaceDir, 'assets', 'splats');
  const dest = join(dir, id);
  if (existsSync(dest) && readFileSync(dest).equals(bytes)) return { id, dest, copied: false };
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, dest);
  return { id, dest, copied: true };
}

/** The rows for one scan: scanStatements, as queue rows addressed to `slug`. Pure. */
export function attachRows(slug: string, id: string, label: string, origin: SplatOrigin = 'reconstructed'): AttachRow[] {
  let n = 0;
  return scanStatements(`asset:splat/${id}`, label, origin, () => `row${n++}`, 0).map((st) => ({
    subject: st.s.value,
    predicate: st.p.value,
    object: st.o.value,
    objectKind: st.o.kind === 'iri' ? 'iri' as const : 'literal' as const,
    kb: slug,
    type: 'suggestion' as const,
    lane: 'claim' as const,
    agent: 'scan-room' as const,
    priority: 'normal' as const,
    note: st.p.value === SPLAT_PREDICATE ? `${origin} scan attached by scan:room; its file is in this space's folder` : `${origin} scan attached by scan:room`,
  }));
}

/** Refuse any row with no kb target. This is the write-time guard; nothing is appended if one row fails it. */
export function assertTargeted(rows: readonly { kb?: unknown; subject?: unknown }[]): void {
  const bad = rows.filter((r) => typeof r.kb !== 'string' || !r.kb.trim());
  if (bad.length) throw new AttachError(`refusing to queue ${bad.length} scan row(s) with no kb target: an untargeted row can land in whichever space is open`);
}

/** Append the rows under the queue lock, skipping any line already queued. Returns [appended, skipped]. */
export function appendAttachRows(queuePath: string, rows: readonly AttachRow[]): [number, number] {
  assertTargeted(rows);
  // Idempotent on WHAT the row says, not its bytes: the append function stamps run, origin and time,
  // so a re-attach produces different bytes for the same row.
  const key = (r: Record<string, unknown>) => JSON.stringify([r.kb, r.subject, r.predicate, r.object ?? null, r.question ?? null]);
  const have = new Set<string>();
  for (const l of existsSync(queuePath) ? readFileSync(queuePath, 'utf8').split('\n') : []) {
    try { have.add(key(JSON.parse(l))); } catch { /* not a row */ }
  }
  const fresh = rows.filter((r) => !have.has(key(r as unknown as Record<string, unknown>)));
  const lines = fresh.map((r) => JSON.stringify(r));
  if (lines.length) appendQueueText(queuePath, lines.join('\n') + '\n');
  return [lines.length, rows.length - lines.length];
}

/**
 * Attach a splat file (already verified by the caller) to a space. A first attach copies the file
 * and queues the four base rows plus the link rows (or the one question). When the file is ALREADY in
 * the space's folder the base rows are not queued again (they were, and re-queuing them after a
 * drain would overwrite a review verdict); only the link rows are. `linksOnly` makes that explicit
 * and refuses when the file is not there yet.
 */
export function attachSplat(opts: { splat: string; workspace: string; space: string; label?: string; queuePath?: string; links?: Links; linksOnly?: boolean }): AttachResult {
  const links = opts.links ?? {};
  assertLinkIris(links);
  const spaceDir = requireSpace(opts.workspace, opts.space);
  const queuePath = opts.queuePath ?? join(opts.workspace, 'knowledge.pending.jsonl');
  const hasLinks = !!(links.derivedFrom?.length || links.linkFrom?.length);
  if (opts.linksOnly) {
    if (!hasLinks) throw new AttachError('--links-only needs at least one --derived-from or --link-from');
    const ext = /\.(ply|spz|sog)$/i.exec(opts.splat)?.[1].toLowerCase() ?? 'spz';
    const id = contentId(readFileSync(opts.splat), ext);
    if (!existsSync(join(spaceDir, 'assets', 'splats', id))) throw new AttachError(`--links-only: this scan is not attached to "${opts.space}" yet (no ${id} in its folder); attach it first`);
    const rows = linkRows(opts.space, id, links, false);
    const [added, skipped] = appendAttachRows(queuePath, rows);
    return { space: opts.space, id, url: `asset:splat/${id}`, file: join(spaceDir, 'assets', 'splats', id), copied: false, rows: added, rowsAlreadyQueued: skipped, entity: scanEntityIri(`asset:splat/${id}`) };
  }
  const { id, copied } = copySplatToSpace(opts.splat, spaceDir);
  const rows = [...(copied ? attachRows(opts.space, id, opts.label ?? 'room scan') : []), ...linkRows(opts.space, id, links, copied)];
  const [added, skipped] = appendAttachRows(queuePath, rows);
  return { space: opts.space, id, url: `asset:splat/${id}`, file: join(spaceDir, 'assets', 'splats', id), copied, rows: added, rowsAlreadyQueued: skipped, entity: scanEntityIri(`asset:splat/${id}`) };
}

/**
 * Attach a scan that already finished, without re-running anything. Reads the receipt and refuses a
 * scan whose receipt did not pass or whose compressed file no longer matches it. (This checks the
 * receipt and the file's hash; `scan:room --check <dir>` additionally decodes the file.)
 */
export function attachFinishedScan(opts: { scanDir: string; workspace: string; space: string; label?: string; queuePath?: string; links?: Links; linksOnly?: boolean }): AttachResult {
  assertLinkIris(opts.links ?? {});
  const dir = resolve(opts.scanDir);
  const rf = join(dir, 'receipt.json');
  if (!existsSync(rf)) throw new AttachError(`no receipt.json in ${dir}: only a finished scan can be attached`);
  let receipt: ScanReceipt;
  try { receipt = JSON.parse(readFileSync(rf, 'utf8')) as ScanReceipt; } catch { throw new AttachError(`${rf} is not valid JSON`); }
  const problems = validateReceipt(receipt);
  if (problems.length) throw new AttachError(`the scan's receipt did not pass:\n  ${problems.join('\n  ')}`);
  if (!receipt.compressed) throw new AttachError('this scan has no compressed copy (splat.spz) to attach; re-run its compress stage');
  const file = join(dir, receipt.compressed.file);
  if (!existsSync(file)) throw new AttachError(`${file} is missing`);
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== receipt.compressed.sha256) throw new AttachError(`${receipt.compressed.file} does not match its receipt hash`);
  return attachSplat({ splat: file, workspace: opts.workspace, space: opts.space, label: opts.label, queuePath: opts.queuePath, links: opts.links, linksOnly: opts.linksOnly });
}

/** The job's result for the local queue: which asset, in which space. Written where RECKONS_JOB_RESULT points. */
export function jobResult(r: AttachResult): Record<string, string> {
  return { kind: 'scan-attach', space: r.space, asset: r.url, contentId: r.id, entity: r.entity };
}
