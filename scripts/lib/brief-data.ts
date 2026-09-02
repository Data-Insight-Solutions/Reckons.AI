export interface BriefPullRequest {
  number: number;
  baseRefName: string;
  title: string;
}

/** Format the first open PR. An empty or invalid response means there is no reportable PR. */
export function formatFirstPullRequest(json: string): string {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value) || value.length === 0) return '';
    const first = value[0] as Partial<BriefPullRequest> | null;
    if (
      !first ||
      typeof first.number !== 'number' ||
      typeof first.baseRefName !== 'string' ||
      typeof first.title !== 'string'
    ) return '';
    return `#${first.number} → ${first.baseRefName}: ${first.title}`;
  } catch {
    return '';
  }
}
