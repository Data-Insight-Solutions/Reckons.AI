import type { Statement } from './types';
export type RepositoryProfile = { id: string; name: string; claims: Statement[]; languages: Set<string>; topics: Set<string> };
export function repositoryProfiles(statements: Statement[]): RepositoryProfile[] {
  const repos = new Map<string, Statement[]>();
  for (const s of statements) if (['confirmed', 'refined'].includes(s.status) && /^https:\/\/github\.com\/[^/]+\/[^/#]+$/.test(s.s.value)) {
    const rows = repos.get(s.s.value) ?? []; rows.push(s); repos.set(s.s.value, rows);
  }
  return [...repos].map(([id, claims]) => ({ id, name: id.replace('https://github.com/', ''), claims,
    languages: new Set(claims.filter(s => s.p.value.endsWith('programmingLanguage')).map(s => s.o.value)),
    topics: new Set(claims.filter(s => s.p.value.endsWith('keywords')).map(s => s.o.value)),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
export function repositoryOverlap(a: RepositoryProfile, b: RepositoryProfile) {
  const left = new Set([...a.languages, ...a.topics]), right = new Set([...b.languages, ...b.topics]);
  const shared = [...left].filter(v => right.has(v)), union = new Set([...left, ...right]).size;
  return { shared, score: union ? shared.length / union : null };
}
export const repositoryMetric = (repo: RepositoryProfile, predicate: string) => repo.claims.filter(s => s.p.value.endsWith('/' + predicate));
