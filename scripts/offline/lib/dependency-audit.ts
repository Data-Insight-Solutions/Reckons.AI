/** npm's severity and lockfile placement are evidence, not proof of runtime exploitability. */
export interface DependencyFinding {
  name: string;
  severity: string;
  direct: boolean;
  placement: 'runtime' | 'development' | 'unknown';
  installed: { path: string; version: string }[];
  affectedRange: string;
  advisories: { title: string; url: string; severity: string; range: string }[];
  inheritedFrom: string[];
  fix: unknown;
  topLevelOverride: unknown;
  reachability: 'not-assessed';
}
export function parseDependencyAudit(text: string, lock: any, manifest: any = {}): DependencyFinding[] {
  const report = JSON.parse(text);
  if (report.error || report.auditReportVersion !== 2 || !report.vulnerabilities ||
      typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities) ||
      !report.metadata?.vulnerabilities || !lock || typeof lock.packages !== 'object' ||
      !lock.packages || Array.isArray(lock.packages)) throw new Error('Incomplete npm audit');
  return Object.entries(report.vulnerabilities).map(([name, value]) => {
    const v = value as any;
    if (!['info', 'low', 'moderate', 'high', 'critical'].includes(v.severity) ||
        !Array.isArray(v.nodes) || v.nodes.some((p: unknown) => typeof p !== 'string') ||
        !Array.isArray(v.via)) throw new Error('Invalid vulnerability record');
    const entries = v.nodes.map((p: string) => ({ path: p, entry: lock.packages[p] }));
    if (entries.some((e: any) => e.entry !== undefined && (!e.entry || typeof e.entry !== 'object' ||
        typeof e.entry.version !== 'string' || (e.entry.dev !== undefined && typeof e.entry.dev !== 'boolean')))) {
      throw new Error('Invalid lockfile package entry');
    }
    return {
      name, severity: v.severity, direct: v.isDirect === true,
      placement: entries.some((e: any) => e.entry && !e.entry.dev) ? 'runtime' :
        entries.length && entries.every((e: any) => e.entry?.dev === true) ? 'development' : 'unknown',
      installed: entries.map((e: any) => ({ path: e.path, version: e.entry?.version ?? 'unknown' })),
      affectedRange: v.range ?? 'unknown',
      advisories: v.via.filter((a: any) => typeof a === 'object' && a !== null).map((a: any) => ({ title: String(a.title ?? ''), url: String(a.url ?? ''), severity: String(a.severity ?? ''), range: String(a.range ?? '') })),
      inheritedFrom: v.via.filter((a: any) => typeof a === 'string'),
      fix: v.fixAvailable ?? false, topLevelOverride: manifest?.overrides?.[name] ?? null,
      reachability: 'not-assessed',
    };
  });
}
