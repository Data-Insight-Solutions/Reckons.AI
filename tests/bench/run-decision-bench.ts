/**
 * DECISION-BACKEND BENCHMARK — does a probabilistic decision model beat a rule?
 *
 *   npx tsx tests/bench/run-decision-bench.ts                        # baseline only
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx tests/bench/run-decision-bench.ts --ollama=qwen3:32b
 *   JEV_API_KEY=... npx tsx tests/bench/run-decision-bench.ts --jev
 *
 * WHY THE BASELINE IS THE POINT. AGENTS.md routes every recurring task to the cheapest tier that
 * can do it correctly, and prefers growing the script tier because deterministic checks have zero
 * triage cost — they are right by construction. `readIntent` is that tier, already tuned. So the
 * bar for a decision model is not "is it accurate", it is "does it beat a free, instant,
 * hallucination-proof rule, ON THE CASES THE RULE GETS WRONG". A model that ties on the easy
 * slice has made the system slower and more expensive for nothing, and this report separates
 * those two slices so a tie cannot be read as a win.
 *
 * Jev is a cloud API. Nothing here adopts it: this measures first, and the integration-boundary
 * rule still applies afterwards.
 */
import { readIntent } from '../../src/lib/rdf/note-intent';
import { classifyText } from '../../src/lib/safety/content-policy';
import { INTENT_CASES, SAFETY_CASES, EASY_INTENT, TASKS } from './decision-golden';
import { needsEscalation } from '../../src/lib/rdf/intent-escalation';

type Verdict = { choice: string; confidence: number | null };
type Backend = { name: string; intent(t: string): Promise<Verdict>; safety(t: string): Promise<Verdict> };

const args = process.argv.slice(2);
const flag = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1];

/** The shipped deterministic code, called directly — not a reimplementation of it. */
const heuristic: Backend = {
  name: 'heuristic (shipped, script tier)',
  async intent(t) {
    const r = readIntent(t);
    return { choice: r.intent, confidence: typeof r.score === 'number' ? r.score : null };
  },
  async safety(t) {
    const r = classifyText(t);
    return { choice: (r as { classification?: string }).classification ?? 'none', confidence: null };
  }
};

/** A local LLM forced into the same bounded choice, as the agent-tier control. */
function ollamaBackend(model: string): Backend {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const ask = async (question: string, options: readonly string[], text: string): Promise<Verdict> => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false,
        format: { type: 'object', properties: { choice: { type: 'string', enum: [...options] } }, required: ['choice'] },
        messages: [
          { role: 'system', content: `${question}\nAnswer with one of: ${options.join(', ')}.` },
          { role: 'user', content: text }
        ],
        options: { temperature: 0 }
      })
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = await res.json() as { message?: { content?: string } };
    const parsed = JSON.parse(body.message?.content ?? '{}') as { choice?: string };
    return { choice: parsed.choice ?? 'ERROR', confidence: null };
  };
  return {
    name: `ollama:${model} (agent tier)`,
    intent: t => ask(TASKS.intent.question, TASKS.intent.options, t),
    safety: t => ask(TASKS.safety.question, TASKS.safety.options, t)
  };
}

/**
 * Jev adapter. UNVERIFIED AGAINST A LIVE ENDPOINT — there is no key in this environment, so the
 * request shape below is written from the public description (state + bounded question -> a
 * probability per option) and has never been executed. Treat a first run as a smoke test of this
 * adapter as much as of the model, and fix it here rather than trusting these numbers blind.
 */
function jevBackend(): Backend {
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error('JEV_API_KEY is not set — cannot benchmark Jev. Baselines still run without --jev.');
  const endpoint = process.env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/choice';
  const ask = async (question: string, options: readonly string[], text: string): Promise<Verdict> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ state: text, question, options })
    });
    if (!res.ok) throw new Error(`jev ${res.status}`);
    const body = await res.json() as { probabilities?: Record<string, number>; choice?: string };
    if (body.probabilities) {
      const [choice, p] = Object.entries(body.probabilities).sort((a, b) => b[1] - a[1])[0] ?? ['ERROR', 0];
      return { choice, confidence: p };
    }
    return { choice: body.choice ?? 'ERROR', confidence: null };
  };
  return {
    name: 'jev (cloud)',
    intent: t => ask(TASKS.intent.question, TASKS.intent.options, t),
    safety: t => ask(TASKS.safety.question, TASKS.safety.options, t)
  };
}

