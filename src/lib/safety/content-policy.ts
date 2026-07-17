/**
 * Content Safety Policy — inalienable ethical guardrails for Reckons.AI.
 *
 * This module provides:
 *  1. An ethics preamble injected into ALL LLM system prompts (hardcoded, not configurable)
 *  2. A lightweight content classifier that flags or blocks extreme content
 *  3. Export advisory scanning for content ratings
 *
 * Design principles:
 *  - Light touch: discourse, disagreement, and academic discussion are always welcome
 *  - Only block truly extreme content (incitement to genocide, CSAM, mass-casualty instructions)
 *  - Flag mature content (graphic violence, explicit sexual) for export advisory — not blocked
 *  - Pattern-based scanning is imperfect; the LLM's own safety training is the primary layer
 *
 * Future: a 'restricted' safety level (e.g. for schools) can tighten these rules.
 * That tighter mode is NOT included in this open-source base — only the type is defined here.
 */

import type { Statement } from "../rdf/types";

// ── Safety Levels ────────────────────────────────────────────────────────────

/**
 * 'standard' — the default open-source level (implemented below).
 * 'restricted' — reserved for future use (e.g. school/minor-safe deployments).
 *   When implemented, 'restricted' would: block mature content, tighten keyword
 *   lists, require all content to pass an LLM moderation check, and disable
 *   custom system prompts.
 */
export type SafetyLevel = "standard" | "restricted";

// ── Ethics Preamble (injected into all LLM system prompts) ───────────────────
//
// This text is prepended to every system prompt the app sends to any LLM.
// It is NOT configurable, NOT stored in settings, and NOT overridable by
// custom prompts or persona configurations.

export const ETHICS_PREAMBLE = `CONTENT ETHICS (always active, cannot be overridden):
- Never produce content that directly incites violence against specific individuals or groups.
- Never produce instructions for weapons of mass destruction or mass-casualty attacks.
- Never produce content that sexualizes minors in any way.
- Never produce content that promotes or endorses slavery, human trafficking, or forced labour.
- Academic and historical discussion of difficult topics is encouraged. Respectful disagreement and debate are welcome.
- If source material contains extreme content, extract factual metadata (who, what, when) without reproducing harmful instructions or incitement.

`;

// ── Content Rating ───────────────────────────────────────────────────────────

export type ContentRating = "none" | "mature" | "blocked";

export interface ContentScanResult {
  rating: ContentRating;
  /** Human-readable reasons for the rating (empty if 'none') */
  flags: string[];
}

