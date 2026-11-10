/**
 * Splat files that arrive in a space's FOLDER rather than through the file picker (F58.9.20 /
 * kb:scan-auto-attach). Two entry points, both about the folder `kbs/<slug>/assets/splats/<id>`:
 *
 *   bringSplatFiles       a pending row names `asset:splat/<id>`; if this browser lacks the file it is
 *                         read from the folder and stored, so a proposed row brings its file with it.
 *   synthesizeSplatStatements   a space imported from a folder that HAS the file but no live statement
 *                         naming it gets that statement as PENDING (a proposal, never confirmed).
 *
 * The file is NOT re-checked here: the producer (scan-room) verified it against its receipt, and a
 * stored file is inert until a person confirms a statement that points at it. A size cap still applies.
 */
import { db as defaultDb, type KBaseDB } from './db';
import { MAX_SPLAT_BYTES, localSplatId, storeSplatBytes } from './splat-files';
import { SPLAT_PREDICATE, LOCAL_SPLAT_PREFIX, scanStatements, scanEntityIri } from '$lib/3d/splat';
import type { Statement } from '$lib/rdf/types';

/** Reads `kbs/<kb>/assets/splats/<id>`; null when the folder or file is not there. */
export type SplatFolderReader = (kb: string, id: string) => Promise<Uint8Array | null>;

export interface BroughtSplats {
  /** Read from the folder and stored in this browser. */
  stored: string[];
  /** Already in this browser; the folder was not touched. */
  present: string[];
  /** Named by a row but not in the folder (or over the size cap): the row still imports, the viewer shows its own error. */
  missing: string[];
}

export async function bringSplatFiles(
  entries: readonly { predicate: string; object?: string; kb?: string }[],
  read: SplatFolderReader,
  database: KBaseDB = defaultDb,
): Promise<BroughtSplats> {
  const out: BroughtSplats = { stored: [], present: [], missing: [] };
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.predicate !== SPLAT_PREDICATE || !e.object || !e.kb) continue;
    const id = localSplatId(e.object);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (await database.splatFiles.get(id)) { out.present.push(id); continue; }
    const bytes = await read(e.kb, id).catch(() => null);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_SPLAT_BYTES) { out.missing.push(id); continue; }
    await storeSplatBytes(database, id, bytes);
    out.stored.push(id);
  }
  return out;
}

const SPLAT_PATH = /^assets\/splats\/([A-Za-z0-9_-]+\.(?:ply|spz|sog))$/;
const live = (s: Statement) => s.status !== 'rejected' && s.status !== 'superseded' && s.status !== 'pending-removal';

/**
 * The pending statements for each `assets/splats/<id>` in a folder import that no live statement
 * names. A space exported by this app always names its files; one assembled by hand (or by a scan
 * job that copied the file but whose rows were never drained) may not, and its splat would sit in
 * the folder unseen.
 */
export function synthesizeSplatStatements(
  statements: readonly Statement[],
  assetPaths: Iterable<string>,
  sourceId: string,
  newId: () => string,
  now = Date.now(),
): Statement[] {
  const named = new Set<string>();
  for (const s of statements) {
    if (s.p.value === SPLAT_PREDICATE && s.o.kind === 'literal' && live(s)) named.add(s.o.value);
  }
  const out: Statement[] = [];
  for (const path of assetPaths) {
    const m = SPLAT_PATH.exec(path);
    if (!m) continue;
    const url = LOCAL_SPLAT_PREFIX + m[1];
    if (named.has(url)) continue;
    const entity = scanEntityIri(url);
    // An entity that already exists with other statements still gets the splat reference, but is not retyped.
    const existing = statements.some((s) => s.s.kind === 'iri' && s.s.value === entity && live(s));
    for (const st of scanStatements(url, `scan ${m[1].slice(0, 8)}`, 'reconstructed', newId, now)) {
      if (existing && st.p.value !== SPLAT_PREDICATE) continue;
      out.push({ ...st, status: 'pending', confidence: 0.7, sourceId, g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` } });
    }
    named.add(url);
  }
  return out;
}
