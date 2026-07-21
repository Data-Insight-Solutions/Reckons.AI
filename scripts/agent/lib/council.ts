/**
 * Council tally — the deterministic core of the tri-party orchestrator council
 * (Matt + Claude + Codex). See F102 "Poseidon's Council" / kb:orch-control-layers.
 *
 * This module holds NO model calls and NO I/O in its core (`tallyFindings`), so it
 * is right-by-construction and fully unit-testable. The model voices live in
 * `codex.ts` (Codex) and in Claude Code itself (Opus); this file only takes the
 * findings each voice produced and records WHO ASSERTED WHAT.
 *
 * Two F102 principles are enforced structurally here, not left to good intentions:
 *  - MODEL AGREEMENT IS NOT INDEPENDENT EVIDENCE. A tally is a provenance record
 *    (asserted-by per member), never a probability. There is deliberately no score.
 *  - LEAD WITH DISAGREEMENT. `tallyFindings` returns split rows FIRST, most-contested
 *    first — the split is the only part carrying information; agreement flows quietly.
 */
import { appendFileSync } from 'fs';

export type MemberId = string; // e.g. 'local:qwen3-coder', 'claude', 'codex'

export interface Finding {
  /** Optional file the finding is about (code review); omitted for design positions. */
  file?: string;
  /** The finding / claim / position, as the member phrased it. */
  text: string;
}

/**
 * What one member contributed. A member that could not run (Codex not installed, not
 * authenticated, timed out) is recorded with `ok:false` and a reason — NEVER dropped
 * silently. A council that quietly ran one voice is not a council; the
 * code-review.ts cold-model incident is the cautionary tale.
 */
export interface MemberResult {
  member: MemberId;
  ok: boolean;
  reason?: string;
  findings: Finding[];
}

export type Agreement = 'agreed' | 'split';

export interface TalliedFinding {
  text: string;
  file?: string;
  /** Which PRESENT members raised this finding. */
  assertedBy: MemberId[];
  /**
   * 'agreed' only when ≥2 members ran AND every present member raised it — real
   * corroboration. Everything else is 'split': a present member dissented, or fewer
   * than two voices were present so no corroboration was possible.
   */
  agreement: Agreement;
}

export interface CouncilTally {
  presentMembers: MemberId[];
  missingMembers: { member: MemberId; reason?: string }[];
  /** Split rows first, most-contested (fewest asserters) first; agreed rows last. */
  findings: TalliedFinding[];
  /** True only when the tally reflects ≥2 present voices — i.e. corroboration was possible. */
  quorum: boolean;
}

/**
 * Normalize a finding to a match key. Exact-after-normalize matching is deliberately
 * CONSERVATIVE: two members phrasing the same bug differently will NOT merge and both
 * show as single-asserter split rows. Over-reporting disagreement is the safe error —
 * it sends more to the human, never fabricates agreement. (Upgrade path: fuzzy-cluster
 * with src/lib/rdf/lexical-similarity.ts before tallying.)
 */
export function normalizeKey(f: Finding): string {
  const text = f.text
    .toLowerCase()
    .replace(/^[-*\d.)\s]+/, '') // strip list markers
    .replace(/\s+/g, ' ')
    .trim();
  return `${(f.file ?? '').trim()} ${text}`;
}

export function tallyFindings(results: MemberResult[]): CouncilTally {
  const present = results.filter((r) => r.ok);
  const presentMembers = present.map((r) => r.member);
  const missingMembers = results
    .filter((r) => !r.ok)
    .map((r) => ({ member: r.member, reason: r.reason }));
  const quorum = presentMembers.length >= 2;

  // Group present members' findings by normalized key, preserving first-seen text/file.
  const groups = new Map<string, { text: string; file?: string; by: Set<MemberId> }>();
  for (const r of present) {
    for (const f of r.findings) {
      const key = normalizeKey(f);
      const g = groups.get(key);
      if (g) g.by.add(r.member);
      else groups.set(key, { text: f.text.trim(), file: f.file, by: new Set([r.member]) });
    }
  }

  const findings: TalliedFinding[] = [...groups.values()].map((g) => {
    const assertedBy = [...g.by];
    const agreement: Agreement =
      quorum && assertedBy.length === presentMembers.length ? 'agreed' : 'split';
    return { text: g.text, file: g.file, assertedBy, agreement };
  });

  // LEAD WITH DISAGREEMENT: split rows first; among splits, fewest asserters first
  // (a lone catch is either the sharpest finding or the likeliest false positive —
  // either way it is what the human must look at). Agreed rows sink to the bottom.
  findings.sort((a, b) => {
    if (a.agreement !== b.agreement) return a.agreement === 'split' ? -1 : 1;
    if (a.agreement === 'split' && a.assertedBy.length !== b.assertedBy.length)
      return a.assertedBy.length - b.assertedBy.length;
    return 0;
  });

  return { presentMembers, missingMembers, findings, quorum };
}

/**
 * Append council findings to the pending queue as PROPOSALS for the Review tab.
 * Mirrors the record shape used by scripts/offline/code-review.ts `queue()`. Each row
 * carries asserted-by and the agreement so the reviewer sees the split, never a score.
 * verifiable-by stays 'unknown' → per kb:verifiability-axis it fails toward the human.
 */
export function recordCouncil(
  tally: CouncilTally,
  opts: {
    subjectFor: (f: TalliedFinding) => string;
    predicate: string;
    agent: string;
    pendingPath: string;
    priority?: 'low' | 'medium' | 'high';
  }
): number {
  let written = 0;
  for (const f of tally.findings) {
    const asserted = f.assertedBy.join(', ');
    const tag = f.agreement === 'agreed' ? `[council ${asserted}]` : `[council SPLIT — only ${asserted}]`;
    const line = JSON.stringify({
      subject: opts.subjectFor(f),
      predicate: opts.predicate,
      question: `${tag} ${f.file ? f.file + ': ' : ''}${f.text}`.slice(0, 800),
      type: 'suggestion',
      agent: opts.agent,
      assertedBy: f.assertedBy,
      agreement: f.agreement,
      verifiableBy: 'unknown',
      priority: opts.priority ?? 'medium',
      addedAt: new Date().toISOString(),
      addedByMcp: true,
    });
    appendFileSync(opts.pendingPath, line + '\n');
    written++;
  }
  return written;
}
