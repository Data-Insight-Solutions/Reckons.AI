/**
 * Source corpus (F221) — the shared, storage-agnostic half of retaining a source.
 *
 * Layout (Matt, 2026-09-29; one module for browser and CLI so neither drifts into its own format):
 *
 *   sources/<slug>-<hash8>/original.<ext>   bytes exactly as received (only when there ARE bytes)
 *                          text.md          derived plain text
 *                          chunks.ttl       derived chunk corpus (chunksToTurtle)
 *
 * This module is pure: no DOM, no filesystem, no Node API. Storage is the thin `CorpusRoot`
 * interface below; adapters live in src/lib/storage/source-corpus-fs.ts.
 *
 * RULES HELD HERE:
 *  - RETENTION PASSES THE INGEST SAFETY GATE: text the classifier blocks is not retained.
 *  - A FAILED WRITE NEVER THROWS INTO INGEST: `retainSource` returns a result describing what
 *    happened (`retained`, `blocked`, `skipped` or `failed`), so the extraction is never lost to a
 *    disk error.
 *  - chunks.ttl is a separate corpus: it is never loaded into the statement store or fact search.
 *    The folder walk skips CORPUS_DIR for that reason (workspace.svelte.ts).
 */
import { classifyText } from '../safety/content-policy';
import { chunkText, chunksToTurtle } from './source-chunks';

/** Directory under the workspace root (or OPFS root). Never exported, published or walked for graphs. */
export const CORPUS_DIR = 'sources';
export const TEXT_FILE = 'text.md';
export const CHUNKS_FILE = 'chunks.ttl';
export const ORIGINAL_BASENAME = 'original';

/** Lowercase ASCII slug, at most 40 chars, never empty. Readable folder names for humans. */
export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'source';
}

/** First 8 characters of a content hash, restricted to [a-z0-9]. Null when the hash is unusable. */
export function hash8(hash: string): string | null {
  const h = hash.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return h.length === 8 ? h : null;
}

/** sources/<this>/ — null when there is no usable hash (never invent a name that cannot be found again). */
export function corpusDirName(title: string, hash: string): string | null {
  const h = hash8(hash);
  return h ? `${slugify(title)}-${h}` : null;
}

/** Find the directory for a source among existing directory names, by its hash suffix alone,
 *  so renaming a source's title never orphans its corpus. */
export function findCorpusDir(dirNames: string[], hash: string): string | null {
  const h = hash8(hash);
  if (!h) return null;
  return dirNames.find((n) => n.endsWith(`-${h}`)) ?? null;
}

const EXT_BY_MEDIA: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** Extension for original.<ext>: from the filename when it has a sane one, else the media type, else bin. */
export function originalExtension(filename?: string, mediaType?: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  if (m) return m[1].toLowerCase();
  const media = (mediaType ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MEDIA[media] ?? 'bin';
}

/** Thin storage seam. Adapters: FileSystemDirectoryHandle (linked folder or OPFS) and test fakes. */
export interface CorpusDir {
  write(name: string, data: string | Uint8Array): Promise<void>;
  readText(name: string): Promise<string | null>;
}
export interface CorpusRoot {
  /** Names of the per-source directories. */
  listDirs(): Promise<string[]>;
  openDir(name: string, create: boolean): Promise<CorpusDir | null>;
}

export type RetainInput = {
  sourceId: string;
  title: string;
  /** Hash of `text` (the Source's own hash); names the version and the folder. */
  hash: string;
  text: string;
  /** Bytes as received, when there are bytes (an uploaded file). Never modified. */
  original?: { bytes: Uint8Array; filename?: string; mediaType?: string };
  generatedAt?: string;
};

export type RetainResult =
  | { status: 'retained'; dir: string; files: string[] }
  | { status: 'blocked' }
  | { status: 'skipped'; reason: 'no-hash' | 'no-text' }
  | { status: 'failed'; error: string };

/** Retain a source. Never throws: a storage failure is a result, not an exception. */
export async function retainSource(root: CorpusRoot, input: RetainInput): Promise<RetainResult> {
  if (!input.text) return { status: 'skipped', reason: 'no-text' };
  // The same gate ingest applies to statements: blocked material is not quietly written to disk.
  if (classifyText(input.text).rating === 'blocked') return { status: 'blocked' };
  const dirName = corpusDirName(input.title, input.hash);
  if (!dirName) return { status: 'skipped', reason: 'no-hash' };
  try {
    const dir = await root.openDir(dirName, true);
    if (!dir) return { status: 'failed', error: 'could not open source directory' };
    const files: string[] = [];
    const put = async (name: string, data: string | Uint8Array) => { await dir.write(name, data); files.push(name); };
    if (input.original) {
      await put(`${ORIGINAL_BASENAME}.${originalExtension(input.original.filename, input.original.mediaType)}`, input.original.bytes);
    }
    await put(TEXT_FILE, input.text);
    const ttl = chunksToTurtle({
      sourceId: input.sourceId,
      title: input.title,
      sha256: input.hash,
      chunks: chunkText(input.text),
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    });
    await put(CHUNKS_FILE, ttl);
    return { status: 'retained', dir: dirName, files };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** The retained plain text for a source (by hash), or null when none was kept or it is unreadable. */
export async function readRetainedText(root: CorpusRoot, hash: string): Promise<string | null> {
  try {
    const name = findCorpusDir(await root.listDirs(), hash);
    if (!name) return null;
    const dir = await root.openDir(name, false);
    return (await dir?.readText(TEXT_FILE)) ?? null;
  } catch {
    return null;
  }
}
