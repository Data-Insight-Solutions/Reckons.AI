#!/usr/bin/env npx tsx
/**
 * The backlog — the genuinely-open items, ranked by what they hold up and how long they've waited.
 *
 * `orchestrate` answers "how do I CLEAR the queue" (cluster → remedy). This answers the human
 * question underneath Matt's ask: "of the things nobody could confidently answer, which are
 * BLOCKING something, and which have been CARRIED OVER sweep after sweep?" Same classifier
 * (triage.ts), different lens — items, not clusters, sorted by blast radius then age.
 *
 * Only JUDGMENT items appear (the real backlog). Re-derivable noise and remediable clusters are
 * excluded — they are not backlog, they are a source fix and a task respectively. Each item shows:
 *   • whether it BLOCKS named work (the thing it holds up), and
 *   • its AGE in days (how many times it has been carried over), flagged 🕸 when stale.
 *
 * Usage:
 *   npm run backlog                the ranked backlog
 *   npm run backlog -- --stale 7   only items carried over 7+ days
 *   npm run backlog -- --json
 */
import { existsSync, readFileSync } from 'fs';
import { classify, isDeskQuestion, ageDays, isBlocking, signature, type PendingItem } from './triage.js';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const ANSWERS = 'reckons-workspace/knowledge.answers.jsonl';
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const staleFlag = argv.indexOf('--stale');
const STALE_MIN = staleFlag >= 0 ? Number(argv[staleFlag + 1] ?? 7) : 0;

const readJsonl = (f: string): PendingItem[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];

const answered = new Set(readJsonl(ANSWERS).map((a) => `${a.subject}|${a.predicate}`));

/** The real backlog: unanswered judgment items, blocking first, then oldest first. */
export function backlogItems(pendingFile = PENDING, now = Date.now()): PendingItem[] {
  return readJsonl(pendingFile)
    .filter((p) => p.object == null)
    .filter((p) => !answered.has(`${p.subject}|${p.predicate}`))
    .filter((p) => classify(p).kind === 'judgment')
    .filter((p) => ageDays(p, now) >= STALE_MIN)
    .sort((a, b) => {
      if (isBlocking(a) !== isBlocking(b)) return isBlocking(a) ? -1 : 1; // blocking first
      return ageDays(b, now) - ageDays(a, now); // then oldest (most carried-over) first
    });
}

const short = (iri: string) => (iri ?? '').replace(/^.*[/#:]/, '');

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith('backlog.ts');
if (isMain) {
  const items = backlogItems();
  const STALE_AT = 7;

  if (JSON_OUT) {
    console.log(JSON.stringify(items.map((p) => ({
      subject: p.subject, predicate: p.predicate, cluster: signature(p),
      decision: isDeskQuestion(p), blocks: p.blocks ?? null, ageDays: ageDays(p),
      question: p.question,
    })), null, 2));
    process.exit(0);
  }

  const blocking = items.filter(isBlocking).length;
  const stale = items.filter((p) => ageDays(p) >= STALE_AT).length;
  const decisions = items.filter(isDeskQuestion).length;

  console.log(`${B}Backlog${X} ${D}— ${items.length} genuinely-open item(s): ${blocking} blocking, ${stale} stale (${STALE_AT}d+), ${decisions} awaiting a decision${X}\n`);
  if (!items.length) {
    console.log(`  ${G}✓ nothing carried over and nothing blocked.${X}\n`);
    process.exit(0);
  }

  for (const p of items) {
    const age = ageDays(p);
    const staleMark = age >= STALE_AT ? `${R}🕸 ${age}d${X}` : `${D}${age}d${X}`;
    const block = isBlocking(p) ? `${R}⛔ blocks ${short(p.blocks!)}${X}` : `${D}blocks nothing${X}`;
    const kind = isDeskQuestion(p) ? `${Y}decision${X}` : `${C}work${X}`;
    console.log(`  ${kind}  ${staleMark}  ${block}  ${D}[${signature(p)}]${X}`);
    console.log(`     ${(p.question ?? `${short(p.subject)} ${short(p.predicate)}`).replace(/^\[[\w /-]+\]\s*/, '').slice(0, 140)}`);
  }
  console.log(`\n  ${D}decisions → answer them: npm run desk   ·   work → schedule/write   ·   stale + blocks-nothing → consider dropping${X}\n`);
}
