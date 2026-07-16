/**
 * KB Asset System — standardised binary asset management for workspace folders and zip exports.
 *
 * Three asset slots per entity, each with a specific graph usage:
 *
 *   icon     — 2D node icon (SVG, PNG, emoji)        shown ON the node
 *   preview  — hover preview (GIF, PNG, JPG, WebP)    shown on long-hover tooltip
 *   model    — 3D node model (GLB)                    replaces procedural geometry in 3D view
 *
 * Workspace folder layout (directories only created when populated):
 *
 *   kbs/my-kb/
 *     my-kb.ttl                     human-readable, no base64 blobs
 *                                    (legacy: kb.ttl — read as a fallback,
 *                                    no longer written on export)
 *     assets/
 *       icons/reckons-ai.svg        2D node face
 *       previews/turtle.gif         hover preview image
 *       models/reckons-ai.glb       3D node shape
 *
 * TTL references use relative paths with the urn:kbase:asset/ namespace:
 *
 *   @prefix kasset: <urn:kbase:asset/> .
 *
 *   <urn:reckons:guide/ReckonsAI>
 *       kasset:icon    "assets/icons/reckons-ai.svg" ;
 *       kasset:preview "assets/previews/turtle.gif" ;
 *       kasset:model   "assets/models/reckons-ai.glb" .
 *
 * External URLs (e.g. Meshy CDN, remote images) stay as URL literals — no binary written:
 *
 *   <urn:entity/foo> kasset:model "https://cdn.meshy.ai/model.glb" .
 *
 * Emoji icons stay as plain literals (not files):
 *
 *   <urn:entity/foo> kasset:icon  "🐢" .
 */

import type { KBaseDB } from './db';

// ── Asset predicates ────────────────────────────────────────────────────────

export const ASSET_PREFIX  = 'urn:kbase:asset/';
export const ASSET_ICON    = 'urn:kbase:asset/icon';
export const ASSET_PREVIEW = 'urn:kbase:asset/preview';
export const ASSET_MODEL   = 'urn:kbase:asset/model';

// ── Legacy predicate mapping (recognised on import) ─────────────────────────

export const LEGACY_TO_ASSET: Record<string, string> = {
  'urn:kbase:predicate/icon2d': ASSET_ICON,
  'urn:kbase:meta/gifPreview':  ASSET_PREVIEW,
  'urn:kbase:meta/glbModel':    ASSET_MODEL,
};

// ── Categories ──────────────────────────────────────────────────────────────

export type AssetCategory = 'icons' | 'previews' | 'models';

export const PREDICATE_TO_DIR: Record<string, AssetCategory> = {
  [ASSET_ICON]:    'icons',
  [ASSET_PREVIEW]: 'previews',
  [ASSET_MODEL]:   'models',
};

export const DIR_TO_PREDICATE: Record<AssetCategory, string> = {
  icons:    ASSET_ICON,
  previews: ASSET_PREVIEW,
  models:   ASSET_MODEL,
};

// ── Collected asset (ready for file system write) ───────────────────────────

export type CollectedAsset = {
  entityIri: string;
  category: AssetCategory;
  filename: string;
  data: Uint8Array;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive a filesystem-safe filename stem from an IRI. */
export function iriToStem(iri: string): string {
  const slug = iri.replace(/^.*[/:#]/g, '').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'entity';
  return slug.slice(0, 80);
}

/** Strip dangerous characters from a filename. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>\x00]/g, '_');
}

/** Extract binary data + extension from a data URL. Returns null if not a data URL. */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const match = dataUrl.match(/^data:([^;]*);base64,(.+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, ext: mimeToExt(match[1]) };
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'model/gltf-binary': 'glb', 'application/octet-stream': 'bin',
  };
  return map[mime] ?? mime.split('/').pop() ?? 'bin';
}

/** Guess MIME type from file extension. */
export function extToMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  };
  return map[ext ?? ''] ?? 'application/octet-stream';
}

// ── Collect binary assets from IndexedDB ────────────────────────────────────

/**
 * Gather all binary assets from IndexedDB editor override tables.
 *
 * Only includes actual binary data (data URLs → bytes, Blobs → bytes).
 * External URLs, emoji strings, and static paths are NOT collected —
 * they stay as literal values in the TTL and don't need asset files.
 */
export async function collectAssets(database: KBaseDB): Promise<CollectedAsset[]> {
  const assets: CollectedAsset[] = [];

  // Icons — only data URLs (skip emoji, external URLs, static paths)
  const iconRows = await database.icon2dOverrides.toArray();
  for (const row of iconRows) {
    const parsed = dataUrlToBytes(row.url);
    if (parsed) {
      assets.push({
        entityIri: row.id,
        category: 'icons',
        filename: `${iriToStem(row.id)}.${parsed.ext}`,
        data: parsed.bytes,
      });
    }
  }

  // Previews — always Blobs
  const gifRows = await database.entityGifs.toArray();
  for (const row of gifRows) {
    const ab = await row.blob.arrayBuffer();
    assets.push({
      entityIri: row.id,
      category: 'previews',
      filename: sanitizeFilename(row.filename),
      data: new Uint8Array(ab),
    });
  }

  // Models — only data URLs (skip remote Meshy URLs etc.)
  const glbRows = await database.glbOverrides.toArray();
  for (const row of glbRows) {
    const parsed = dataUrlToBytes(row.url);
    if (parsed) {
      assets.push({
        entityIri: row.id,
        category: 'models',
        filename: `${iriToStem(row.id)}.glb`,
        data: parsed.bytes,
      });
    }
  }

  return assets;
}

