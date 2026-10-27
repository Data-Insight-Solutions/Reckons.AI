// Builds the Triple Check walkthrough space, and the owners' forum space it is checked against, from scripts/starter/triple-check-walkthrough.ts.
// `--check` fails when static/starter-triple-check.ttl is out of date instead of rewriting it.
import { readFileSync, writeFileSync } from 'node:fs';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { walkthroughStatements, walkthroughSources, forumStatements, forumSources } from './triple-check-walkthrough.js';
const check = process.argv.includes('--check');
// The export's first line is a generation timestamp, so the comparison skips it.
const body = (text: string) => text.slice(text.indexOf('\n') + 1);
function output(file: string, text: string) { if (check) { if (body(readFileSync(file, 'utf8')) !== body(text)) throw new Error(`${file} needs regeneration`); } else writeFileSync(file, text); }
const statements = walkthroughStatements();
output('static/starter-triple-check.ttl', toTurtleFull(statements, walkthroughSources()));
console.log(`starter-triple-check.ttl: ${statements.length} statements (${statements.filter((s) => s.status === 'pending').length} pending).`);
output('static/starter-triple-check-reference.ttl', toTurtleFull(forumStatements(), forumSources()));
console.log(`starter-triple-check-reference.ttl: ${forumStatements().length} statements.`);
