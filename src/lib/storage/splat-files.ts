/**
 * Imported Gaussian splat files (F58.9.7 / kb:splat-file-import).
 *
 * The bytes live in this browser's IndexedDB (`splatFiles`), never as a data: URI inside a triple.
 * A triple refers to a file as `asset:splat/<content-hash>.ply|spz`; the name is a hash of the
 * bytes, so importing the same scan twice is one file, and the same name is the file name under
 * `assets/splats/` when the space is exported (kb-assets), which is how a space carries its room
 * to another machine. Nothing leaves the device.
 */
import { db as defaultDb, type KBaseDB, type SplatFileRow } from './db';
import { judgeSplatFile, type SplatCheck, type SplatKind } from '$lib/3d/splat-check';
import { LOCAL_SPLAT_PREFIX, isLocalSplatUrl } from '$lib/3d/splat';

/** Largest file accepted. A room scan is tens of MB; this keeps a mistake from filling storage. */
export const MAX_SPLAT_BYTES = 400 * 1024 * 1024;

export type ImportedSplat =
  | { ok: true; url: string; id: string; kind: SplatKind; check: SplatCheck; size: number; alreadyHad: boolean }
  | { ok: false; problems: string[] };

async function contentId(bytes: Uint8Array, kind: SplatKind): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 32)}.${kind}`;
}

/** `asset:splat/<id>` → `<id>` (or null if it is not a local reference). */
export function localSplatId(url: string): string | null {
  return isLocalSplatUrl(url) ? url.slice(LOCAL_SPLAT_PREFIX.length) : null;
}

/** Check a chosen file and, only if it passes, store it. A refused file is not stored. */
export async function importSplatFile(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }, database: KBaseDB = defaultDb): Promise<ImportedSplat> {
  if (file.size > MAX_SPLAT_BYTES) return { ok: false, problems: [`the file is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${MAX_SPLAT_BYTES / 1048576} MB`] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = await judgeSplatFile(file.name, bytes);
  if (!check.pass || !check.kind) return { ok: false, problems: check.problems.length ? check.problems : ['the file is not a usable splat'] };
  const id = await contentId(bytes, check.kind);
  const had = await database.splatFiles.get(id);
  if (!had) {
    await database.splatFiles.put({ id, blob: new Blob([bytes as BlobPart]), filename: file.name, size: bytes.length, importedAt: Date.now() });
  }
  return { ok: true, url: LOCAL_SPLAT_PREFIX + id, id, kind: check.kind, check, size: bytes.length, alreadyHad: !!had };
}

/** Store bytes that arrived with an imported space (kb-import), under the name they were exported with. */
export async function storeSplatBytes(database: KBaseDB, id: string, bytes: Uint8Array, filename = id): Promise<void> {
  if (!/^[A-Za-z0-9_-]+\.(ply|spz)$/.test(id)) return;
  await database.splatFiles.put({ id, blob: new Blob([bytes as BlobPart]), filename, size: bytes.length, importedAt: Date.now() });
}

/** The stored bytes behind `asset:splat/<id>`, or null if this browser does not have them. */
export async function readSplatFile(url: string, database: KBaseDB = defaultDb): Promise<{ bytes: Uint8Array; kind: SplatKind; filename: string } | null> {
  const id = localSplatId(url);
  if (!id) return null;
  const row: SplatFileRow | undefined = await database.splatFiles.get(id);
  if (!row) return null;
  return { bytes: new Uint8Array(await row.blob.arrayBuffer()), kind: id.endsWith('.spz') ? 'spz' : 'ply', filename: row.filename };
}

/** Is this reference's file present in this browser? Used to say so when it is not. */
export async function hasSplatFile(url: string, database: KBaseDB = defaultDb): Promise<boolean> {
  const id = localSplatId(url);
  return id ? !!(await database.splatFiles.get(id)) : true;
}
