/**
 * Which unbuilt features claim-audit looks for in reader-facing prose, and by what phrase.
 *
 * The phrase is a label's leading clause, everything before an em-dash, paren, colon or middle dot,
 * so "Triple Check — mark checked entities on the canvas" is looked for as "triple check". That is
 * also the leading clause of the BUILT "Triple Check — continuous statement evidence", and on
 * 2026-10-27 every mention of the working feature failed CI as an overclaim of its planned
 * sub-parts. A phrase that also names something built names that thing, so it is not a needle.
 */
export type ClaimNeedle = { iri: string; label: string; status: string; needle: string };

export const leadingClause = (label: string) => label.split(/[—(:·]/)[0].trim().toLowerCase();

export function unbuiltNeedles(labelOf: Map<string, string>, statusOf: Map<string, string>, unbuilt: Set<string>): ClaimNeedle[] {
  const builtClauses = new Set<string>();
  for (const [iri, status] of statusOf) {
    const label = labelOf.get(iri);
    if (label && !unbuilt.has(status)) builtClauses.add(leadingClause(label));
  }
  const out: ClaimNeedle[] = [];
  for (const [iri, status] of statusOf) {
    if (!unbuilt.has(status)) continue;
    const label = labelOf.get(iri);
    if (!label) continue;
    const needle = leadingClause(label);
    // Short needles produce false positives ("Graph", "Export"), so require some specificity.
    if (needle.length < 12 || builtClauses.has(needle)) continue;
    out.push({ iri, label, status, needle });
  }
  return out;
}
