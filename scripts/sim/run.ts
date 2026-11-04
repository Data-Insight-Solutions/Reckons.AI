// F260.1 — headless simulator. Script tier: deterministic, zero tokens, exit 1 on any FAIL.
// Usage: npm run sim:run -- --file=static/starter-sim-ramp-cup.ttl [--steps=600]
import { readFileSync } from 'node:fs';
import { statementsFromTtl } from '../../src/lib/sim/ttl';
import { sceneFromStatements, conditionsFromStatements } from '../../src/lib/sim/scene';
import { simulate } from '../../src/lib/sim/world';
import { checkConditions } from '../../src/lib/sim/conditions';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const file = arg('file');
if (!file) { console.error('usage: sim:run -- --file=<graph.ttl> [--steps=600]'); process.exit(2); }
const steps = Number(arg('steps') ?? 600);

let statements;
try { statements = statementsFromTtl(readFileSync(file, 'utf8')); }
catch (e) { console.error(`cannot read ${file}: ${(e as Error).message}`); process.exit(2); }

const scene = sceneFromStatements(statements);
for (const r of scene.refusals) console.log(`REFUSED body ${r.id}: ${r.reason}`);
const conds = conditionsFromStatements(statements);
if (scene.refusals.length) { console.log('scene has refused bodies; not simulating'); process.exit(1); }
if (!conds.length) { console.error('no urn:kbase:meta/sim-condition literals in the graph'); process.exit(2); }

const run = await simulate(scene, { steps });
const results = checkConditions(conds.map((c) => c.text), scene, run);
console.log(`${scene.bodies.length} bodies, ${steps} steps at dt=${run.dt.toFixed(5)}`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.text}\n      ${r.detail}`);
console.log('final poses:');
for (const b of scene.bodies.filter((x) => !x.isStatic)) {
  const p = run.final[b.id];
  console.log(`  ${b.id}: (${p.position.map((x) => x.toFixed(3)).join(', ')}) speed ${Math.hypot(...p.velocity).toFixed(3)}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} conditions FAIL` : `all ${results.length} conditions PASS`);
process.exit(failed ? 1 : 0);
