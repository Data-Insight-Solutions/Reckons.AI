// Builds the Triple Check walkthrough space from scripts/starter/triple-check-walkthrough.ts.
// `--check` fails when static/starter-triple-check.ttl is out of date instead of rewriting it.
import { readFileSync, writeFileSync } from 'node:fs';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { walkthroughStatements, walkthroughSources } from './triple-check-walkthrough.js';
const check = process.argv.includes('--check');
function output(file: string, text: string) { if (check) { if (readFileSync(file, 'utf8') !== text) throw new Error(`${file} needs regeneration`); } else writeFileSync(file, text); }
const statements = walkthroughStatements();
output('static/starter-triple-check.ttl', toTurtleFull(statements, walkthroughSources()));
console.log(`starter-triple-check.ttl: ${statements.length} statements (${statements.filter((s) => s.status === 'pending').length} pending).`);
