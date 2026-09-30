import type { Statement, Source } from './types';

type Validator = (value: unknown) => boolean;
const text: Validator = v => typeof v === 'string';
const bool: Validator = v => typeof v === 'boolean';
const number: Validator = v => typeof v === 'number' && Number.isFinite(v);
const strings: Validator = v => Array.isArray(v) && v.every(text);
const oneOf = (...values: string[]): Validator => v => typeof v === 'string' && values.includes(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Additive v1 metadata supplements the existing RDF reification. Only these
// fields can be imported; JSON can never replace identity, terms or review status.
// Extraction run records/IDs are local diagnostics and deliberately stay local.
const STATEMENT_FIELDS = {
  sourceId: text, updatedAt: number, grounded: bool, needsObject: bool, question: text,
  blocks: strings, verifiedBy: text, findingClass: oneOf('form', 'drift', 'defect'),
  verifiableBy: oneOf('code', 'test', 'source', 'user', 'unknown', 'external-graph'),
  answeredByGraph: text, hopChain: strings, settledByDecision: text,
  settledBy: (v: unknown) => object(v) && text(v.actor) && text(v.channel) && number(v.at)
    && Object.keys(v).every(k => ['actor', 'channel', 'at'].includes(k)),
} satisfies Partial<Record<keyof Statement, Validator>>;

const action = (v: unknown, keys: string[]) => object(v) && keys.every(k => text(v[k]))
  && number(v.confidence) && Object.keys(v).every(k => [...keys, 'confidence'].includes(k));
const SOURCE_FIELDS = {
  hash: text, extractionBackend: text, extractionModel: text, analysisModel: text, analysisProvider: text,
  analysisTrigger: oneOf('manual', 'import', 'schedule'),
  analysisFocus: oneOf('enrich', 'merge', 'entity-types', 'delete', 'new-triples', 'align'),
  analysisTotalSuggestions: number, repoOwner: text, repoName: text, repoBranch: text,
  repoHeadSha: text, repoFileCount: number,
  analysisActions: (v: unknown) => object(v) && Array.isArray(v.merges) && Array.isArray(v.prunes)
    && Object.keys(v).every(k => ['merges', 'prunes'].includes(k))
    && v.merges.every(a => action(a, ['entityAIri', 'entityALabel', 'entityBIri', 'entityBLabel', 'reason']))
    && v.prunes.every(a => action(a, ['entityIri', 'entityLabel', 'reason'])),
} satisfies Partial<Record<keyof Source, Validator>>;

function select(value: unknown, fields: Record<string, Validator>): Record<string, unknown> {
  if (!object(value)) throw new Error('Invalid portable metadata');
  const out: Record<string, unknown> = {};
  for (const [key, valid] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
    if (!valid(value[key])) throw new Error(`Invalid portable metadata field: ${key}`);
    out[key] = value[key];
  }
  return out;
}

export function encodePortableMetadata(value: Statement | Source, kind: 'statement' | 'source'): string {
  return JSON.stringify({ version: 1, fields: select(value, kind === 'statement' ? STATEMENT_FIELDS : SOURCE_FIELDS) });
}

export function decodePortableMetadata(value: string, kind: 'statement'): Partial<Statement>;
export function decodePortableMetadata(value: string, kind: 'source'): Partial<Source>;
export function decodePortableMetadata(value: string, kind: 'statement' | 'source'): Record<string, unknown> {
  const record = JSON.parse(value);
  if (!object(record) || record.version !== 1) throw new Error('Unsupported portable metadata version');
  return select(record.fields, kind === 'statement' ? STATEMENT_FIELDS : SOURCE_FIELDS);
}
