/**
 * WHERE SHOULD AN IMPORTED GRAPH LAND — the existing copy, or a new one?
 *
 * THE BUG THIS FIXES (reported by Matt, 2026-08-13: five duplicated names in his own
 * registry, each covering more than one independent copy). Three import paths already ask
 * this question and answer it correctly — drive-sync matches on stableId then name,
 * workspace import skips known names and stableIds, and the docs-leap path reuses a found
 * entry — but the FILE IMPORT on the ingest page calls createKb() unconditionally, with no
 * registry check of any kind. Re-importing reckons-roadmap.ttl therefore mints a second
 * database with the same name every single time.
 *
 * The duplicates are not cosmetic. Two graphs with one name disagree the moment either is
 * edited, and the name alone cannot tell you which one you are looking at — so a user can
 * confidently edit the copy nobody reads. The graphs page reports them and deliberately
 * never auto-removes them, because which copy is real is a judgement about content; this
 * module stops them being created in the first place, which is the half that can be
 * automated safely.
 *
 * THE TWO SIGNALS ARE NOT EQUALLY STRONG, and conflating them is how an import destroys
 * work:
 *
 *   STABLE ID — a durable identity minted with the graph and carried in its settings.
 *     A match means "this IS that graph, newer". Replacing in place is correct, and
 *     ingestExistingKb takes a recovery snapshot before it does so.
 *
 *   NAME — a label a human typed, or a filename. "roadmap.ttl" from two different projects
 *     collides trivially. A name match means "possibly the same graph", which is NOT
 *     enough to overwrite somebody's data. It is enough to warn, and to offer the choice.
 *
 * So this returns a decision plus its basis, and the caller must not treat the two the same.
 */

import type { KbEntry } from './kb-registry';

export type ImportTarget =
  /** Same graph identity — safe to replace in place (a snapshot is taken first). */
  | { kind: 'replace'; entry: KbEntry; basis: 'stable-id' }
  /** Same NAME only, or a STALE identity match. Ambiguous: ask, never overwrite silently. */
  | { kind: 'ambiguous'; entry: KbEntry; basis: 'name' | 'stale' }
  /** Nothing like it in the registry — create a new graph. */
  | { kind: 'create' };

/**
 * The `# generated <ISO>` line the exporter writes at the top of every annotated export.
 *
 * Parsed rather than ignored because of a hazard this module's own fix introduces. Once every
 * exported copy carries a stable id (workspace syncAllKbs mints one), an identity match becomes
 * automatic — which is the point, but it also means importing an OLD copy of a graph would
 * silently replace a newer one. Several file copies in different workspace roots is exactly
 * the situation where that happens: the stale root still holds a perfectly valid, perfectly
 * identified, months-out-of-date export.
 *
 * So identity answers "is this the same graph"; the timestamp answers "is this a newer version
 * of it", and replacing needs both.
 */
export function parseGeneratedAt(ttl: string): number | undefined {
  const m = ttl.slice(0, 400).match(/^#\s*generated\s+(\S+)/m);
  if (!m) return undefined;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : undefined;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.(ttl|turtle|zip|n3|nq)$/i, '');
}

/**
 * Decide where an import should land.
 *
 * `excludeId` lets a caller ignore one entry — used when re-importing INTO a known graph, so
 * it does not match itself and report an ambiguity that does not exist.
 */
export function resolveImportTarget(
  meta: { name: string; stableId?: string; generatedAt?: number },
  registry: readonly KbEntry[],
  excludeId?: string,
): ImportTarget {
  const candidates = registry.filter((e) => e.id !== excludeId);

  if (meta.stableId) {
    const byStableId = candidates.find((e) => e.stableId === meta.stableId);
    if (byStableId) {
      // Same graph — but is it a NEWER version of it? A stale export from an abandoned
      // workspace root is correctly identified and still the wrong thing to restore.
      // Unknown timestamps do not block: an export predating the generated-at header, or a
      // hand-written TTL, must stay importable.
      const stale =
        meta.generatedAt !== undefined &&
        byStableId.lastModified !== undefined &&
        meta.generatedAt < byStableId.lastModified;
      return stale
        ? { kind: 'ambiguous', entry: byStableId, basis: 'stale' }
        : { kind: 'replace', entry: byStableId, basis: 'stable-id' };
    }
  }

  const target = normalizeName(meta.name);
  const byName = candidates.find((e) => normalizeName(e.name) === target);
  if (byName) {
    // A name match against an entry that HAS a different stableId is positively evidence of
    // two different graphs sharing a label — never a replace.
    return { kind: 'ambiguous', entry: byName, basis: 'name' };
  }

  return { kind: 'create' };
}

/**
 * A non-colliding name for a graph the user has chosen to keep separate.
 *
 * Appending a counter is deliberately plain. The alternative — a timestamp or a uuid — is
 * unreadable in a list, and the whole problem being solved is that a user cannot tell two
 * rows apart by name.
 */
export function uniqueKbName(name: string, registry: readonly KbEntry[]): string {
  const taken = new Set(registry.map((e) => normalizeName(e.name)));
  if (!taken.has(normalizeName(name))) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(normalizeName(candidate))) return candidate;
  }
  return `${name} (${Date.now()})`;
}