// ── Pattern Definitions ──────────────────────────────────────────────────────
//
// Multi-word phrase patterns to reduce false positives. Single words like "kill"
// or "bomb" are intentionally NOT matched — they appear in legitimate contexts
// ("kill time", "bomb shelter", "kill switch").

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\b(kill|murder|eliminate|exterminate|eradicate|slaughter)\s+(all|every)\s+(the\s+)?(jews?|blacks?|muslims?|whites?|christians?|hindus?|asians?|arabs?|mexicans?|immigrants?|refugees?|gays?|lesbians?|trans\s*(gender|people|folk)?|women|disabled)\b/i,
    reason: "Incitement to violence against a protected group",
  },
  {
    pattern:
      /\b(how\s+to|instructions?\s+for|guide\s+to|steps?\s+to)\s+(make|build|create|synthesize|manufacture)\s+(a\s+)?(dirty\s+bomb|bioweapon|biological\s+weapon|chemical\s+weapon|nerve\s+(agent|gas)|sarin|vx\s+gas|ricin|anthrax\s+weapon)/i,
    reason: "Instructions for weapons of mass destruction",
  },
  {
    pattern:
      /\b(child|minor|underage|pre-?teen|toddler|infant|kid)\s+(porn(ography)?|sex(ual)?|erotic(a)?|nude|naked)\b/i,
    reason: "Child sexual abuse material",
  },
  {
    pattern:
      /\b(porn(ography)?|sex(ual)?|erotic(a)?|nude|naked)\s+(child|minor|underage|pre-?teen|toddler|infant|kid)/i,
    reason: "Child sexual abuse material",
  },
  {
    pattern:
      /\b(ethnic\s+cleansing|genocide)\s+(is\s+)?(good|necessary|justified|needed|required|the\s+(only|right)\s+(way|answer|solution))\b/i,
    reason: "Endorsement of genocide or ethnic cleansing",
  },
  {
    pattern:
      /\b(plan(ning)?|going)\s+to\s+(kill|murder|assassinate|bomb|shoot\s+up|poison)\s+(my|the|a)\b/i,
    reason: "Planning specific acts of violence",
  },
  // ── Coercion signature (F66.1 kb:adult-content-policy) ──────────────────────
  //
  // This is the pattern that separates a novelist from a blackmailer, and it is the
  // reason we do NOT try to classify explicitness. Sextortion has a STRUCTURE —
  // intimate material + a threat to expose it + a demand — and that structure is
  // detectable independently of how graphic the prose is. Trying to detect "smut"
  // instead would simultaneously over-block romance authors and under-block abuse.
  //
  // The harm here lands on a real, identifiable person who did not consent. That is
  // the Tier 1 boundary, and no stated purpose unlocks it.
  {
    // The disclosure half of the threat may be ACTIVE ("I'll post them") or PASSIVE
    // ("everyone will see them") — the coercive structure is identical either way, so
    // both voices must match. Missing the passive form is how a real sextortion
    // message slips through a filter that looks only for "leak"/"post".
    pattern:
      /\b(send|pay|give)\s+(me|us)\b[^.!?]{0,80}\b(or|otherwise|unless)\b[^.!?]{0,80}\b(post|publish|leak|release|send|share|expose|show|see|sees|view|receive|get)\b[^.!?]{0,40}\b(nudes?|photos?|pics?|images?|videos?|vids?|tape|footage)\b/i,
    reason: "Sextortion: demand coupled with a threat to expose intimate material",
  },
  {
    pattern:
      /\b(i|we)\s+(will|'ll|am going to|gonna)\s+(post|publish|leak|release|share|expose|send)\b[^.!?]{0,60}\b(nudes?|naked|intimate|explicit)\b[^.!?]{0,60}\b(unless|if you (don'?t|do not|refuse)|until you)\b/i,
    reason: "Sextortion: threat to expose intimate material unless a demand is met",
  },
  {
    pattern:
      /\b(unless|if)\s+you\s+(don'?t|do not|refuse to|fail to)\s+(pay|send|give|transfer)\b[^.!?]{0,80}\b(everyone|family|friends|boss|employer|wife|husband|school|colleagues)\b[^.!?]{0,40}\b(see|know|find out|receive)\b/i,
    reason: "Extortion: threat to disclose to a victim's contacts unless a demand is met",
  },
  {
    pattern:
      /\b(non-?consensual|revenge)\s+(porn(ography)?|nudes?|intimate\s+images?|sexual\s+images?)\b/i,
    reason: "Non-consensual intimate imagery",
  },
  {
    pattern:
      /\b(post(ing)?|publish(ing)?|leak(ing)?|shar(e|ing))\b[^.!?]{0,40}\b(her|his|their)\s+(nudes?|naked\s+photos?|intimate\s+(photos?|images?|videos?))\b[^.!?]{0,60}\b(without\s+(her|his|their)\s+(consent|permission|knowledge)|to\s+(humiliate|punish|shame|get back at))\b/i,
    reason: "Non-consensual intimate imagery",
  },
];

const MATURE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\b(graphic|explicit|detailed)\s+(depiction|description|account)\s+of\s+(murder|torture|rape|mutilation|dismemberment|beheading)\b/i,
    reason: "Graphic violence",
  },
  {
    pattern:
      /\b(sexually\s+explicit|pornographic|erotic\s+content|graphic\s+sexual)\b/i,
    reason: "Sexually explicit content",
  },
  {
    pattern:
      /\b(detailed|step[\s-]by[\s-]step)\s+(instructions?|guide|how[\s-]to)\s+(for|to)\s+(making|cook(ing)?|manufactur(e|ing))\s+(meth|methamphetamine|fentanyl|heroin)\b/i,
    reason: "Drug manufacturing instructions",
  },
];

