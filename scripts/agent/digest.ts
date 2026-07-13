#!/usr/bin/env npx tsx
/**
 * The rolling digest (F80 / kb:async-digest, SCRIPT tier).
 *
 * Replaces the chat summary. The old loop was: agent finishes a slice → writes a summary
 * → BLOCKS until Matt reads it. Twenty interruptions, each one a stall, and at the end
 * Matt has to reconstruct the whole story from a scrollback.
 *
 * Instead, agents APPEND findings to one report that grows. Matt reads it when he
 * returns: a single dated page, newest first, with each finding typed and linked to the
 * graph entity it concerns. Nothing waited on him.
 *
 * The digest is a plain markdown file in the workspace so it is readable anywhere, and it
 * is ALSO emitted as graph facts, so it is searchable, mergeable, and shows up next to the
 * feature it is about. The graph is the sounding board; this is how findings reach it.
 *
 * Usage:
 *   npx tsx scripts/agent/digest.ts --type bug-found \
 *     --about kb:trust-system \
 *     --headline "Confirming a fact made its source LESS trusted" \
 *     [--detail "..."] [--agent claude-code]
 *
 *   npx tsx scripts/agent/digest.ts --show          print the digest
 *   npx tsx scripts/agent/digest.ts --session-start "pre-announcement sweep"
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { askGraph, expandIri } from './ask.js';

const DIGEST = 'reckons-workspace/DIGEST.md';
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

/** What kind of finding this is. Typed, so the digest can be skimmed and filtered. */
export type FindingType =
  | 'bug-found'
  | 'claim-falsified'
  | 'test-added'
  | 'question-raised'
  | 'decision-needed'
  | 'shipped'
  | 'note';

const ICON: Record<FindingType, string> = {
  'bug-found': '🐛',
  'claim-falsified': '❌',
  'test-added': '✅',
  'question-raised': '❓',
  'decision-needed': '🔶',
  shipped: '🚢',
  note: '·',
};

export interface Finding {
  type: FindingType;
  /** The graph entity this concerns, e.g. kb:trust-system. */
  about?: string;
  headline: string;
  detail?: string;
  agent?: string;
}

export function appendFinding(f: Finding, digestPath = DIGEST): string {
  mkdirSync(path.dirname(digestPath), { recursive: true });

  if (!existsSync(digestPath)) {
    writeFileSync(
      digestPath,
      `# Reckons.AI — rolling agent digest\n\n` +
        `One report that GROWS, instead of many that interrupt (F80 / kb:async-digest).\n` +
        `Agents append here while you are away. Nothing in this file waited on you.\n\n` +
        `Questions needing your answer appear in the app's **Review tab** as partial facts\n` +
        `(object \`?\`, with an entity picker). Answering one unblocks whatever it was holding up.\n\n` +
        `---\n`,
    );
  }

  const when = new Date().toISOString();
  const lines = [
    ``,
    `### ${ICON[f.type]} ${f.headline}`,
    ``,
    `\`${f.type}\`${f.about ? ` · **${f.about}**` : ''} · ${when}${f.agent ? ` · _${f.agent}_` : ''}`,
    ``,
  ];
  if (f.detail) lines.push(f.detail, ``);

  appendFileSync(digestPath, lines.join('\n'));

  // A finding that only exists in a markdown file is not in the graph, and therefore is
  // not searchable, mergeable, or attached to the feature it concerns. Emit it as a fact
  // too — pending, because a finding is a proposal until a human confirms it.
  if (f.about) {
    const line = JSON.stringify({
      subject: expandIri(f.about),
      predicate: expandIri(`kpred:${f.type.replace(/-/g, '-')}`),
      object: f.headline,
      note: f.detail,
      type: f.type === 'question-raised' || f.type === 'decision-needed' ? 'question' : 'observation',
      agent: f.agent ?? 'agent',
      priority: f.type === 'bug-found' || f.type === 'claim-falsified' ? 'high' : 'medium',
      addedAt: when,
      addedByMcp: true,
    });
    mkdirSync(path.dirname(PENDING), { recursive: true });
    const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
    if (!existing.includes(f.headline)) appendFileSync(PENDING, line + '\n');
  }

  return when;
}

/** Start a new session block, so a returning reader can see what happened when. */
export function startSession(label: string, digestPath = DIGEST): void {
  mkdirSync(path.dirname(digestPath), { recursive: true });
  const header = `\n\n## ${label} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n`;
  appendFileSync(digestPath, header);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('digest.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    if (hit) return hit.split('=').slice(1).join('=');
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };

  if (argv.includes('--show')) {
    console.log(existsSync(DIGEST) ? readFileSync(DIGEST, 'utf8') : 'No digest yet.');
    process.exit(0);
  }

  const session = flag('session-start');
  if (session) {
    startSession(session);
    console.log(`Session opened: ${session}`);
    process.exit(0);
  }

  const type = flag('type') as FindingType | undefined;
  const headline = flag('headline');
  if (!type || !headline || !(type in ICON)) {
    console.error(`Usage: digest.ts --type <${Object.keys(ICON).join('|')}> --headline "..." [--about kb:x] [--detail "..."]`);
    process.exit(2);
  }

  appendFinding({ type, headline, about: flag('about'), detail: flag('detail'), agent: flag('agent') });
  console.log(`Appended to ${DIGEST}. Nobody was interrupted.`);
}