type Row = { backend: string; task: string; slice: string; n: number; correct: number; p50: number };

async function score(b: Backend): Promise<Row[]> {
  const rows: Row[] = [];
  const run = async (
    task: 'intent' | 'safety',
    cases: Array<{ text: string; label: string }>,
    slice: string
  ) => {
    if (cases.length === 0) return;
    let correct = 0;
    const times: number[] = [];
    for (const c of cases) {
      const t0 = performance.now();
      let v: Verdict;
      try { v = await (task === 'intent' ? b.intent(c.text) : b.safety(c.text)); }
      catch (e) { v = { choice: `ERROR:${(e as Error).message.slice(0, 30)}`, confidence: null }; }
      times.push(performance.now() - t0);
      if (v.choice === c.label) correct++;
    }
    times.sort((a, b2) => a - b2);
    rows.push({ backend: b.name, task, slice, n: cases.length, correct, p50: times[Math.floor(times.length / 2)] ?? 0 });
  };
  await run('intent', INTENT_CASES.filter(c => EASY_INTENT.has(c.text)), 'easy (a rule should win)');
  await run('intent', INTENT_CASES.filter(c => !EASY_INTENT.has(c.text)), 'HARD (where a model must earn it)');
  await run('safety', SAFETY_CASES, 'all');
  return rows;
}

/**
 * RULE-GATES-MODEL: the rule answers, and only a HEDGED reading is escalated. This is the
 * shippable configuration — it pays model latency on the ambiguous band alone, and inherits the
 * rule's 10/10 on the easy slice for free. It cannot fix a reading the rule got confidently
 * wrong, by construction, and the report exists to show exactly how much that leaves behind.
 */
const escalations = { calls: 0, seen: 0 };
function gatedBackend(inner: Backend): Backend {
  return {
    name: `gated: rule -> ${inner.name.split(' ')[0]}`,
    async intent(t) {
      const r = readIntent(t);
      escalations.seen++;
      if (!needsEscalation(r)) return { choice: r.intent, confidence: r.score };
      // p50 hides this: the median sentence costs nothing, the escalated minority pays full price.
      escalations.calls++;
      return inner.intent(t);
    },
    safety: t => heuristic.safety(t)
  };
}

const backends: Backend[] = [heuristic];
const ollamaModel = flag('ollama');
if (ollamaModel) {
  const o = ollamaBackend(ollamaModel);
  backends.push(o, gatedBackend(o));
}
if (args.includes('--jev')) backends.push(jevBackend());

const all: Row[] = [];
for (const b of backends) all.push(...await score(b));

console.log('\nDecision-backend benchmark');
console.log('='.repeat(78));
console.log(`${'backend'.padEnd(34)}${'slice'.padEnd(34)}${'acc'.padEnd(10)}p50`);
console.log('-'.repeat(78));
for (const r of all) {
  const acc = `${r.correct}/${r.n}`;
  console.log(`${r.backend.padEnd(34)}${(r.task + ' ' + r.slice).padEnd(34)}${acc.padEnd(10)}${r.p50.toFixed(0)}ms`);
}

const hard = all.filter(r => r.slice.startsWith('HARD'));
const base = hard.find(r => r.backend === heuristic.name);
console.log('\nVERDICT');
if (!base) console.log('  no baseline row — nothing to compare against.');
else if (backends.length === 1) {
  console.log(`  Baseline only. The rule gets ${base.correct}/${base.n} on the hard slice; that is the`);
  console.log('  number any model has to beat. Re-run with --ollama=<model> or --jev to compare.');
} else {
  for (const r of hard.filter(r2 => r2.backend !== heuristic.name)) {
    const delta = r.correct - base.correct;
    console.log(`  ${r.backend}: ${delta > 0 ? `+${delta}` : delta} vs the rule on the hard slice` +
      `${delta <= 0 ? ' — has not earned its cost or latency.' : ''}`);
  }
}
if (escalations.seen > 0) {
  const pct = ((escalations.calls / escalations.seen) * 100).toFixed(0);
  console.log(`\n  Gate spent ${escalations.calls} model call(s) over ${escalations.seen} sentence(s) (${pct}%).`);
  console.log('  p50 of 0ms above is the MEDIAN sentence, which never escalates — an escalated one');
  console.log('  still costs full model latency. Read the call count, not the median.');
}
console.log('\nSmall n. This is a decision harness with a real baseline, not a published result.');