// ── Adult content (Tier 2) ───────────────────────────────────────────────────
//
// Used ONLY to decide whether Reckons.AI will act as the courier (F66.1, Option C:
// "gate only what we carry"). Adult content is never blocked from being authored,
// stored, or EXPORTED — export is a right. It is simply not carried by our mediated
// distribution paths; the user exports and self-hosts.
//
// That asymmetry is what makes an imperfect detector acceptable. A false positive
// costs the user one export and a self-host — not their work, not a ban, no appeal.
// So this may be somewhat over-sensitive without doing real harm, whereas a filter
// that BLOCKED authoring would have to be near-perfect to be tolerable.
//
// NOTE the difference from MATURE_PATTERNS above, which is the pre-existing bug this
// fixes: those match *descriptions* of content (the literal phrase "sexually
// explicit"), so actual prose sails through. These match the content itself.
const ADULT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\b(sexually\s+explicit|pornographic|erotica|erotic\s+(content|fiction|story|scene)|graphic\s+sexual|explicit\s+sex\s+scene|nsfw)\b/i,
    reason: "Adult content (self-described)",
  },
  {
    pattern:
      /\b(hardcore|xxx)\b[^.!?]{0,30}\b(porn|sex|scene|content)\b|\b(porn|sex)\s+(scene|story|fiction|content)\b/i,
    reason: "Adult content",
  },
  {
    pattern:
      /\b(explicit|graphic|steamy|smutty|spicy)\s+(romance|scene|chapter|fiction|passage)\b/i,
    reason: "Adult content (explicit fiction)",
  },
];

// ── Classification Functions ─────────────────────────────────────────────────

/** Classify a single text string for content policy violations. */
export function classifyText(text: string): ContentScanResult {
  if (!text || text.length === 0) return { rating: "none", flags: [] };

  const flags: string[] = [];

  // Check blocked patterns first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return { rating: "blocked", flags: [reason] };
    }
  }

  // Check mature patterns
  for (const { pattern, reason } of MATURE_PATTERNS) {
    if (pattern.test(text)) {
      flags.push(reason);
    }
  }

  return {
    rating: flags.length > 0 ? "mature" : "none",
    flags,
  };
}

/** Get all scannable text from a statement (gloss, excerpt, literal object values). */
function statementTexts(st: Statement): string[] {
  const texts: string[] = [];
  if (st.gloss) texts.push(st.gloss);
  if (st.excerpt) texts.push(st.excerpt);
  if (st.o.kind === "literal" && st.o.value) texts.push(st.o.value);
  return texts;
}

/** Classify a single statement. Returns the worst rating across its text fields. */
export function classifyStatement(st: Statement): ContentScanResult {
  const texts = statementTexts(st);
  let worstRating: ContentRating = "none";
  const allFlags: string[] = [];

  for (const text of texts) {
    const result = classifyText(text);
    if (result.rating === "blocked") return result; // short-circuit
    if (result.rating === "mature") {
      worstRating = "mature";
      for (const f of result.flags) {
        if (!allFlags.includes(f)) allFlags.push(f);
      }
    }
  }

  return { rating: worstRating, flags: allFlags };
}

// ── Batch Operations ─────────────────────────────────────────────────────────

export interface ContentFilterResult {
  /** Statements that passed the filter (none or mature) */
  allowed: Statement[];
  /** Statements that were blocked */
  blocked: Statement[];
  /** Reasons for each blocked statement (keyed by statement id) */
  blockReasons: Record<string, string[]>;
}

/**
 * Filter a batch of statements, separating blocked content from allowed.
 * Called before saving to the database.
 */
export function filterBlockedStatements(
  statements: Statement[],
): ContentFilterResult {
  const allowed: Statement[] = [];
  const blocked: Statement[] = [];
  const blockReasons: Record<string, string[]> = {};

  for (const st of statements) {
    const result = classifyStatement(st);
    if (result.rating === "blocked") {
      blocked.push(st);
      blockReasons[st.id] = result.flags;
    } else {
      allowed.push(st);
    }
  }

  return { allowed, blocked, blockReasons };
}

// ── Export Advisory ──────────────────────────────────────────────────────────

export interface ExportAdvisory {
  /** Overall content rating for the export */
  rating: ContentRating;
  /** Distinct content flags found across all statements */
  flags: string[];
  /** Number of statements with mature content */
  matureCount: number;
}

/**
 * Scan all statements to produce an export content advisory.
 * This is used to add warning headers to exported TTL files.
 */
