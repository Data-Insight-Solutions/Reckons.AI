/**
 * Whether the licence GitHub reports is the one the graph records.
 *
 * The graph writes an unlicensed repo as "none" and GitHub's API (via competitor-scan) reports it
 * as "NONE", so a strict string comparison raised a license-changed ERROR on every local sweep for
 * a repo whose licence had not changed at all (observed 2026-10-13: "license is now NONE, but the
 * graph says none"). Licence ids are case-insensitive labels, so compare them that way.
 * "UNKNOWN" (no record in the graph) is never equal to a live value: that one should still surface.
 */
export function sameLicense(live: string, recorded: string): boolean {
  return live.trim().toLowerCase() === recorded.trim().toLowerCase();
}
