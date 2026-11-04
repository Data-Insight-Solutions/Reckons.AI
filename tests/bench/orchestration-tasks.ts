/**
 * ORCHESTRATION TASKS — the benchmark for local models acting as an offline orchestrator.
 *
 * These tasks exercise the decisions a model makes when standing in as the deputy:
 * reading pending queue state, decomposing work into sub-agent jobs, writing TTL space
 * statements for those jobs, routing to the right tier/model, and handling batch triage
 * of related findings.
 *
 * Each task has:
 *   id — unique identifier
 *   prompt — what the model is asked to do (with context)
 *   output — the structured form the answer must take; scoring parses it (orchestration-scoring.ts)
 *   ground — the expected correct output, in words, for a human reading the bench
 *   scoring — numbered expectations, 1 point each; `check` is a predicate over the PARSED answer
 *   maxTokens — recommended context window for the task
 */

import {
  NS, okTtl, subjectsOfType, objectsOf, one, jsonObjects, normalizeTier,
  type ParsedOutput,
} from './orchestration-scoring.js';

export type OrchestrationTask = {
  id: string;
  label: string;
  prompt: string;
  output: 'ttl' | 'json' | 'jsonl+ttl' | 'findings';
  ground: string[];
  scoring: Array<{ n: number; text: string; check: (o: ParsedOutput) => boolean }>;
  maxTokens: number;
};

// ── Shared checks ───────────────────────────────────────────────────────────────

const SCHEDULE = `${NS.ktype}Schedule`;
const P = (local: string) => `${NS.kpred}${local}`;
const LABEL = `${NS.rdfs}label`;

type Job = { name: string; tier: string; model: string; taskFile: string; urgency: string };

/** T1 jobs: `{"job": {...}}` lines, or bare job objects. */
function jobs(o: ParsedOutput): Job[] {
  return jsonObjects(o)
    .map((v) => (v.job && typeof v.job === 'object' ? v.job : v) as Record<string, unknown>)
    .filter((j) => typeof j.name === 'string' && typeof j.tier === 'string')
    .map((j) => ({
      name: String(j.name), tier: normalizeTier(String(j.tier)), model: String(j.model ?? ''),
      taskFile: String(j.taskFile ?? ''), urgency: String(j.urgency ?? '').toLowerCase(),
    }));
}
const jobLike = (o: ParsedOutput, re: RegExp) => jobs(o).find((j) => re.test(j.name) || re.test(j.taskFile));

/** T5 groups: a JSON array of `{ name, entries, tier, priority }`. */
type Group = { name: string; entries: number[]; tier: string; priority: string };
function groups(o: ParsedOutput): Group[] {
  return jsonObjects(o)
    .filter((g) => Array.isArray(g.entries))
    .map((g) => ({
      name: String(g.name ?? ''), entries: (g.entries as unknown[]).map(Number),
      tier: normalizeTier(String(g.tier ?? '')), priority: String(g.priority ?? '').toLowerCase(),
    }));
}
const groupOf = (o: ParsedOutput, entry: number) => groups(o).find((g) => g.entries.includes(entry));
const F36 = [1, 2, 5, 7];
const holdsF36 = (g: Group | undefined) => !!g && F36.some((e) => g.entries.includes(e));

/** T4 task file: the first JSON object that names the batch. */
const taskFile = (o: ParsedOutput) => jsonObjects(o).find((v) => typeof v.name === 'string' && 'items' in v);

/** The one Schedule subject in the answer that is not among `existing`. */
function newSchedule(o: ParsedOutput, existing: string[] = []): string | undefined {
  const ttl = okTtl(o);
  return ttl ? subjectsOfType(ttl, SCHEDULE).find((s) => !existing.includes(s)) : undefined;
}

// ── Task definitions ────────────────────────────────────────────────────────────

const T6_EXISTING = ['visual-tests', 'offline-script-tier', 'safety-attestation'].map((s) => `${NS.sched}${s}`);
const T6_KEPT: Array<[string, string]> = [
  [`${NS.sched}visual-tests`, 'Run space-visual-gate and visual-diff on the running dev server.'],
  [`${NS.sched}safety-attestation`, 'Records the safety controls, including any failing one.'],
];

