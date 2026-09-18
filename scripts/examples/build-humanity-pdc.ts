/** Compile named-source authoring data into the app's lossless, reviewable Turtle format. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Parser, type Quad } from 'n3';
import { v5 as uuidv5 } from 'uuid';
import { toTurtleFull } from '../../src/lib/rdf/serialize';
import type { Source, Statement, Term } from '../../src/lib/rdf/types';

const input = 'static/examples/humanity-pdc.trig';
const checkedAt = '2026-09-15T12:00:00.000Z';
const sourcePrefix = 'urn:kbase:source/';
const namespace = uuidv5('https://reckons.ai/examples/humanity-pdc', uuidv5.URL);
const quads = new Parser({ format: 'TriG' }).parse(readFileSync(input, 'utf8'));
const content = quads.filter((q) => q.graph.termType === 'NamedNode');
const metadata = quads.filter((q) => q.graph.termType === 'DefaultGraph');
const sourceIris = [...new Set(content.map((q) => q.graph.value))];
const sources: Source[] = sourceIris.map((iri) => {
  const value = (predicate: string) => metadata.find((q) => q.subject.value === iri && q.predicate.value === predicate)?.object.value;
  const title = value('http://purl.org/dc/terms/title');
  const uri = value('urn:kbase:meta/sourceUri');
  if (!title || !uri || !iri.startsWith(sourcePrefix)) throw new Error(`Missing source metadata: ${iri}`);
  return { id: iri.slice(sourcePrefix.length), title, uri, kind: uri.startsWith('https:') ? 'url' : 'note',
    trustLevel: 'review', ingestedAt: Date.parse(checkedAt) };
});
function term(node: Quad['object'] | Quad['subject']): Term {
  if (node.termType === 'NamedNode') return { kind: 'iri', value: node.value };
  if (node.termType === 'Literal') return { kind: 'literal', value: node.value,
    ...(node.language ? { lang: node.language } : node.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' ? { datatype: node.datatype.value } : {}) };
  throw new Error('Example entities must have portable named identities');
}
const statements: Statement[] = content.map((q) => ({
  id: uuidv5(JSON.stringify([q.graph.value, term(q.subject), q.predicate.value, term(q.object)]), namespace),
  s: term(q.subject), p: { kind: 'iri', value: q.predicate.value }, o: term(q.object),
  g: { kind: 'iri', value: q.graph.value }, sourceId: q.graph.value.slice(sourcePrefix.length),
  status: 'pending', confidence: 1, createdAt: Date.parse(checkedAt), updatedAt: Date.parse(checkedAt),
  proposedBy: 'sourced-example',
}));
// Portable inputs demonstrate the same sources/identities in isolation and in the combined graph.
const seekerProposals = new Set(['accessible-local-ai', 'local-learning', 'local-research',
  'pdc-explorer-proposal', 'community-panel', 'pilot-evaluation']);
const examples = [
  { file: 'example-humanity-pdc.ttl', title: 'Humanity AI × PDC × Reckons.AI — sourced example',
    stableId: '66f8f00c-f2f9-51e3-aac3-60852f7c49d1', statements },
  { file: 'example-humanity-opportunity.ttl', title: 'Input A — Humanity AI grant opportunity',
    stableId: uuidv5('opportunity', namespace),
    statements: statements.filter((s) => ['humanity-overview', 'humanity-call'].includes(s.sourceId)) },
  { file: 'example-reckons-seeker.ttl', title: 'Input B — Reckons.AI grant-seeker profile and proposals',
    stableId: uuidv5('seeker', namespace),
    statements: statements.filter((s) => ['user-background', 'reckons-code'].includes(s.sourceId) ||
      (s.sourceId === 'explorer-proposal' && seekerProposals.has(s.s.value.replace('urn:kbase:concept/', '')))) },
];
for (const example of examples) {
  const selectedSources = sources.filter((source) => example.statements.some((s) => s.sourceId === source.id));
  // Pin the generated header as well as ids/dates for reproducible, reviewable diffs.
  const ttl = toTurtleFull(example.statements, selectedSources, {
    header: `${example.title}\nGenerated from static/examples/humanity-pdc.trig. All statements await review.\nPDC exploration and grant assessment are proposals; no live connection or partnership is asserted.`,
    kbStableId: example.stableId,
  }).replace(/^# generated .*$/m, `# generated ${checkedAt}`);
  const output = `static/${example.file}`;
  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== ttl) throw new Error(`Regenerate ${output} with this script`);
  } else writeFileSync(output, ttl);
  console.log(`${output}: ${example.statements.length} statements, ${new Set(example.statements.map((s) => s.s.value)).size} entities, ${selectedSources.length} sources`);
}
