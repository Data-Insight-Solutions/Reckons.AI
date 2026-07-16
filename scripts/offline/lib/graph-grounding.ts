/**
 * Graph grounding for offline agents — let a local model QUERY the graph before it judges.
 *
 * The work-tiering rule is ground → prompt → validate → emit-proposal, and GROUND means: ask the
 * graph "what is this?" before spending the model on it. A code reviewer that sees only a diff
 * cannot know what the code is SUPPOSED to do; a describer that sees only a bare triple cannot know
 * an entity's role. That knowledge already lives in the graph — the same thing the MCP kb_* tools
 * expose (has-file ownership, an entity's purpose/status, keyword search). This reuses it directly
 * so a standalone offline script gets graph grounding without spawning the MCP server.
 *
 * The reference graphs are static/*.ttl (the source of truth the workspace KBs are copied from).
 * The pure lookups take an injectable quad array so they are testable without touching disk.
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
/** Predicates that link an entity to a file it owns (Codebase/Production KBs). */
export const FILE_PREDS = [`${KPRED}has-file`, `${KPRED}tested-by`];

let _cache: Quad[] | null = null;
/** Load every static/*.ttl into one quad array (memoized). Parse errors are skipped — graph-lint
 *  is the job that reports them; grounding just works with what parses. */
export function loadGraphQuads(dir = 'static'): Quad[] {
  if (_cache) return _cache;
  const out: Quad[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ttl')).sort()) {
    try {
      out.push(...new Parser().parse(readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      /* skip unparseable file */
    }
  }
  _cache = out;
  return out;
}

const oneOf = (quads: Quad[], subject: string, pred: string): string | undefined =>
  quads.find((q) => q.subject.value === subject && q.predicate.value === pred)?.object.value;

export interface FileOwner {
  iri: string;
  label: string;
  status?: string;
  description?: string;
  /** Which predicate tied the file to the entity (has-file / tested-by). */
  via: string;
}

/**
 * Which entity DECLARES this file (reverse has-file/tested-by lookup), with its purpose and status
 * — the "what is this file supposed to be" grounding. Matches an exact path or a repo-relative
 * suffix either way, since the graph stores repo-relative paths and callers may pass either.
 */
export function ownerOfFile(filePath: string, quads: Quad[] = loadGraphQuads()): FileOwner | null {
  const norm = filePath.replace(/^\.\//, '');
  for (const pred of FILE_PREDS) {
    const hit = quads.find(
      (q) =>
        q.predicate.value === pred &&
        (q.object.value === norm || norm.endsWith(q.object.value) || q.object.value.endsWith(norm)),
    );
    if (hit) {
      const iri = hit.subject.value;
      return {
        iri,
        label: oneOf(quads, iri, RDFS_LABEL) ?? iri.split(/[/#]/).pop() ?? iri,
        status: oneOf(quads, iri, `${KPRED}has-status`),
        description: oneOf(quads, iri, `${KPRED}description`),
        via: pred.split('/').pop() ?? pred,
      };
    }
  }
  return null;
}

/**
 * A compact grounding block for a file — the owning entity, its status and purpose — or '' if the
 * graph knows nothing about it (in which case the agent simply reviews without intent context, no
 * worse than before). The description is capped so it never crowds the local model's context.
 */
export function groundFile(filePath: string, quads: Quad[] = loadGraphQuads()): string {
  const o = ownerOfFile(filePath, quads);
  if (!o) return '';
  const status = o.status ? ` [${o.status}]` : '';
  const purpose = o.description ? `\n  what it is for: ${o.description.slice(0, 400)}` : '';
  return `Graph says ${filePath} belongs to "${o.label}"${status} (via ${o.via}).${purpose}`;
}