// ── TTL generation ──────────────────────────────────────────────────────────

/**
 * Generate TTL lines referencing collected assets by relative path.
 * Returns empty string if no assets. Groups by category for readability.
 *
 * Also includes non-binary overrides (external URLs for models, emoji/URL icons)
 * as literal-valued triples so they survive the round-trip.
 */
export async function assetTriples(
  database: KBaseDB,
  binaryAssets: CollectedAsset[]
): Promise<string> {
  // Collect IRIs that already have a binary file
  const binaryIris = {
    icons: new Set(binaryAssets.filter(a => a.category === 'icons').map(a => a.entityIri)),
    previews: new Set(binaryAssets.filter(a => a.category === 'previews').map(a => a.entityIri)),
    models: new Set(binaryAssets.filter(a => a.category === 'models').map(a => a.entityIri)),
  };

  const lines: string[] = [];

  // Binary assets → relative path references
  const byCategory = new Map<AssetCategory, CollectedAsset[]>();
  for (const a of binaryAssets) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  const labels: Record<AssetCategory, string> = {
    icons: '2D node icons', previews: 'Hover preview images', models: '3D node models',
  };

  for (const cat of ['icons', 'previews', 'models'] as AssetCategory[]) {
    const entries = byCategory.get(cat);
    if (!entries?.length) continue;
    lines.push(`# ${labels[cat]}`);
    const pred = DIR_TO_PREDICATE[cat];
    for (const e of entries) {
      lines.push(`<${e.entityIri}> <${pred}> "assets/${cat}/${e.filename}" .`);
    }
  }

  // Non-binary icon overrides (emoji, external URLs, static paths)
  const iconRows = await database.icon2dOverrides.toArray();
  const nonBinaryIcons = iconRows.filter(r => !binaryIris.icons.has(r.id));
  if (nonBinaryIcons.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('# Icon overrides (non-binary)');
    for (const row of nonBinaryIcons) {
      const escaped = row.url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(`<${row.id}> <${ASSET_ICON}> "${escaped}" .`);
    }
  }

  // Non-binary model overrides (remote URLs like Meshy CDN)
  const glbRows = await database.glbOverrides.toArray();
  const nonBinaryModels = glbRows.filter(r => !binaryIris.models.has(r.id));
  if (nonBinaryModels.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('# Model references (remote URLs)');
    for (const row of nonBinaryModels) {
      lines.push(`<${row.id}> <${ASSET_MODEL}> "${row.url}" .`);
    }
  }

  if (lines.length === 0) return '';
  return '\n# Asset references\n' + lines.join('\n') + '\n';
}

// ── TTL parsing ─────────────────────────────────────────────────────────────

export type AssetRef = {
  entityIri: string;
  category: AssetCategory;
  /** The literal value — either a relative path ("assets/icons/foo.svg") or a URL/emoji */
  value: string;
};

/**
 * Parse asset reference triples from TTL text.
 * Recognises both new `urn:kbase:asset/*` and legacy predicates.
 */
export function parseAssetRefs(ttl: string): AssetRef[] {
  const results: AssetRef[] = [];
  const seen = new Set<string>();

  const allPredicates: Record<string, AssetCategory> = {
    ...PREDICATE_TO_DIR,
    // Legacy
    'urn:kbase:predicate/icon2d': 'icons',
    'urn:kbase:meta/gifPreview':  'previews',
    'urn:kbase:meta/glbModel':    'models',
  };

  for (const [pred, cat] of Object.entries(allPredicates)) {
    // Escape ALL regex metacharacters in the predicate IRI, not just '/' — otherwise a '.' or '('
    // in a predicate would be interpreted as regex syntax, mis-matching or breaking the pattern.
    // Fixes js/incomplete-sanitization (CodeQL).
    const escaped = pred.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const re = new RegExp(`<([^>]+)>\\s+<${escaped}>\\s+"([^"]+)"\\s*\\.`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(ttl)) !== null) {
      const key = `${m[1]}|${cat}`;
      if (seen.has(key)) continue; // new predicate takes priority over legacy
      seen.add(key);
      results.push({ entityIri: m[1], category: cat, value: m[2] });
    }
  }

  return results;
}

/** Check if an asset value is a relative file path (vs. URL or emoji). */
export function isAssetPath(value: string): boolean {
  return value.startsWith('assets/') || value.startsWith('media/') || value.startsWith('models/');
}
