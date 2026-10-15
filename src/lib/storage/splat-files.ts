/**
 * Imported Gaussian splat files (F58.9.7 / kb:splat-file-import).
 *
 * The file lives in this browser's IndexedDB (`splatFiles`) as a Blob: the chosen File is stored as
 * it is, so a 100 MB scan is never copied into a JavaScript buffer and never becomes a data: URI
 * inside a triple. A triple refers to it as `asset:splat/<id>.ply|spz|sog`, and the same name is the
 * file name under `assets/splats/` when the space is exported (kb-assets). Nothing leaves the device.
 *
 * SIZE. Measured on the scan:room lane (2026-10-14): Brush at its default 30k steps wrote a 102 MB
 * PLY of 432,501 Gaussians; 3k steps wrote 21 MB and 88k. So the check reads in 4 MB chunks, and:
 *   - above WARN_SPLAT_BYTES (50 MB) the import still succeeds but says what the size means;
 *   - above MAX_SPLAT_BYTES (300 MB, about three times the measured default) it is refused with
 *     guidance. That ceiling is a judgement, not a measurement: nothing larger has been tried, and
 *     decoding a file into the renderer needs memory of the same order as the file.
 */
import { db as defaultDb, type KBaseDB, type SplatFileRow } from './db';
import { judgeSplatFile, type SplatCheck, type SplatKind } from '$lib/3d/splat-check';
import { LOCAL_SPLAT_PREFIX, isLocalSplatUrl } from '$lib/3d/splat';

export const WARN_SPLAT_BYTES = 50 * 1024 * 1024;
export const MAX_SPLAT_BYTES = 300 * 1024 * 1024;

export type ImportedSplat =
  | { ok: true; url: string; id: string; kind: SplatKind; check: SplatCheck; size: number; alreadyHad: boolean; warnings: string[] }
  | { ok: false; problems: string[] };

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

/** Advice that is true for how reconstructed scans are made, shown with a size warning or refusal. */
export const SIZE_ADVICE = 'Re-run the reconstruction with fewer training steps (3k steps gave 21 MB and 88,000 Gaussians against 102 MB and 432,501 at the 30k default) or convert it to .sog or .spz (npm run splat:compress), which are about 5 to 20 times smaller.';

/**
 * A content id without reading the whole file into one buffer: SHA-256 of the size plus up to 1 MB
 * from the start, middle and end. Exact for a file under 3 MB; for a larger one two different
 * files would need the same size and the same three samples to collide, which a reconstruction
 * run will not produce by accident. (The Web Crypto digest is not incremental, so a full-file
 * hash would mean holding the whole file.)
 */
async function contentId(file: Blob, kind: SplatKind): Promise<string> {
  const MB = 1048576;
  const read = async (a: number, b: number) => new Uint8Array(await (typeof file.slice(a, b).arrayBuffer === 'function' ? file.slice(a, b).arrayBuffer() : new Response(file.slice(a, b)).arrayBuffer()));
  const parts: Uint8Array[] = [new TextEncoder().encode(String(file.size) + ':')];
  if (file.size <= 3 * MB) parts.push(await read(0, file.size));
  else {
    const mid = Math.floor(file.size / 2 - MB / 2);
    parts.push(await read(0, MB), await read(mid, mid + MB), await read(file.size - MB, file.size));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const digest = await crypto.subtle.digest('SHA-256', all as BufferSource);
  return `${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}.${kind}`;
}

/** `asset:splat/<id>` to `<id>` (or null if it is not a local reference). */
export function localSplatId(url: string): string | null {
  return isLocalSplatUrl(url) ? url.slice(LOCAL_SPLAT_PREFIX.length) : null;
}

/** Check a chosen file and, only if it passes, store it. A refused file is not stored. */
export async function importSplatFile(file: File | (Blob & { name: string }), database: KBaseDB = defaultDb): Promise<ImportedSplat> {
  if (file.size > MAX_SPLAT_BYTES) return { ok: false, problems: [`the file is ${mb(file.size)}; the limit is ${mb(MAX_SPLAT_BYTES)}. ${SIZE_ADVICE}`] };
  // SPZ and SOG are decoded with the renderer's own decoder (browser only); PLY is walked in chunks.
  const decode = typeof Worker === 'undefined' ? undefined : (await import('$lib/3d/splat-decode')).decodeSplatCentres;
  const check = await judgeSplatFile(file.name, file, decode);
  if (!check.pass || !check.kind) return { ok: false, problems: check.problems.length ? check.problems : ['the file is not a usable splat'] };
  const id = await contentId(file, check.kind);
  const had = await database.splatFiles.get(id);
  if (!had) await database.splatFiles.put({ id, blob: file, filename: file.name, size: file.size, importedAt: Date.now() });
  const warnings: string[] = [];
  if (file.size > WARN_SPLAT_BYTES) {
    warnings.push(`This file is ${mb(file.size)}${check.measured.count ? ` (${Number(check.measured.count).toLocaleString()} Gaussians)` : ''}. It was imported, but it will be slow to load and heavy on a phone, and exporting the space copies it into memory. ${SIZE_ADVICE}`);
  }
  return { ok: true, url: LOCAL_SPLAT_PREFIX + id, id, kind: check.kind, check, size: file.size, alreadyHad: !!had, warnings };
}

/** Store a file that arrived with an imported space (kb-import), under the name it was exported with. */
export async function storeSplatBytes(database: KBaseDB, id: string, bytes: Uint8Array, filename = id): Promise<void> {
  if (!/^[A-Za-z0-9_-]+\.(ply|spz|sog)$/.test(id)) return;
  await database.splatFiles.put({ id, blob: new Blob([bytes as BlobPart]), filename, size: bytes.length, importedAt: Date.now() });
}

/** The stored file behind `asset:splat/<id>`, or null if this browser does not have it. */
export async function readSplatFile(url: string, database: KBaseDB = defaultDb): Promise<{ blob: Blob; kind: SplatKind; filename: string } | null> {
  const id = localSplatId(url);
  if (!id) return null;
  const row: SplatFileRow | undefined = await database.splatFiles.get(id);
  if (!row) return null;
  return { blob: row.blob, kind: id.endsWith('.spz') ? 'spz' : id.endsWith('.sog') ? 'sog' : 'ply', filename: row.filename };
}

/** Is this reference's file present in this browser? */
export async function hasSplatFile(url: string, database: KBaseDB = defaultDb): Promise<boolean> {
  const id = localSplatId(url);
  return id ? !!(await database.splatFiles.get(id)) : true;
}