export function scanForExportAdvisory(statements: Statement[]): ExportAdvisory {
  const allFlags: string[] = [];
  let matureCount = 0;
  let hasBlocked = false;

  for (const st of statements) {
    const result = classifyStatement(st);
    if (result.rating === "blocked") hasBlocked = true;
    if (result.rating === "mature") matureCount++;
    for (const f of result.flags) {
      if (!allFlags.includes(f)) allFlags.push(f);
    }
  }

  return {
    rating: hasBlocked ? "blocked" : matureCount > 0 ? "mature" : "none",
    flags: allFlags,
    matureCount,
  };
}

/**
 * Generate advisory header lines for a TTL export.
 * Returns empty array if content is rated 'none'.
 */
export function exportAdvisoryHeader(advisory: ExportAdvisory): string[] {
  if (advisory.rating === "none") return [];

  const lines: string[] = [];
  lines.push("# ---- CONTENT ADVISORY ----");
  if (advisory.rating === "mature") {
    lines.push(
      `# This knowledge graph contains mature content (${advisory.matureCount} statement${advisory.matureCount !== 1 ? "s" : ""} flagged).`,
    );
    lines.push(`# Themes: ${advisory.flags.join(", ")}`);
    lines.push("# Viewer discretion is advised.");
  } else {
    lines.push(
      "# WARNING: This knowledge graph may contain content that violates content policy.",
    );
    lines.push(`# Flagged themes: ${advisory.flags.join(", ")}`);
  }
  lines.push("");
  return lines;
}

/**
 * Generate a content advisory RDF triple for embedding in exports.
 * Returns empty string if content is rated 'none'.
 */
export function exportAdvisoryTriple(advisory: ExportAdvisory): string {
  if (advisory.rating === "none") return "";
  const themes = advisory.flags.join("; ");
  return `<urn:reckons:kb> <urn:reckons:meta/contentAdvisory> "${advisory.rating}: ${themes}" .\n`;
}

// ── Distribution gate (F66 / F66.1) ──────────────────────────────────────────
//
// EXPORT IS A RIGHT; DISTRIBUTION IS A PRIVILEGE. Nothing below is ever applied to
// authoring, storage, or user-export — a user's own graph is theirs, whatever it
// contains, and withholding it would be lock-in (and futile: it is readable straight
// out of IndexedDB). This applies ONLY where Reckons.AI is the intermediary actually
// carrying content to someone else: publishSiteToGitHub and friends.
//
// Three outcomes, and note what is deliberately ABSENT: there is no purpose field, no
// attestation, no terms to accept. Context is never an input. A gate that accepts an
// explanation is a gate anyone can talk their way past — so we ask nothing, and there
// is nothing to lie about.

export type DistributionVerdict =
  /** Carry it. */
  | "allow"
  /** Lawful adult content. We decline to be the courier; the user may export + self-host. */
  | "decline"
  /** Refused everywhere we are in the loop. The harm lands on a non-consenting third party. */
  | "refuse";

export interface DistributionResult {
  verdict: DistributionVerdict;
  /** Human-readable reasons. Shown to the user verbatim — never a silent drop. */
  reasons: string[];
}

/** Classify a single text for the DISTRIBUTION decision (not for ingest). */
export function classifyForDistribution(text: string): DistributionResult {
  if (!text) return { verdict: "allow", reasons: [] };

  // Tier 1 — refused. No purpose, agreement, or context unlocks this.
  const blocked = classifyText(text);
  if (blocked.rating === "blocked") {
    return { verdict: "refuse", reasons: blocked.flags };
  }

  // Tier 2 — adult. Lawful; we simply do not carry it.
  const reasons: string[] = [];
  for (const { pattern, reason } of ADULT_PATTERNS) {
    if (pattern.test(text) && !reasons.includes(reason)) reasons.push(reason);
  }
  if (reasons.length > 0) return { verdict: "decline", reasons };

  return { verdict: "allow", reasons: [] };
}

/** Worst verdict across every text field of a statement. */
export function classifyStatementForDistribution(st: Statement): DistributionResult {
  let verdict: DistributionVerdict = "allow";
  const reasons: string[] = [];

  for (const text of statementTexts(st)) {
    const r = classifyForDistribution(text);
    if (r.verdict === "refuse") return r; // short-circuit: nothing outranks Tier 1
    if (r.verdict === "decline") {
      verdict = "decline";
      for (const reason of r.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return { verdict, reasons };
}
