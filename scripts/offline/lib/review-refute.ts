/**
 * Refute local-review findings that the file itself disproves (F74.2, script tier inside the
 * agent-tier harness: ground → prompt → VALIDATE → emit).
 *
 * WHY. qwen3-coder raised the same two misreads on 2026-10-02 and again on 2026-10-06, and each
 * time Opus spent a triage pass proving them wrong by reading the file: "missing import of X"
 * where X is imported a few lines up (the model sees a diff hunk, not the import block), and
 * "duplicate RDF property; the second overrides the first" on Turtle, where a predicate repeated
 * on one subject adds a value and overrides nothing. Both are checkable by rule, so the promotion
 * ladder says the rule belongs here, not in a triage queue.
 *
 * NARROW ON PURPOSE. A rule only refutes a finding it can disprove from the file's current text.
 * Anything it cannot parse is left alone and still queued: a missed refutation costs one triage
 * read; a wrong one hides a real defect. Refutations are printed with their reason, never silent.
 */

export type Refutation = { rule: 'imported' | 'rdf-repeatable'; reason: string };

const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/** The identifier a "missing import" finding names, if it names exactly one. */
export function missingImportName(finding: string): string | null {
  const patterns = [
    new RegExp(String.raw`missing import(?:\s+(?:of|for))?\s+[\`'"]?(${IDENT})`, 'i'),
    new RegExp(String.raw`[\`'"](${IDENT})[\`'"]\s+is\s+(?:not|never)\s+imported`, 'i'),
    new RegExp(String.raw`(?:not|never)\s+imported[:\s]+[\`'"]?(${IDENT})`, 'i'),
  ];
  for (const re of patterns) {
    const m = finding.match(re);
    if (m) return m[1];
  }
  return null;
}

/** 1-based line of an import statement that binds `name`, or null. Handles multi-line braces. */
export function importLineOf(source: string, name: string): number | null {
  const re = /^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm;
  for (const m of source.matchAll(re)) {
    const clause = m[1];
    const bound = new Set<string>();
    const ns = clause.match(new RegExp(String.raw`\*\s+as\s+(${IDENT})`));
    if (ns) bound.add(ns[1]);
    const def = clause.match(new RegExp(String.raw`^(${IDENT})\s*(?:,|$)`));
    if (def) bound.add(def[1]);
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const spec = part.trim().replace(/^type\s+/, '');
        const alias = spec.match(new RegExp(String.raw`\bas\s+(${IDENT})$`));
        const plain = spec.match(new RegExp(String.raw`^(${IDENT})$`));
        if (alias) bound.add(alias[1]); else if (plain) bound.add(plain[1]);
      }
    }
    if (bound.has(name)) return source.slice(0, (m.index ?? 0) + m[0].indexOf('import')).split('\n').length;
  }
  return null;
}

const DUPLICATE_PREDICATE = /\bduplicate\b[^.]*\b(?:property|predicate|triple|scopeNote|progress|note)\b|\b(?:second|later)\b[^.]*\boverrides?\b/i;

export function refuteFinding(file: string, finding: string, source: string | null): Refutation | null {
  if (/\.(?:ttl|trig|nt|nq)$/i.test(file) && DUPLICATE_PREDICATE.test(finding)) {
    return {
      rule: 'rdf-repeatable',
      reason: 'RDF predicates are multi-valued: repeating one on a subject adds a value and overrides nothing',
    };
  }
  if (source !== null && /\.(?:[cm]?[jt]sx?|svelte)$/i.test(file)) {
    const name = missingImportName(finding);
    const line = name ? importLineOf(source, name) : null;
    if (name && line !== null) return { rule: 'imported', reason: `${name} is imported at line ${line}` };
  }
  return null;
}
