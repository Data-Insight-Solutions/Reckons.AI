import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { Parser } from 'n3';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { researchFixture, researchSources } from './research-fixture.js';
const documents = researchFixture(), check = process.argv.includes('--check');
function output(file: string, text: string) { if (check) { if (readFileSync(file, 'utf8') !== text) throw new Error(`${file} needs regeneration`); } else writeFileSync(file, text); }
output('static/starter-research.ttl', toTurtleFull(documents.flatMap(d => d.claims), researchSources(documents)));
const examples = readdirSync('static').filter(f => /^starter-.*\.ttl$|^review-\d.*\.ttl$/.test(f)).sort().map(file => ({ file: `/${file}`, triples: new Parser().parse(readFileSync(`static/${file}`, 'utf8')).length, validationSettings: '/settings/triple-check', paidChecksEnabled: false }));
output('static/triple-check-examples.json', JSON.stringify(examples, null, 2) + '\n');
console.log(`${examples.length} bundled examples parse; validation workflow available; paid checks disabled.`);