export const ORCHESTRATION_TASKS: OrchestrationTask[] = [

  // ── T1: Decompose pending entries into sub-agent jobs ──────────────────────────
  {
    id: 't1-decompose-jobs',
    label: 'Decompose pending queue into actionable jobs',
    output: 'jsonl+ttl',
    prompt: `You are the offline orchestrator for Reckons.AI. You read the local pending queue and produce a set of sub-agent job definitions.

The workspace has these pending entries (from knowledge.pending.jsonl):

1. { subject: "urn:kbase:feature/f80-mesh", predicate: "kpred:description", object: "Answer over a LoRa mesh across the homestead", note: "Phase 8 of F80 — Matt wants mesh networking for voice notes at the homestead.", type: "suggestion" }
2. { subject: "urn:kbase:feature/f80-mesh", predicate: "kpred:depends-on", object: "urn:kbase:feature/f79-voice-agents", note: null, type: "question" }
3. { subject: "urn:kbase:predicate/describe", predicate: "kpred:description", object: "Generates kpred:description proposals for entities lacking one.", note: "Matt, 2026-10-26: 'we should run describe-entities on every activation, not just the first time.' Also it needs to handle entity types it has never seen before — currently drops unknown classes silently.", type: "drift-warning" }
4. { subject: "urn:kbase:feature/f36-mobile", predicate: "kpred:has-status", object: "in-progress", note: null, type: "status-update" }

For each entry, produce a sub-agent job definition in JSONL format (one line per job). Each job should be typed with:
- name: a short kebab-case job name derived from the subject
- tier: which execution tier (script / agent / opus) — the routing ladder is script first, then a local model, then a Sonnet/Haiku subagent, then Opus; a rule a script can check never goes to a model
- model: which specific Ollama model if agent tier (e.g. qwen3-coder, devstral-small-2, nuextract for extraction)
- taskFile: a brief description of what the sub-agent should do
- urgency: "immediate" | "deferred" | "holds"

For entry #3 (drift-warning), also produce the TTL statement that should be added to reckons-workspace/schedules.ttl to fix it. Use proper TTL syntax with @prefix declarations (kpred: is <urn:kbase:predicate/>) and kpred:first-pass support.

Output format — JSONL lines:
{"job": {"name": "...", "tier": "...", "model": "...", "taskFile": "...", "urgency": "..."}}
Then the schedule update as Turtle in a \`\`\`turtle block.`,
    ground: [
      'f80-mesh-job with tier=agent (suggestion for complex feature work)',
      'f79-dependency-check as tier=agent or script (question about dependency)',
      'describe-entities-fix with urgency immediate; taskFile covers unknown entity types',
      'f36-mobile status-update as tier=script (simple status change)',
      'TTL parses, declares kpred: correctly, and uses kpred:first-pass',
      'Nothing goes to opus',
    ],
    scoring: [
      { n: 1, text: 'Job for the f80-mesh suggestion is agent tier',
        check: (o) => jobLike(o, /f80|mesh|lora/i)?.tier === 'agent-local' },
      { n: 2, text: 'Job for the f79 dependency question is script or agent tier, not opus',
        check: (o) => ['script', 'agent-local'].includes(jobLike(o, /f79|depend|voice/i)?.tier ?? '') },
      { n: 3, text: 'Drift-warning job is urgency=immediate and its taskFile covers unknown entity types',
        check: (o) => { const j = jobLike(o, /describ|drift/i); return !!j && j.urgency === 'immediate' && /unknown|unseen|never seen|new (entity )?(type|class)|unrecogni/i.test(j.taskFile); } },
      { n: 4, text: 'Status-update job is script tier',
        check: (o) => jobLike(o, /f36|mobile|status/i)?.tier === 'script' },
      { n: 5, text: 'Turtle parses, declares kpred: as <urn:kbase:predicate/>, and uses kpred:first-pass',
        check: (o) => { const t = okTtl(o); return !!t && t.prefixes.kpred === NS.kpred && t.quads.some((q) => q.predicate.value === P('first-pass')); } },
      { n: 6, text: 'Four jobs, none escalated to opus',
        check: (o) => { const js = jobs(o); return js.length >= 4 && js.every((j) => j.tier !== 'opus'); } },
    ],
    maxTokens: 16384,
  },

  // ── T2: Write TTL for new schedule entity ──────────────────────────────────────
  {
    id: 't2-write-schedule-ttl',
    label: 'Write TTL for a new schedule entity from specification',
    output: 'ttl',
    prompt: `You are the offline orchestrator. Matt says: "Add a schedule that runs the script-tier offline checks every day."

The existing schedule entities in reckons-workspace/schedules.ttl use this pattern:

sched:<name> rdf:type      ktype:Schedule ;
    rdfs:label      "Display label" ;
    kpred:every     "<interval>" ;
    kpred:command   "<shell command>" ;
    kpred:tier      "<script|agent>" ;
    kpred:harness   "session-worker" ;
    kpred:enabled   "true" ;
    kpred:description "Description text." .

The namespaces are: kpred: <urn:kbase:predicate/>, ktype: <urn:kbase:type/>, sched: <urn:reckons:schedule/>.

The command to run is: 'npm run offline:all -- --tier=script' (deterministic checks, zero tokens).

Requirements:
- It runs daily (kpred:every = "1d")
- Tier is script (it's a deterministic check)
- harness is session-worker
- The description must say WHY this schedule exists, what it checks, and that it runs daily
- No kpred:network (no internet access)
- No kpred:first-pass (not urgent on startup)

Write the complete TTL entity with @prefix declarations, in a \`\`\`turtle block.`,
    ground: [
      'Parses with every prefix declared (rdf, rdfs, kpred, ktype, sched)',
      'One ktype:Schedule with label, every "1d", command, tier "script", harness, enabled "true", description',
      'Description says why and that it runs daily',
      'No kpred:network, no kpred:first-pass',
    ],
    scoring: [
      { n: 1, text: 'Turtle parses (every prefix declared) and has exactly one ktype:Schedule',
        check: (o) => { const t = okTtl(o); return !!t && subjectsOfType(t, SCHEDULE).length === 1; } },
      { n: 2, text: 'Schedule carries label, every, command, tier, harness, enabled, description',
        check: (o) => { const t = okTtl(o); const s = newSchedule(o); return !!t && !!s && [LABEL, ...['every', 'command', 'tier', 'harness', 'enabled', 'description'].map(P)].every((p) => objectsOf(t, s, p).length > 0); } },
      { n: 3, text: 'kpred:tier "script"',
        check: (o) => { const t = okTtl(o); const s = newSchedule(o); return !!t && !!s && one(t, s, P('tier')) === 'script'; } },
      { n: 4, text: 'kpred:command is the specified npm command',
        check: (o) => { const t = okTtl(o); const s = newSchedule(o); return !!t && !!s && (one(t, s, P('command')) ?? '').includes('offline:all -- --tier=script'); } },
      { n: 5, text: 'Description is a real sentence that says it runs daily',
        check: (o) => { const t = okTtl(o); const s = newSchedule(o); const d = t && s ? one(t, s, P('description')) ?? '' : ''; return d.length >= 40 && /daily|every day|each day|once a day/i.test(d); } },
      { n: 6, text: 'Honors the negatives and the interval: every "1d", no network, no first-pass',
        check: (o) => { const t = okTtl(o); const s = newSchedule(o); return !!t && !!s && one(t, s, P('every')) === '1d' && objectsOf(t, s, P('network')).length === 0 && objectsOf(t, s, P('first-pass')).length === 0; } },
    ],
    maxTokens: 8192,
  },

  // ── T3: Route a batch of findings by tiering ladder ────────────────────────────
  {
    id: 't3-route-batch',
    label: 'Route a batch of related findings through the routing ladder',
    output: 'findings',
    prompt: `You are the offline orchestrator. A single pull request touched 7 files across src/lib/rdf/ and generated these observations:

1. "urn:kbase:predicate/removeTrailingSpace" in src/lib/rdf/hierarchy.ts is used as a function but has no type annotation
2. "graph-lint.ts line 42: checks skos:broader traversal but doesn't verify the cycle detection terminates"
3. "ghost-graph.ts opacity value changed from 0.18 to 0.25 — visual regression risk, needs page render test"
4. "rdf/hierarchy.ts:67 - isMetaPredicate() suppresses nav correctly but documentation comment says it doesn't"
5. "rdf/normalize-entities.ts: removeTrailingSpace was moved from rdf/lib to rdf and imports updated everywhere"
6. "ghost-graph.ts — the amber color should use --accent-amber CSS variable for theme support"
7. "rdf/hierarchy.ts — tree layout algorithm is O(n²), consider caching for >100 node graphs"

Apply the routing ladder (F74.3): deterministic script → local model (general, then specialized) → Sonnet/Haiku subagent → Opus. Take the first rung that can do the job correctly; a rule a script can check never goes to a model. Each attempt is recorded, so repeated failures on a rung is evidence for promotion.

For each finding:
1. Which rung does it land on? (script / agent-local-model / agent-subagent / opus)
2. If agent-tier, which model?
3. What should the sub-agent or script do exactly?
4. Does any finding suggest a new deterministic script should be created? Say so in that finding's action.

Output exactly one line per finding: FINDING <n> → tier=<tier>, model=<model-or-none>, action=<what to do>`,
    ground: [
      'Finding 2 (graph-lint cycle detection): script — deterministically checkable',
      'Finding 5 (removeTrailingSpace move): script — import path verification',
      'Finding 6 (hard-coded color vs CSS variable): script or local model, never higher',
      'Finding 7 (O(n²) algorithm): opus or subagent — architectural reasoning',
      'At least one action proposes a new deterministic script',
      'All seven routed; no over-escalation',
    ],
    scoring: [
      { n: 1, text: 'Finding 2 routed to script',
        check: (o) => o.findings.get(2)?.tier === 'script' },
      { n: 2, text: 'Finding 5 routed to script',
        check: (o) => o.findings.get(5)?.tier === 'script' },
      { n: 3, text: 'Finding 7 routed to opus or agent-subagent',
        check: (o) => ['opus', 'agent-subagent'].includes(o.findings.get(7)?.tier ?? '') },
      { n: 4, text: 'Finding 6 (CSS variable) routed to script or a local model, not higher',
        check: (o) => ['script', 'agent-local'].includes(o.findings.get(6)?.tier ?? '') },
      { n: 5, text: 'Some action proposes creating a new deterministic script',
        check: (o) => [...o.findings.values()].some((f) => /(new|create|add|write|promot)\w*\b.{0,40}\b(script|check|lint)/i.test(f.action)) },
      { n: 6, text: 'All seven findings routed, at most two at opus',
        check: (o) => [1, 2, 3, 4, 5, 6, 7].every((n) => o.findings.get(n)?.tier) && [...o.findings.values()].filter((f) => f.tier === 'opus').length <= 2 },
    ],
    maxTokens: 16384,
  },

  // ── T4: Define sub-agent task file for complex decomposition ───────────────────
  {
    id: 't4-task-file',
    label: 'Create a task file for multi-step sub-agent work',
    output: 'json',
    prompt: `You are the offline orchestrator. Matt's pending queue has this request:

User message (verbatim): "I need to make sure all my feature entities in the roadmap TTL have descriptions. For features that don't have one, generate a description based on their rdfs:label and any kpred:description fragments. Use nuextract for extraction work and qwen3.6 for general reasoning about what the feature does."

Create a task file (task.json) that defines this as a structured sub-agent job. The task file format should include:
- name, description
- items: array of objects with { subject, predicate, question, schema? }
- schema: JSON schema for structured output
- accept: what threshold to use (unanimous/majority/default)
- concurrency: how many items to process in parallel
- model: which Ollama model(s) to use

The entities in the roadmap are typed ktype:Feature, have IRIs like urn:kbase:feature/f36-mobile, and carry rdfs:label and sometimes partial kpred:description. You need to find all features without a complete description and generate one.

Write the complete task.json as one JSON object in a \`\`\`json block.`,
    ground: [
      'Parses as JSON with name and description',
      'items subjects are urn:kbase:feature/* IRIs',
      'schema is an object schema with a description property',
      'nuextract for extraction, qwen3.6 for reasoning',
      'accept is one of the three thresholds; concurrency is a positive integer',
    ],
    scoring: [
      { n: 1, text: 'Parses as one JSON object with string name and description',
        check: (o) => { const t = taskFile(o); return !!t && typeof t.description === 'string'; } },
      { n: 2, text: 'items is non-empty and every subject is a urn:kbase:feature/ IRI',
        check: (o) => { const items = taskFile(o)?.items; return Array.isArray(items) && items.length > 0 && items.every((i) => /^urn:kbase:feature\//.test(String((i as Record<string, unknown>)?.subject ?? ''))); } },
      { n: 3, text: 'schema is an object schema with a description-like property',
        check: (o) => { const s = taskFile(o)?.schema as Record<string, unknown> | undefined; const props = s?.properties as Record<string, unknown> | undefined; return s?.type === 'object' && !!props && Object.keys(props).some((k) => /desc/i.test(k)); } },
      { n: 4, text: 'nuextract named for extraction',
        check: (o) => /nuextract/i.test(JSON.stringify(taskFile(o)?.model ?? '')) },
      { n: 5, text: 'qwen3.6 named for reasoning',
        check: (o) => /qwen3\.6/i.test(JSON.stringify(taskFile(o)?.model ?? '')) },
      { n: 6, text: 'accept is unanimous/majority/default and concurrency a positive integer',
        check: (o) => { const t = taskFile(o); return !!t && ['unanimous', 'majority', 'default'].includes(String(t.accept)) && Number.isInteger(t.concurrency) && (t.concurrency as number) > 0; } },
    ],
    maxTokens: 8192,
  },

  // ── T5: Batch triage — group related pending entries ───────────────────────────
  {
    id: 't5-batch-triage',
    label: 'Triage a batch of related findings and group them into coherent work',
    output: 'json',
    prompt: `You are the offline orchestrator. Here is the current pending queue (knowledge.pending.jsonl):

1. { subject: "urn:kbase:feature/f36-mobile", predicate: "kpred:description", object: "Phase 2 — Sheet/Drawer for mobile navigation", note: "Needs visual testing on iOS Safari.", type: "suggestion" }
2. { subject: "urn:kbase:feature/f36-mobile", predicate: "kpred:tested-by", object: "src/lib/components/ui/__tests__/mobile-sheet.test.ts", note: null, type: "suggestion" }
3. { subject: "urn:kbase:predicate/hasStatus", predicate: "kpred:description", object: "Tracks feature lifecycle through six states.", note: "PR #45 references this but TTL has five states. The graph was updated 2026-09-18 to add in-progress but the test suite and docs lag behind.", type: "drift-warning" }
4. { subject: "urn:kbase:predicate/hasStatus", predicate: "kpred:depends-on", object: "urn:kbase:vocabulary/voc-ttl", note: null, type: "question" }
5. { subject: "urn:kbase:feature/f36-mobile", predicate: "kpred:tested-by", object: "tests/visual/__tests__/mobile-reflow.test.ts", note: "Phase 3 — Pointer Events reflow.", type: "suggestion" }
6. { subject: "urn:kbase:type/Schedule", predicate: "kpred:description", object: "Defines recurring task schedules in the knowledge graph.", note: "Should reference kpred:first-pass and kpred:harness as valid properties.", type: "suggestion" }
7. { subject: "urn:kbase:feature/f36-mobile", predicate: "kpred:has-status", object: "in-progress", note: "Phase 1 code merged to PR #45 but phases 2-4 unstarted.", type: "status-update" }

Group related entries into coherent work items. Every entry belongs to exactly one group. For each group give:
- name: what the work item is
- entries: which pending entries it covers (by number)
- tier: script / agent / opus
- priority: "immediate" | "normal" | "hold" — drift warnings that need attention now are split out as immediate

Output a JSON array of {"name", "entries", "tier", "priority"} objects in a \`\`\`json block.`,
    ground: [
      'Entries 1,2,5,7 grouped together (same feature)',
      'Entry 3 split out, priority immediate',
      'Entry 4 not in the F36 group (lookup or hold)',
      'Named groups, sensible tiers, every entry exactly once',
    ],
    scoring: [
      { n: 1, text: 'F36 entries 1,2,5,7 in one group',
        check: (o) => { const g = groupOf(o, 1); return !!g && F36.every((e) => g.entries.includes(e)); } },
      { n: 2, text: 'Entry 3 split from F36 work with priority immediate',
        check: (o) => { const g = groupOf(o, 3); return !!g && !holdsF36(g) && g.priority === 'immediate'; } },
      { n: 3, text: 'Entry 4 handled apart from the F36 work',
        check: (o) => { const g = groupOf(o, 4); return !!g && !holdsF36(g); } },
      { n: 4, text: 'Every group has a descriptive name (not "Group N")',
        check: (o) => { const gs = groups(o); return gs.length > 0 && gs.every((g) => g.name.trim().length >= 6 && !/^(group|item|work item)\s*\d*$/i.test(g.name.trim())); } },
      { n: 5, text: 'Tiers: every group has one, entry 6 is not opus, opus is a minority',
        check: (o) => { const gs = groups(o); return gs.length > 0 && gs.every((g) => g.tier) && groupOf(o, 6)?.tier !== 'opus' && gs.filter((g) => g.tier === 'opus').length * 2 < gs.length; } },
      { n: 6, text: 'Entries 1–7 each appear exactly once',
        check: (o) => { const all = groups(o).flatMap((g) => g.entries).sort((a, b) => a - b); return all.join(',') === '1,2,3,4,5,6,7'; } },
    ],
    maxTokens: 16384,
  },

  // ── T6: Edit space statements — add and update entity properties ───────────────
  {
    id: 't6-edit-space',
    label: 'Edit space statements: add kpred:description to feature entities',
    output: 'ttl',
    prompt: `You are the offline orchestrator. You need to edit space statements (TTL) to add descriptions to features that lack them.

The schedule TTL excerpt (reckons-workspace/schedules.ttl):

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
    kpred:every     "1d" .
    # NOTE: This entity is MISSING its kpred:description — fix this.

sched:safety-attestation a ktype:Schedule ;
    rdfs:label      "Safety attestation" ;
    kpred:every     "1w" ;
    kpred:description "Records the safety controls, including any failing one." .

Your task:
1. Add kpred:description to sched:offline-script-tier with appropriate text
2. The description should match the style of the surrounding entries (concise, mentions the purpose)
3. Also add a TTL entity for a NEW schedule: "cleanup stale icon cache" that runs weekly via 'npx tsx scripts/offline/cleanup-icons.ts --stale'

Output the complete edited TTL block, in a \`\`\`turtle block.`,
    ground: [
      'kpred:description added to sched:offline-script-tier, one concise sentence',
      'New ktype:Schedule with label, weekly every, the command, a description',
      'Parses; the other two entities unchanged; prefixes unchanged',
    ],
    scoring: [
      { n: 1, text: 'sched:offline-script-tier now has a kpred:description',
        check: (o) => { const t = okTtl(o); return !!t && objectsOf(t, `${NS.sched}offline-script-tier`, P('description')).length === 1; } },
      { n: 2, text: 'That description matches the style: one sentence, ≤120 chars, ends with a period',
        check: (o) => { const t = okTtl(o); const d = t ? one(t, `${NS.sched}offline-script-tier`, P('description')) ?? '' : ''; return d.length >= 15 && d.length <= 120 && /\.$/.test(d) && !/\.\s+\S/.test(d); } },
      { n: 3, text: 'A new ktype:Schedule entity (resolves to urn:kbase:type/Schedule)',
        check: (o) => !!newSchedule(o, T6_EXISTING) },
      { n: 4, text: 'New entity has label, weekly every, the cleanup-icons command, a description',
        check: (o) => { const t = okTtl(o); const s = newSchedule(o, T6_EXISTING); return !!t && !!s && objectsOf(t, s, LABEL).length > 0 && /^(1w|7d|weekly)$/i.test(one(t, s, P('every')) ?? '') && (one(t, s, P('command')) ?? '').includes('cleanup-icons.ts --stale') && objectsOf(t, s, P('description')).length > 0; } },
      { n: 5, text: 'Parses, and the two untouched entities keep their exact descriptions',
        check: (o) => { const t = okTtl(o); return !!t && T6_KEPT.every(([s, d]) => objectsOf(t, s, P('description')).join('\n') === d); } },
      { n: 6, text: 'Prefix declarations preserved exactly',
        check: (o) => { const p = okTtl(o)?.prefixes; return !!p && p.kpred === NS.kpred && p.ktype === NS.ktype && p.rdfs === NS.rdfs && p.sched === NS.sched; } },
    ],
    maxTokens: 8192,
  },

];

export const TOTAL = ORCHESTRATION_TASKS.reduce((sum, t) => sum + t.scoring.length, 0);
