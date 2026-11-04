import { describe, it, expect } from 'vitest';
import { ORCHESTRATION_TASKS } from '../orchestration-tasks';
import { scoreOutput, parseOutput } from '../orchestration-scoring';

// Hand-written answers. REFERENCE is what a correct deputy would say and must score full marks;
// STUFFED repeats every keyword the old keyword-presence scorer looked for and must score ~0.
// If a stuffed answer ever scores well again, the bench has stopped discriminating.

const PREFIXES = `@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix ktype: <urn:kbase:type/> .
@prefix sched: <urn:reckons:schedule/> .`;

const REFERENCE: Record<string, string> = {
  't1-decompose-jobs': `<think>entry 4 is a plain status write</think>
{"job": {"name": "f80-mesh-description", "tier": "agent", "model": "qwen3.6", "taskFile": "Draft the F80 phase 8 description for review", "urgency": "deferred"}}
{"job": {"name": "f79-dependency-check", "tier": "script", "model": "none", "taskFile": "Check urn:kbase:feature/f79-voice-agents exists before proposing depends-on", "urgency": "holds"}}
{"job": {"name": "describe-entities-drift", "tier": "agent", "model": "qwen3-coder", "taskFile": "Run describe-entities on every activation and handle entity types it has never seen instead of dropping unknown classes", "urgency": "immediate"}}
{"job": {"name": "f36-mobile-status", "tier": "script", "model": "none", "taskFile": "Write has-status in-progress", "urgency": "deferred"}}

\`\`\`turtle
${PREFIXES}

sched:describe-entities rdf:type ktype:Schedule ;
    rdfs:label "Describe entities" ;
    kpred:first-pass "true" .
\`\`\``,

  't2-write-schedule-ttl': `\`\`\`turtle
${PREFIXES}

sched:offline-script-daily rdf:type ktype:Schedule ;
    rdfs:label "Script-tier offline checks" ;
    kpred:every "1d" ;
    kpred:command "npm run offline:all -- --tier=script" ;
    kpred:tier "script" ;
    kpred:harness "session-worker" ;
    kpred:enabled "true" ;
    kpred:description "Runs the deterministic script-tier checks daily so drift is caught at zero token cost." .
\`\`\``,

  't3-route-batch': `FINDING 1 → tier=agent-local-model, model=qwen3-coder, action=add the type annotation
FINDING 2 → tier=script, model=none, action=create a new script check that cycle detection terminates on a cyclic fixture
FINDING 3 → tier=agent-local-model, model=qwen2.5vl:7b, action=render the page and compare screenshots
FINDING 4 → tier=script, model=none, action=grep the comment against the behavior
FINDING 5 → tier=script, model=none, action=verify every import path resolves
FINDING 6 → tier=agent-local-model, model=qwen3-coder, action=replace the literal with var(--accent-amber)
FINDING 7 → tier=opus, model=none, action=decide whether caching is worth it`,

  't4-task-file': `\`\`\`json
{
  "name": "describe-features",
  "description": "Generate descriptions for roadmap features that lack one",
  "items": [{ "subject": "urn:kbase:feature/f36-mobile", "predicate": "kpred:description", "question": "What does this feature do?" }],
  "schema": { "type": "object", "properties": { "description": { "type": "string" } }, "required": ["description"] },
  "accept": "majority",
  "concurrency": 2,
  "model": { "extract": "nuextract", "reason": "qwen3.6" }
}
\`\`\``,

  't5-batch-triage': `\`\`\`json
[
  { "name": "F36 mobile phases and tests", "entries": [1, 2, 5, 7], "tier": "agent", "priority": "normal" },
  { "name": "hasStatus six-state drift", "entries": [3], "tier": "agent", "priority": "immediate" },
  { "name": "hasStatus vocabulary dependency", "entries": [4], "tier": "script", "priority": "hold" },
  { "name": "Schedule type description", "entries": [6], "tier": "agent", "priority": "normal" }
]
\`\`\``,

  't6-edit-space': `\`\`\`turtle
@prefix kpred: <urn:kbase:predicate/> .
@prefix ktype: <urn:kbase:type/> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sched: <urn:reckons:schedule/> .

sched:visual-tests a ktype:Schedule ;
    rdfs:label      "Visual tests — statement readability and layout gates" ;
    kpred:every     "2h" ;
    kpred:description "Run space-visual-gate and visual-diff on the running dev server." .

sched:offline-script-tier a ktype:Schedule ;
    rdfs:label      "Script-tier offline checks" ;
    kpred:every     "1d" ;
    kpred:description "Run the deterministic script-tier checks." .

sched:safety-attestation a ktype:Schedule ;
    rdfs:label      "Safety attestation" ;
    kpred:every     "1w" ;
    kpred:description "Records the safety controls, including any failing one." .

sched:cleanup-icons a ktype:Schedule ;
    rdfs:label      "Cleanup stale icon cache" ;
    kpred:every     "1w" ;
    kpred:command   "npx tsx scripts/offline/cleanup-icons.ts --stale" ;
    kpred:description "Remove stale icons from the cache." .
\`\`\``,
};

const STUFFED = `Plan: script script agent opus immediate group batch @prefix kpred:first-pass rdf:type
ktype:Schedule rdfs:label kpred:enabled nuextract qwen3.6 qwen concurrency accept threshold
concise purpose daily correct proper valid syntax consistent every no loss no duplicates.
tier=script tier=agent tier=opus urgency=immediate model=nuextract period.`;

describe('orchestration scoring', () => {
  for (const task of ORCHESTRATION_TASKS) {
    it(`${task.id}: the reference answer scores full marks`, () => {
      const r = scoreOutput(task, REFERENCE[task.id]);
      expect(r.parseNote).toBeUndefined();
      expect(r.expectations.filter((e) => !e.pass).map((e) => `#${e.n} ${e.text}`)).toEqual([]);
    });

    it(`${task.id}: a keyword-stuffed answer scores at most 1`, () => {
      expect(scoreOutput(task, STUFFED).score).toBeLessThanOrEqual(1);
    });
  }

  it('Turtle with an undeclared prefix fails the parse instead of passing a syntax expectation', () => {
    const t2 = ORCHESTRATION_TASKS.find((t) => t.id === 't2-write-schedule-ttl')!;
    const broken = REFERENCE[t2.id].replace('@prefix kpred: <urn:kbase:predicate/> .\n', '');
    const r = scoreOutput(t2, broken);
    expect(r.parseNote).toMatch(/does not parse/);
    expect(r.score).toBe(0);
  });

  it('a wrong tier for one finding costs exactly that expectation', () => {
    const t3 = ORCHESTRATION_TASKS.find((t) => t.id === 't3-route-batch')!;
    const r = scoreOutput(t3, REFERENCE[t3.id].replace('FINDING 5 → tier=script', 'FINDING 5 → tier=opus'));
    expect(r.expectations.filter((e) => !e.pass).map((e) => e.n)).toEqual([2]);
  });

  it('T5 rejects a grouping that drops an entry', () => {
    const t5 = ORCHESTRATION_TASKS.find((t) => t.id === 't5-batch-triage')!;
    const r = scoreOutput(t5, REFERENCE[t5.id].replace('"entries": [6]', '"entries": []'));
    expect(r.expectations.find((e) => e.n === 6)!.pass).toBe(false);
  });

  it('strips a <think> block before parsing', () => {
    expect(parseOutput('<think>{"x": 1}</think>\n{"y": 2}').json).toEqual([{ y: 2 }]);
  });
});
