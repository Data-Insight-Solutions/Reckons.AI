/**
 * WHAT DOES THE USER ACTUALLY READ? (F203, script tier + local panel) — the UI half of the taxonomy.
 *
 * Matt, 2026-09-30: "consistent terminology in code, consistent in UI". The user-facing word for a
 * knowledge base is SPACE (decided 2026-09-23, kterm:knowledge-base), and the abbreviation KB goes in
 * every register (2026-09-17). term-usage.ts cannot say which occurrences a person sees: its "user"
 * register is a line heuristic, so `aria-label="Open {kb.name}"` counts as user-facing "kb" when kb
 * is a variable. This reads the templates with Svelte's own compiler instead, so only VISIBLE text
 * counts — text nodes and the attributes a person reads or hears (title, aria-label, placeholder,
 * alt) — and <code>/<pre> content is never touched.
 *
 *   ground    SCRIPT: every visible occurrence of KB, "knowledge base" or "graph", with its sentence.
 *   rule      "KB"/"KBs" → "space"/"spaces". A rule, because the abbreviation is retired everywhere:
 *             --apply-kb writes it, case-preserving. Tokens glued to _ : . / (kb_search, urn:kbase)
 *             are identifiers, not words, and are skipped.
 *   judge     "knowledge base" and "graph" are right in some sentences — graph for the DRAWN view,
 *             knowledge base in developer-facing copy — so each goes to the local panel as a task
 *             (--task), answered keep / space / reword. Nothing a model says is applied here.
 *
 * SCRIPT STRINGS TOO. Most user-facing KB wording is built in script — labels passed as props,
 * toasts, notices — so string literals in <script> blocks and the .ts files under src/ are read with the
 * TypeScript parser. Only PROSE counts (a literal with a space in it); console.* arguments are
 * developer output and skipped, as are imports. Whether a script string is user-facing at all is
 * the panel's call, which is why these are never rewritten by rule — even KB, which in a developer
 * message becomes "knowledge base" rather than "space".
 *
 * Usage:
 *   npx tsx scripts/offline/ui-copy.ts                 report
 *   npx tsx scripts/offline/ui-copy.ts --apply-kb      rewrite visible KB/KBs to space/spaces
 *   npx tsx scripts/offline/ui-copy.ts --task=path     write a local-panel task for graph / knowledge base
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
import type { PanelTask } from '../agent/local-panel.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');

/** Attributes whose value a person reads or a screen reader speaks. */
export const USER_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'placeholder', 'alt']);
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style']);

export type Occurrence = {
  file: string;
  line: number;
  start: number;
  end: number;
  word: string;
  kind: 'kb' | 'knowledge-base' | 'graph';
  where: 'text' | 'attribute' | 'script';
  /** The whole visible sentence the word sits in, expressions shown as {…}. */
  sentence: string;
};

export const WORDS = /(?<![\w_:./#-])(KBs?|kbs?|[Kk]nowledge[ -][Bb]ases?|[Gg]raphs?)(?![\w_:/-])/g;

function kindOf(word: string): Occurrence['kind'] {
  // Only the UPPERCASE abbreviation is a word to rewrite. Lowercase `kb` in prose almost always
  // names the field or variable ("needs to set kb." in the review page's tooltip — the first run
  // rewrote it to "space", 2026-09-30, and it was reverted), so it goes to the panel instead.
  if (/^KBs?$/.test(word)) return 'kb';
  if (/^kbs?$/.test(word)) return 'graph';
  if (/^knowledge/i.test(word)) return 'knowledge-base';
  return 'graph';
}

type Node = { type?: string; name?: string; data?: string; start?: number; end?: number; [k: string]: unknown };

/** Visible text of a fragment or attribute value: text as-is, every expression as {…}. */
function sentenceOf(parts: Node[] | undefined): string {
  return (parts ?? []).map((p) => (p.type === 'Text' ? String(p.data ?? '') : p.type === 'ExpressionTag' ? '{…}' : '')).join('').replace(/\s+/g, ' ').trim();
}

export function occurrencesIn(file: string, source: string): Occurrence[] {
  const out: Occurrence[] = [];
  let ast: { fragment: Node };
  try {
    ast = parse(source, { modern: true }) as unknown as { fragment: Node };
  } catch {
    return out;
  }
  const lineOf = (pos: number) => source.slice(0, pos).split('\n').length;
  const scan = (text: Node, where: Occurrence['where'], sentence: string) => {
    const data = String(text.data ?? '');
    for (const m of data.matchAll(WORDS)) {
      const start = (text.start ?? 0) + (m.index ?? 0);
      out.push({ file, line: lineOf(start), start, end: start + m[0].length, word: m[0], kind: kindOf(m[0]), where, sentence });
    }
  };
  const walk = (node: unknown, inCode: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, inCode));
      return;
    }
    const n = node as Node;
    const code = inCode || (typeof n.name === 'string' && CODE_ELEMENTS.has(n.name) && (n.type === 'RegularElement' || n.type === 'SvelteElement'));
    if (n.type === 'Attribute') {
      if (!code && typeof n.name === 'string' && USER_ATTRS.has(n.name) && Array.isArray(n.value)) {
        const parts = n.value as Node[];
        const sentence = sentenceOf(parts);
        for (const p of parts) if (p.type === 'Text') scan(p, 'attribute', sentence);
      }
      return;
    }
    if (n.type === 'Fragment' && Array.isArray(n.nodes)) {
      const parts = n.nodes as Node[];
      const sentence = sentenceOf(parts);
      for (const p of parts) {
        if (p.type === 'Text') {
          if (!code) scan(p, 'text', sentence);
        } else walk(p, code);
      }
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'metadata' || k === 'parent') continue;
      if (v && typeof v === 'object') walk(v, code);
    }
  };
  walk(ast.fragment, false);
  return out;
}

