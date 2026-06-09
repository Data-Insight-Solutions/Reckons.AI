/**
 * KB package — zip export/import for portable KB bundles.
 *
 * A kb-export.zip contains:
 *   kb-snapshot.ttl          — all confirmed/refined statements + asset reference triples
 *   media/<filename>.*       — one file per assigned entity image (GIF, PNG, JPG, SVG, WebP, etc.)
 *   models/<filename>.glb    — one file per assigned entity GLB model
 *
 * The TTL includes triples of the form:
 *   <entity_iri>  <urn:kbase:meta/gifPreview>  "media/filename.gif" .
 *   <entity_iri>  <urn:kbase:meta/glbModel>    "models/filename.glb" .
 *
 * On import the zip is extracted, GIFs/GLBs are stored via setGif()/setGlb(),
 * then the TTL is fed through the normal ingest pipeline.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { toTurtle } from '../rdf/serialize';
import type { Statement } from '../rdf/types';

const GIF_PREVIEW_PREDICATE = 'urn:kbase:meta/gifPreview';
const GLB_MODEL_PREDICATE = 'urn:kbase:meta/glbModel';

/**
 * Build a zip bundle: TTL (with asset reference triples appended) + all GIF/GLB blobs.
 *
 * @param statements  Confirmed/refined statements to export as Turtle.
 * @param gifRows     Rows from db.entityGifs (id=IRI, blob, filename).
 * @param glbRows     Rows from db.glbOverrides (id=IRI, url). Data URLs are inlined; remote URLs are referenced.
 */
export async function buildGifPackage(
  statements: Statement[],
  gifRows: Array<{ id: string; blob: Blob; filename: string }>,
  glbRows?: Array<{ id: string; url: string }>
): Promise<Uint8Array> {
  // Base TTL from confirmed statements
  let ttl = toTurtle(statements);

  // Build fflate file map
  const files: Record<string, Uint8Array> = {};

  // Append gifPreview triples and bundle GIF blobs
  if (gifRows.length > 0) {
    ttl += '\n# Image preview references\n';
    for (const row of gifRows) {
      const safeFilename = sanitizeFilename(row.filename);
      ttl += `<${row.id}> <${GIF_PREVIEW_PREDICATE}> "media/${safeFilename}" .\n`;
      const arrayBuffer = await row.blob.arrayBuffer();
      files[`media/${safeFilename}`] = new Uint8Array(arrayBuffer);
    }
  }

  // Append glbModel triples and bundle GLB blobs (data URLs only)
  if (glbRows && glbRows.length > 0) {
    ttl += '\n# GLB model references\n';
    for (const row of glbRows) {
      if (row.url.startsWith('data:')) {
        // Inline data URL → extract binary and bundle
        const filename = iriToGlbFilename(row.id);
        const bytes = dataUrlToBytes(row.url);
        if (bytes) {
          files[`models/${filename}`] = bytes;
          ttl += `<${row.id}> <${GLB_MODEL_PREDICATE}> "models/${filename}" .\n`;
        }
      } else {
        // Remote URL — store the URL as a literal reference (no binary to bundle)
        ttl += `<${row.id}> <${GLB_MODEL_PREDICATE}> "${row.url}" .\n`;
      }
    }
  }

  files['kb-snapshot.ttl'] = strToU8(ttl);
  return zipSync(files, { level: 0 }); // level 0 = store only (media is already compressed)
}

/**
 * Extract a kb-export.zip bundle.
 *
 * Returns the TTL string and maps of relative path → Blob for GIFs and GLBs.
 * Throws if no `kb-snapshot.ttl` is found in the zip.
 */
export function extractGifPackage(zipBytes: Uint8Array): {
  ttl: string;
  gifs: Map<string, Blob>; // relative path (e.g. "media/foo.gif") → Blob
  glbs: Map<string, Blob>; // relative path (e.g. "models/foo.glb") → Blob
} {
  const extracted = unzipSync(zipBytes);

  const ttlEntry = extracted['kb-snapshot.ttl'];
  if (!ttlEntry) {
    throw new Error('Invalid kb-export.zip: missing kb-snapshot.ttl');
  }

  const ttl = strFromU8(ttlEntry);
  const gifs = new Map<string, Blob>();
  const glbs = new Map<string, Blob>();

  for (const [path, bytes] of Object.entries(extracted)) {
    if (path.startsWith('media/') && path !== 'media/') {
      gifs.set(path, new Blob([bytes], { type: mediaMimeType(path) }));
    } else if (path.startsWith('models/') && path !== 'models/') {
      glbs.set(path, new Blob([bytes], { type: 'model/gltf-binary' }));
    }
  }

  return { ttl, gifs, glbs };
}

/**
 * Scan TTL text for gifPreview triples.
 *
 * Returns a map of entity IRI → relative path (e.g. "media/foo.gif").
 * Handles both full IRI syntax: <iri> <pred> "path" .
 */
export function parseGifPreviewTriples(ttl: string): Map<string, string> {
  const result = new Map<string, string>();
  // Match: <subjectIRI> <urn:kbase:meta/gifPreview> "media/..." .
  const re = /<([^>]+)>\s+<urn:kbase:meta\/gifPreview>\s+"([^"]+)"\s*\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ttl)) !== null) {
    result.set(m[1], m[2]);
  }
  return result;
}

/**
 * Scan TTL text for glbModel triples.
 *
 * Returns a map of entity IRI → value (either "models/filename.glb" or a remote URL).
 */
export function parseGlbModelTriples(ttl: string): Map<string, string> {
  const result = new Map<string, string>();
  const re = /<([^>]+)>\s+<urn:kbase:meta\/glbModel>\s+"([^"]+)"\s*\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ttl)) !== null) {
    result.set(m[1], m[2]);
  }
  return result;
}

/** Guess MIME type from file extension for media assets. */
function mediaMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'svg':  return 'image/svg+xml';
    case 'gif':  return 'image/gif';
    default:     return 'application/octet-stream';
  }
}

/** Strip path separators and null bytes from a filename. */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\?%*:|"<>\x00]/g, '_');
}

/** Convert an IRI to a safe GLB filename. */
function iriToGlbFilename(iri: string): string {
  const slug = iri.replace(/^.*[/:]/g, '') || 'model';
  return sanitizeFilename(slug) + '.glb';
}

/** Convert a data URL to raw bytes. Returns null if parsing fails. */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  try {
    const match = dataUrl.match(/^data:[^;]*;base64,(.+)$/);
    if (!match) return null;
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
