import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
const { readFileSync } = fs;
import { spawnSync } from 'node:child_process';
import { sceneFromStatements, conditionsFromStatements, parseShape } from '../scene';
import { simulate, SimRefusal, MAX_STEPS } from '../world';
import { parseCondition, checkConditions } from '../conditions';
import { statementsFromTtl } from '../ttl';
import { handleSimRequest } from '../sim.worker';

const P = `@prefix kb: <urn:kbase:concept/> . @prefix m: <urn:kbase:meta/> .\n`;
const sceneOf = (body: string) => sceneFromStatements(statementsFromTtl(P + body));
const FLOOR = `kb:floor m:sim-shape "box 20 1 20" ; m:sim-static "true" ; m:placed-at "0 -0.5 0" .\n`;
const EXAMPLE = 'static/starter-sim-ramp-cup.ttl';
const withBall = (at: string) => readFileSync(EXAMPLE, 'utf8').replace(/(^kb:ball\n[\s\S]*?placed-at ")[^"]*"/m, `$1${at}"`);

describe('scene reader', () => {
  it('reads bodies with documented defaults and the shared placement predicates', () => {
    const s = sceneOf(FLOOR + `kb:b m:sim-shape "sphere 0.5" ; m:placed-at "1 2 3" ; m:placed-yaw "90" .`);
    expect(s.refusals).toEqual([]);
    const b = s.bodies.find((x) => x.id === 'b')!;
    expect(b).toMatchObject({ friction: 0.5, restitution: 0, mass: 1, isStatic: false, position: [1, 2, 3], yaw: 90 });
  });
  it.each([
    ['unknown shape', `m:sim-shape "cone 1" ; m:placed-at "0 0 0"`, /unknown shape/],
    ['negative size', `m:sim-shape "sphere -1" ; m:placed-at "0 0 0"`, /sphere needs/],
    ['missing pose', `m:sim-shape "sphere 1"`, /no pose/],
    ['bad pose', `m:sim-shape "sphere 1" ; m:placed-at "1 2"`, /three numbers/],
    ['bad flag', `m:sim-shape "sphere 1" ; m:placed-at "0 0 0" ; m:sim-static "yes"`, /"true" or "false"/],
    ['bad mass', `m:sim-shape "sphere 1" ; m:placed-at "0 0 0" ; m:sim-mass "0"`, /mass/],
    ['bad velocity', `m:sim-shape "sphere 1" ; m:placed-at "0 0 0" ; m:sim-velocity "1 x 2"`, /sim-velocity/],
  ])('refuses %s with a reason, never a silent default', (_n, props, re) => {
    const s = sceneOf(`kb:x ${props} .`);
    expect(s.bodies).toEqual([]);
    expect(s.refusals[0].reason).toMatch(re);
  });
  it('refuses a duplicate local name and parses shapes', () => {
    const s = sceneFromStatements(statementsFromTtl(`@prefix m: <urn:kbase:meta/> . <urn:a:x> m:sim-shape "sphere 1" ; m:placed-at "0 0 0" . <urn:b:x> m:sim-shape "sphere 1" ; m:placed-at "0 0 0" .`));
    expect(s.bodies).toHaveLength(1);
    expect(s.refusals[0].reason).toMatch(/also used/);
    expect(parseShape('capsule 0.2 0.5')).toEqual({ kind: 'capsule', r: 0.2, halfHeight: 0.5 });
  });
  it('refuses ids that name object internals, so none can reach a prototype', () => {
    const s = sceneFromStatements(statementsFromTtl(`@prefix m: <urn:kbase:meta/> . <urn:a:__proto__> m:sim-shape "sphere 1" ; m:placed-at "0 0 0" . <urn:a:constructor> m:sim-shape "sphere 1" ; m:placed-at "0 0 0" .`));
    expect(s.bodies).toEqual([]);
    expect(s.refusals.map((r) => r.reason)).toEqual([expect.stringMatching(/object internal/), expect.stringMatching(/object internal/)]);
  });
  it('lists conditions from the target node', () => {
    const c = conditionsFromStatements(statementsFromTtl(P + `kb:t m:sim-condition "atRest(all)" .`));
    expect(c).toEqual([{ subject: 'urn:kbase:concept/t', text: 'atRest(all)' }]);
  });
});

describe('runner', () => {
  it('refuses steps and bodies beyond the bounds', async () => {
    const s = sceneOf(FLOOR);
    await expect(simulate(s, { steps: MAX_STEPS + 1 })).rejects.toBeInstanceOf(SimRefusal);
    await expect(simulate({ bodies: [], refusals: [] }, { steps: 10 })).rejects.toBeInstanceOf(SimRefusal);
  });
  it('is deterministic: two runs give bit-identical final poses and trajectories', async () => {
    const scene = sceneFromStatements(statementsFromTtl(readFileSync(EXAMPLE, 'utf8')));
    const a = await simulate(scene, { steps: 600 });
    const b = await simulate(scene, { steps: 600 });
    expect(JSON.stringify(a.final)).toBe(JSON.stringify(b.final));
    expect(JSON.stringify(a.trajectory)).toBe(JSON.stringify(b.trajectory));
  });
  it('worker handler returns a result or an error object', async () => {
    const ok = await handleSimRequest({ scene: sceneOf(FLOOR + `kb:b m:sim-shape "sphere 0.5" ; m:placed-at "0 3 0" .`), options: { steps: 30 } });
    expect(ok.ok).toBe(true);
    const bad = await handleSimRequest({ scene: { bodies: [], refusals: [] }, options: { steps: 30 } });
    expect(bad).toMatchObject({ ok: false });
  });
});

describe('conditions, each true and false on tiny scenes', () => {
  const ball = (at: string, extra = '') => `kb:ball m:sim-shape "sphere 0.5" ; m:placed-at "${at}" ${extra} .\n`;
  const run = async (ttl: string, steps = 240) => { const scene = sceneOf(ttl); return { scene, r: await simulate(scene, { steps }) }; };
  const verdict = (c: string, x: Awaited<ReturnType<typeof run>>) => checkConditions([c], x.scene, x.r)[0];

  it('restsOn and atRest: a ball dropped on the floor settles; one in the air does not', async () => {
    const x = await run(FLOOR + ball('0 1 0'));
    expect(verdict('restsOn(ball, floor)', x).ok).toBe(true);
    expect(verdict('atRest(all)', x).ok).toBe(true);
    const y = await run(FLOOR + ball('0 50 0'), 20);
    expect(verdict('restsOn(ball, floor)', y).ok).toBe(false);
    expect(verdict('atRest(ball)', y).ok).toBe(false);
  });
  it('inside, with a body region and an aabb', async () => {
    const x = await run(FLOOR + ball('0 1 0') + `kb:zone m:sim-shape "box 2 2 2" ; m:sim-sensor "true" ; m:placed-at "0 1 0" .`);
    expect(verdict('inside(ball, zone)', x).ok).toBe(true);
    expect(verdict('inside(ball, aabb(5,0,5,6,1,6))', x).ok).toBe(false);
    expect(verdict('inside(ball, aabb(-1,0,-1,1,1,1))', x).ok).toBe(true);
  });
  it('aboveFloor: true on a floor, false when a ball falls through nothing', async () => {
    expect((verdict('aboveFloor(all, -0.1)', await run(FLOOR + ball('0 1 0')))).ok).toBe(true);
    expect((verdict('aboveFloor(ball, -0.1)', await run(ball('0 1 0'), 120))).ok).toBe(false);
  });
  it('reachesHeight uses the whole run, not the end', async () => {
    const x = await run(FLOOR + ball('0 1 0', '; m:sim-velocity "0 8 0"'), 300);
    expect(verdict('reachesHeight(ball, 3)', x).ok).toBe(true);
    expect(verdict('reachesHeight(ball, 30)', x).ok).toBe(false);
  });
  it('within', async () => {
    const x = await run(FLOOR + ball('0 1 0') + `kb:other m:sim-shape "sphere 0.5" ; m:placed-at "3 1 0" .`);
    expect(verdict('within(ball, other, 4)', x).ok).toBe(true);
    expect(verdict('within(ball, other, 1)', x).ok).toBe(false);
  });
  it('a bad or unknown condition is reported and never executed', async () => {
    const x = await run(FLOOR + ball('0 1 0'), 10);
    for (const c of ['inside(ghost, floor)', 'teleport(ball)', 'atRest(', 'aboveFloor(ball, high)', 'within(ball, floor)', 'process.exit(1)']) {
      const v = verdict(c, x);
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/^REFUSED/);
    }
    expect(parseCondition('restsOn(ball, floor)', x.scene)).toMatchObject({ op: 'restsOn' });
  });
});

describe('example space and CLI', () => {
  const cli = (file: string) => spawnSync('npx', ['tsx', 'scripts/sim/run.ts', `--file=${file}`], { encoding: 'utf8' });
  it('as given the example FAILS, and moving the ball up the ramp makes it PASS', async () => {
    const conds = (t: string) => conditionsFromStatements(statementsFromTtl(t)).map((c) => c.text);
    for (const [at, expected] of [['0.6 1.25 0', false], ['-1.5 1.9 0', true]] as const) {
      const ttl = withBall(at);
      const scene = sceneFromStatements(statementsFromTtl(ttl));
      const r = await simulate(scene, { steps: 600 });
      const res = checkConditions(conds(ttl), scene, r);
      expect(res.find((x) => x.text.startsWith('inside'))!.ok).toBe(expected);
      expect(res.find((x) => x.text.startsWith('aboveFloor'))!.ok).toBe(true);
    }
  });
  it('exit codes: 1 on FAIL, 0 on PASS, 2 on a missing file', () => {
    expect(cli(EXAMPLE).status).toBe(1);
    const dir = process.env.TMPDIR ?? '/tmp';
    const passFile = `${dir}/sim-pass-${process.pid}.ttl`;
    fs.writeFileSync(passFile, withBall('-1.5 1.9 0'));
    expect(cli(passFile).status).toBe(0);
    fs.unlinkSync(passFile);
    expect(cli('static/does-not-exist.ttl').status).toBe(2);
  }, 60000);
});