/** "KB" → "space", "KBs" → "spaces", preserving an initial capital or all-caps position. */
/** String literals in TypeScript source that read as prose, with absolute offsets. */
export function scriptOccurrences(file: string, code: string, offset: number, source: string): Occurrence[] {
  const out: Occurrence[] = [];
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const lineOf = (pos: number) => source.slice(0, pos).split('\n').length;
  const insideConsole = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) return true;
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    const isText = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (isText) {
      const value = (n as ts.LiteralLikeNode).text;
      if (/\s/.test(value) && !insideConsole(n)) {
        const raw = n.getText(sf);
        for (const m of raw.matchAll(WORDS)) {
          const start = offset + n.getStart(sf) + (m.index ?? 0);
          const sentence = value.replace(/\s+/g, ' ').trim();
          out.push({ file, line: lineOf(start), start, end: start + m[0].length, word: m[0], kind: kindOf(m[0]), where: 'script', sentence });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function scriptBlocks(source: string): { code: string; offset: number }[] {
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ({ code: m[1], offset: (m.index ?? 0) + m[0].indexOf('>') + 1 }));
}

export function spaceFor(word: string, atSentenceStart: boolean): string {
  const plural = /s$/i.test(word);
  const base = plural ? 'spaces' : 'space';
  return atSentenceStart ? base[0].toUpperCase() + base.slice(1) : base;
}

export function applyKb(source: string, occ: Occurrence[]): string {
  let text = source;
  for (const o of [...occ].filter((x) => x.kind === 'kb' && x.where !== 'script').sort((a, b) => b.start - a.start)) {
    const before = text.slice(0, o.start).replace(/\s+$/, '');
    const atStart = before === '' || /[.!?>"']$/.test(before);
    text = text.slice(0, o.start) + spaceFor(o.word, atStart) + text.slice(o.end);
  }
  return text;
}

export function buildTask(occ: Occurrence[]): PanelTask {
  return {
    id: 'ui-copy-space',
    instruction:
      'A sentence a Reckons.AI user sees contains the word shown. The product has settled its user-facing words: one knowledge base — ' +
      'a collection of entities, statements and sources that the user opens and works inside — is called a SPACE. "graph" stays correct ' +
      'where it means the DRAWN picture (the 2D or 3D graph view, nodes and edges on screen, graph layout) or the general idea of a ' +
      'knowledge graph explained to a technical reader. "knowledge base" stays correct only in developer-facing text (APIs, MCP tools, ' +
      'settings for developers, log and error text meant for developers). The abbreviation "KB" is retired everywhere. Answer "space" if the word ' +
      'refers to the user\'s collection in text a user reads, "knowledge-base" if it is developer-facing text where KB should be spelled out, ' +
      '"keep" if it is right as it is, or "reword" if none fits and a person should rewrite it. Give a reason under 20 words.',
    answer: {
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['space', 'knowledge-base', 'keep', 'reword'] }, reason: { type: 'string', maxLength: 200 } },
      required: ['verdict', 'reason'],
    },
    agreeOn: 'verdict',
    items: occ.map((o) => ({
      id: `${o.file}:${o.line}:${o.start}`,
      context: `FILE ${o.file}\nWORD "${o.word}" (${o.where === 'attribute' ? 'a tooltip or screen-reader label' : o.where === 'script' ? 'a string in code — decide whether a user or a developer reads it' : 'visible text'})\nSENTENCE ${o.sentence}`,
    })),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => !/__tests__|\.test\.ts$|\.spec\.ts$|\.stories\./.test(f));
  const files = tracked.filter((f) => f.endsWith('.svelte'));
  const all: Occurrence[] = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    all.push(...occurrencesIn(f, src));
    for (const b of scriptBlocks(src)) all.push(...scriptOccurrences(f, b.code, b.offset, src));
  }
  for (const f of tracked.filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    all.push(...scriptOccurrences(f, src, 0, src));
  }
  const by = (k: Occurrence['kind'], w?: Occurrence['where']) => all.filter((o) => o.kind === k && (!w || (w === 'script' ? o.where === 'script' : o.where !== 'script')));
  console.log(`templates (${files.length} .svelte): KB ${by('kb', 'text').length} · knowledge base ${by('knowledge-base', 'text').length} · graph ${by('graph', 'text').length}`);
  console.log(`script prose (svelte <script> + src .ts): KB ${by('kb', 'script').length} · knowledge base ${by('knowledge-base', 'script').length} · graph ${by('graph', 'script').length}`);
  for (const o of by('kb', 'text').slice(0, 12)) console.log(`  KB  ${o.file}:${o.line}  "${o.sentence.slice(0, 90)}"`);

  if (argv.includes('--apply-kb')) {
    let changed = 0;
    for (const f of new Set(by('kb', 'text').map((o) => o.file))) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const next = applyKb(src, by('kb', 'text').filter((o) => o.file === f));
      if (next !== src) {
        writeFileSync(join(ROOT, f), next);
        changed++;
      }
    }
    console.log(`--apply-kb: rewrote ${by('kb', 'text').length} template occurrence(s) in ${changed} file(s)`);
  }
  const taskPath = flag('task');
  if (taskPath) {
    const task = buildTask([...by('knowledge-base'), ...by('graph'), ...by('kb', 'script')]);
    writeFileSync(taskPath, JSON.stringify(task, null, 2));
    console.log(`panel task → ${taskPath} (${task.items.length} items); run: npx tsx scripts/agent/local-panel.ts --task=${taskPath}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('ui-copy.ts')) main();
