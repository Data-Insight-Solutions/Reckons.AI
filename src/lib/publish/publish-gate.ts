/**
 * Publish safety gate (F66 / kb:publish-safety-gate).
 *
 * EXPORT IS A RIGHT; DISTRIBUTION IS A PRIVILEGE. This gate runs ONLY where
 * Reckons.AI is the intermediary actually carrying content to someone else —
 * `publishSiteToGitHub`, which PUTs files on the user's behalf. It must NEVER run on
 * `exportSiteZip` or any other user-export path: a user's own graph is theirs,
 * whatever it contains, and withholding it would be lock-in (and futile besides — it
 * is readable straight out of IndexedDB).
 *
 * Two things this fixes, both real:
 *
 *  1. The old code ran `filterBlockedStatements` over the published knowledge.ttl but
 *     built the markdown PAGES from unfiltered statements — so blocked content shipped
 *     in the page bodies anyway. This gate scans the rendered file contents, which is
 *     the only thing that actually leaves.
 *
 *  2. It SILENTLY DROPPED blocked statements. A silent drop is the worst outcome: the
 *     user believes they published their graph, and part of it vanished. The gate
 *     REFUSES and explains, and never publishes a partial graph while implying it was
 *     whole.
 *
 * Three outcomes, and note what is deliberately absent — there is no purpose field, no
 * attestation, no terms to accept. Context is never an input. A gate that accepts an
 * explanation is a gate anyone can talk their way past.
 */
import type { Statement } from '../rdf/types';
import {
  classifyForDistribution,
  classifyStatementForDistribution,
  type DistributionVerdict,
} from '../safety/content-policy';

export interface GateFinding {
  /** Where it was found: a file path in the site bundle, or a statement id. */
  where: string;
  reasons: string[];
}

export interface GateResult {
  verdict: DistributionVerdict;
  /** Tier 1 — refused everywhere we are in the loop. */
  refusals: GateFinding[];
  /** Tier 2 — lawful adult content we decline to carry. */
  declines: GateFinding[];
  /** Message intended to be shown to the user verbatim. Never a silent drop. */
  message: string;
}

/** Files whose content is never user prose — skip to avoid nonsense matches. */
const SKIP_FILES = /^(admin\/|graph\.json$)/;

/**
 * Gate a site bundle before Reckons.AI carries it anywhere.
 *
 * @param stmts  the statements behind the site (checked for structured content)
 * @param files  the rendered bundle — this is what actually leaves, so it is what we scan
 */
export function gatePublish(stmts: Statement[], files: Record<string, string>): GateResult {
  const refusals: GateFinding[] = [];
  const declines: GateFinding[] = [];

  // Scan what actually leaves: the rendered files.
  for (const [path, content] of Object.entries(files)) {
    if (SKIP_FILES.test(path)) continue;
    const r = classifyForDistribution(content);
    if (r.verdict === 'refuse') refusals.push({ where: path, reasons: r.reasons });
    else if (r.verdict === 'decline') declines.push({ where: path, reasons: r.reasons });
  }

  // Also scan the statements themselves — a fact can carry content that no page renders.
  for (const st of stmts) {
    const r = classifyStatementForDistribution(st);
    const where = `statement ${st.id}`;
    if (r.verdict === 'refuse') refusals.push({ where, reasons: r.reasons });
    else if (r.verdict === 'decline') declines.push({ where, reasons: r.reasons });
  }

  if (refusals.length > 0) {
    return {
      verdict: 'refuse',
      refusals,
      declines,
      message:
        'Reckons.AI will not publish this graph.\n\n' +
        'It contains content we refuse to distribute anywhere we are in the loop — the kind ' +
        'where the harm lands on a real person who did not consent:\n\n' +
        dedupeReasons(refusals).map((r) => `  • ${r}`).join('\n') +
        '\n\nThis is not about explicitness, and no explanation changes it.\n' +
        'Your graph is untouched, and your export still works — this only stops us carrying it.',
    };
  }

  if (declines.length > 0) {
    return {
      verdict: 'decline',
      refusals,
      declines,
      message:
        "Reckons.AI won't publish this one for you.\n\n" +
        'It looks like adult content:\n\n' +
        dedupeReasons(declines).map((r) => `  • ${r}`).join('\n') +
        '\n\nThat is your business, and your work is your own — we are simply not the courier ' +
        'for it. Nothing is blocked and nothing is deleted: export your site and host it ' +
        'yourself (GitHub Pages, Netlify, and Cloudflare Pages are all free), under your own ' +
        'name and your own host\'s terms.\n\n' +
        'We are not asking you to justify it. There is no form to fill in.',
    };
  }

  return { verdict: 'allow', refusals, declines, message: '' };
}

function dedupeReasons(findings: GateFinding[]): string[] {
  const seen = new Set<string>();
  for (const f of findings) for (const r of f.reasons) seen.add(r);
  return [...seen];
}

/** Thrown by publish paths when the gate refuses or declines. Carries the full result. */
export class PublishRefusedError extends Error {
  readonly result: GateResult;
  constructor(result: GateResult) {
    super(result.message);
    this.name = 'PublishRefusedError';
    this.result = result;
  }
}
