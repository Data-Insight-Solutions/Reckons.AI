#!/usr/bin/env npx tsx
/**
 * Writes the review story space `review-community-garden` (Maple Row Community Garden, invented; the
 * content is in garden-story.ts) into a workspace folder, in the app's own annotated export form so every
 * fact keeps its review status, its source and its quoted passage when the app imports it.
 *
 *   npx tsx scripts/review-spaces/build-garden.ts [--workspace=<dir>] [--check]
 *
 * Default workspace: this repository's reckons-workspace. The space is written to
 * <workspace>/kbs/review-community-garden/review-community-garden.ttl with its assets beside it:
 *   assets/previews/<slot>.webp    a picture made by a local job (see generate-assets.ts), once it exists
 *   assets/splats/<content id>.ply a scan attached the way scripts/content/scan-attach.ts attaches one
 *   assets/generated/<slot>/       what a generation job wrote: the picture, the splat and receipt.json
 *   sources/<id>.md                the three sources' text, which the facts quote
 * NOTHING HERE IS SHIPPED: reckons-workspace/kbs/* is git-ignored (only this generator and its story are tracked).
 *
 * A slot whose picture or splat has not been generated is LEFT EMPTY and reported; no placeholder is made.
 * Scans use the real attach code (copySplatToSpace, attachRows, linkRows) and a splat made by TripoSplat
 * from a picture is labelled origin "generated", because that is what it is: invented, not reconstructed
 * from the phone video.
 *
 * --check validates the story (every cited fact exists, every excerpt is in its source, the proposal passes
 * its shape, every question names what it blocks) and, if an output exists, that it is current.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { hashSourceText } from '../../src/lib/rdf/source-cache.js';
import { ACTION_STATUS, validateProposal, type Proposal } from '../../src/lib/rdf/proposal.js';
import { iri, lit, type Source, type Statement, type Term } from '../../src/lib/rdf/types.js';
import { attachRows, contentId, linkRows, type AttachRow } from '../content/scan-attach.js';
import * as S from './garden-story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = Date.parse('2026-11-10T09:00:00Z');
const NOTE_AT = Date.parse('2026-11-11T07:30:00Z');
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const ACTION = 'https://schema.org/actionStatus';
const PREVIEW = 'urn:kbase:asset/preview';
const XSD_DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const KP = (p: string) => S.PRED + p;
const C = (id: string) => S.CONCEPT + id;

// ── validation: the story must hold together before anything is written ─────────────────────────────────

export function validateStory(): string[] {
  const bad: string[] = [];
  const ents = new Set(S.ENTITIES.map((e) => e.id).concat([S.PROPOSAL.entity, S.PROPOSAL.target.entity], S.OPTIONS.map((o) => o.entity)));
  const text = new Map(S.SOURCES.map((s) => [s.id, s.text]));
  text.set(S.VOLUNTEER_NOTE.id, S.VOLUNTEER_NOTE.text);
  const needEnt = (id: string, where: string) => { if (!ents.has(id)) bad.push(`${where}: unknown entity "${id}"`); };
  const needQuote = (src: string | undefined, ex: string | undefined, where: string) => {
    if (!src && !ex) return;
    const t = src ? text.get(src) : undefined;
    if (t === undefined) bad.push(`${where}: unknown source "${src}"`);
    else if (!ex || !t.includes(ex)) bad.push(`${where}: passage not found in ${src}: "${ex}"`);
  };
  for (const e of S.ENTITIES) if (e.parent) needEnt(e.parent, `parent of ${e.id}`);
  for (const f of S.CONFIRMED) {
    needEnt(f.s, `fact ${f.s} ${f.p}`);
    if (typeof f.o !== 'string') needEnt(f.o.ref, `fact ${f.s} ${f.p} object`);
    needQuote(f.source, f.excerpt, `fact ${f.s} ${f.p}`);
  }
  for (const d of S.DATES) { needEnt(d.s, `date ${d.s}`); needQuote(d.source, d.excerpt, `date ${d.s}`); }
  if (S.SOURCES.length !== 3) bad.push('the story needs exactly three sources');
  // The proposal passes its shape, with citations that are real confirmed facts.
  const idOf = (s: string, p: string) => S.CONFIRMED.filter((f) => f.s === s && f.p === p).map((f) => factId(f));
  const proposal: Proposal = {
    id: S.PROPOSAL.entity, status: ACTION_STATUS.potential,
    targetShape: { id: S.PROPOSAL.target.entity, requirements: [{ s: C('garden'), p: KP('growing-beds') }] },
    recommendedId: S.OPTIONS.find((o) => o.recommended)?.id ?? null,
    options: S.OPTIONS.map((o) => ({ id: o.id, label: o.label, citations: o.rests.flatMap(([s, p]) => idOf(s, p)) })),
  };
  for (const i of validateProposal(proposal)) bad.push(`proposal: ${i.code}: ${i.message}`);
  for (const o of S.OPTIONS) {
    for (const [s, p] of o.rests) if (!idOf(s, p).length) bad.push(`option ${o.id} rests on a fact that does not exist: ${s} ${p}`);
    for (const f of o.facts) if (typeof f.o !== 'string') needEnt(f.o.ref, `option ${o.id} fact`);
  }
  if (S.OPTIONS.filter((o) => o.recommended).length !== 1) bad.push('exactly one option must be recommended');
  for (const q of S.QUESTIONS) {
    needEnt(q.s, `question "${q.question}"`);
    if (!q.blocks.length) bad.push(`question "${q.question}" names nothing it blocks`);
    for (const b of q.blocks) needEnt(b, `question "${q.question}" blocks`);
    if (!q.blocks.some((b) => S.OPTIONS.some((o) => o.entity === b))) bad.push(`question "${q.question}" blocks no option`);
    needQuote(q.source, q.excerpt, `question "${q.question}"`);
  }
  for (const f of S.VOLUNTEER_NOTE.facts) { needEnt(f.s, `note fact ${f.p}`); if (typeof f.o !== 'string') needEnt(f.o.ref, `note fact ${f.p}`); needQuote(S.VOLUNTEER_NOTE.id, f.excerpt, `note fact ${f.p}`); }
  for (const sl of S.SLOTS) if (sl.splat?.forCapture) needEnt(sl.splat.forCapture, `slot ${sl.id}`);
  for (const e of S.ENTITIES) if (e.preview && !S.SLOTS.some((s) => s.id === e.preview)) bad.push(`${e.id}: preview slot "${e.preview}" is not defined`);
  if (S.WALK.length < 6 || S.WALK.length > 9) bad.push('the walk needs 6 to 9 steps');
  return bad;
}

// ── statements ─────────────────────────────────────────────────────────────────────────────────────

const SRC = (id: string) => `urn:kbase:source/${id}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const factId = (f: { s: string; p: string; o: unknown }) => `mrg-${sha(`${f.s}|${f.p}|${JSON.stringify(f.o)}`)}`;
const term = (o: string | { ref: string }): Term => (typeof o === 'string' ? lit(o) : iri(C(o.ref)));

function st(sourceId: string, s: string, p: string, o: Term, status: Statement['status'], extra: Partial<Statement> = {}, at = AT): Statement {
  return {
    id: `mrg-${sha(`${sourceId}|${s}|${p}|${o.kind}:${o.value}`)}`, s: iri(s), p: iri(p), o, g: iri(SRC(sourceId)), sourceId,
    confidence: status === 'confirmed' ? 1 : 0.8, status, createdAt: at, updatedAt: at, ...extra,
  };
}

export interface BuildResult { ttl: string; statements: Statement[]; sources: Source[]; empty: string[]; sourceTexts: Record<string, string>; splats: { slot: string; file: string; id: string }[] }

/** Pure apart from reading the generated slots under `spaceDir/assets/generated`. */
export async function buildGarden(spaceDir: string): Promise<BuildResult> {
  const problems = validateStory();
  if (problems.length) throw new Error(`the story does not validate:\n  ${problems.join('\n  ')}`);
  const out: Statement[] = [];
  const empty: string[] = [];
  const splats: BuildResult['splats'] = [];
  const gen = (slot: string, file: string) => path.join(spaceDir, 'assets', 'generated', slot, file);
  const hasImage = (slot: string) => existsSync(gen(slot, 'image.webp'));

  // The places, people, events and ideas: curated, held.
  const CUR = 'story-curated';
  for (const e of S.ENTITIES) {
    out.push(st(CUR, C(e.id), RDF_TYPE, iri(S.TYPE + e.type), 'confirmed'));
    out.push(st(CUR, C(e.id), RDFS_LABEL, lit(e.label), 'confirmed'));
    if (e.comment) out.push(st(CUR, C(e.id), RDFS_COMMENT, lit(e.comment), 'confirmed'));
    if (e.parent) out.push(st(CUR, C(e.id), BROADER, iri(C(e.parent)), 'confirmed'));
    if (e.preview) {
      if (hasImage(e.preview)) out.push(st(CUR, C(e.id), PREVIEW, lit(`assets/previews/${e.preview}.webp`), 'confirmed'));
      else if (!empty.includes(`picture: ${e.preview}`)) empty.push(`picture: ${e.preview}`);
    }
  }
  // Facts that rest on a passage.
  const quote = (src: string, ex: string | undefined): Partial<Statement> => (ex ? { excerpt: ex, grounded: true } : {});
  for (const f of S.CONFIRMED) out.push(st(f.source ?? CUR, C(f.s), KP(f.p), term(f.o), 'confirmed', quote(f.source ?? CUR, f.excerpt)));
  for (const d of S.DATES) out.push(st(d.source ?? CUR, C(d.s), KP(d.p), lit(`${d.value}T00:00`, XSD_DT), 'confirmed', quote(d.source ?? CUR, d.excerpt)));

  // A reckoning in progress: the proposal and its target are held (a person started it); every option's facts are PENDING and name it.
  const P = S.PROPOSAL;
  out.push(st(CUR, C(P.entity), RDF_TYPE, iri(S.TYPE + 'Proposal'), 'confirmed'));
  out.push(st(CUR, C(P.entity), RDFS_LABEL, lit(P.label), 'confirmed'));
  out.push(st(CUR, C(P.entity), ACTION, iri(ACTION_STATUS.potential), 'confirmed'));
  out.push(st(CUR, C(P.entity), KP('target-shape'), iri(C(P.target.entity)), 'confirmed'));
  out.push(st(CUR, C(P.target.entity), RDF_TYPE, iri(S.TYPE + 'Concept'), 'confirmed'));
  out.push(st(CUR, C(P.target.entity), RDFS_LABEL, lit(P.target.label), 'confirmed'));
  out.push(st(CUR, C(P.target.entity), RDFS_COMMENT, lit(P.target.comment), 'confirmed'));
  out.push(st(CUR, C('six-beds'), KP('is-the-goal-of'), iri(C(P.entity)), 'confirmed'));
  const RK = 'reckoning';
  for (const o of S.OPTIONS) {
    const opt = { proposalOption: o.id };
    out.push(st(RK, C(P.entity), KP('has-option'), iri(C(o.entity)), 'pending', opt));
    out.push(st(RK, C(o.entity), RDF_TYPE, iri(S.TYPE + 'Concept'), 'pending', opt));
    out.push(st(RK, C(o.entity), RDFS_LABEL, lit(o.label), 'pending', opt));
    out.push(st(RK, C(o.entity), RDFS_COMMENT, lit(o.comment), 'pending', opt));
    if (o.recommended) out.push(st(RK, C(P.entity), KP('recommended-option'), iri(C(o.entity)), 'pending', opt));
    for (const f of o.facts) out.push(st(RK, C(o.entity), KP(f.p), term(f.o), 'pending', opt));
    for (const subject of [...new Set(o.rests.map(([s]) => s))]) out.push(st(RK, C(o.entity), KP('rests-on'), iri(C(subject)), 'pending', opt));
  }
  // Open questions: partial facts, each naming what it blocks.
  for (const q of S.QUESTIONS) {
    out.push(st(q.source ?? CUR, C(q.s), KP(q.p), lit('?'), 'pending', { needsObject: true, question: q.question, blocks: q.blocks.map(C), ...quote(q.source ?? CUR, q.excerpt) }));
  }
  // A volunteer's note, just ingested: pending, belongs to no option.
  for (const f of S.VOLUNTEER_NOTE.facts) out.push(st(S.VOLUNTEER_NOTE.id, C(f.s), KP(f.p), term(f.o), 'pending', quote(S.VOLUNTEER_NOTE.id, f.excerpt), NOTE_AT));

  // Scans, attached the way the scan job attaches one: its real attach code builds the rows.
  const rowToStatement = (r: AttachRow): Statement => {
    const base: Partial<Statement> = r.question ? { needsObject: true, question: r.question } : {};
    const o = r.question ? lit('?') : r.objectKind === 'iri' ? iri(r.object!) : lit(r.object!);
    return st('scan-job', r.subject, r.predicate, o, 'pending', base);
  };
  for (const slot of S.SLOTS.filter((x) => x.splat)) {
    const file = gen(slot.id, 'splat.ply');
    if (!existsSync(file)) { empty.push(`scan: ${slot.id}`); continue; }
    const id = contentId(readFileSync(file), 'ply');
    splats.push({ slot: slot.id, file, id });
    const label = slot.splat!.label;
    const links = slot.splat!.forCapture ? { derivedFrom: [C(slot.splat!.forCapture)] } : {};
    for (const r of [...attachRows(S.SLUG, id, label, 'generated'), ...linkRows(S.SLUG, id, links, true)]) out.push(rowToStatement(r));
  }

  const sourceTexts: Record<string, string> = Object.fromEntries([...S.SOURCES.map((s) => [s.id, s.text]), [S.VOLUNTEER_NOTE.id, S.VOLUNTEER_NOTE.text]]);
  const mk = async (id: string, title: string, text: string | undefined, at: number): Promise<Source> =>
    ({ id, title, uri: `note://sample/${id}`, kind: 'document', ingestedAt: at, trustLevel: 'review', ...(text ? { hash: await hashSourceText(text) } : {}) });
  const sources: Source[] = [
    { id: CUR, title: 'Maple Row review story, as written for the review', uri: 'note://sample/story-curated', kind: 'turtle', ingestedAt: AT, trustLevel: 'trusted' },
    ...(await Promise.all(S.SOURCES.map((s) => mk(s.id, s.title, s.text, AT)))),
    await mk(S.VOLUNTEER_NOTE.id, S.VOLUNTEER_NOTE.title, S.VOLUNTEER_NOTE.text, NOTE_AT),
    { id: RK, title: 'Reckoning in progress: six more beds', uri: 'note://sample/reckoning', kind: 'analysis', ingestedAt: AT, trustLevel: 'review' },
  ];
  if (splats.length) sources.push({ id: 'scan-job', title: 'Scans attached by the scan job', uri: 'note://sample/scan-job', kind: 'document', ingestedAt: AT, trustLevel: 'review' });

  const header = ['Reckons.AI — review story: Maple Row Community Garden (invented).', 'GENERATED by scripts/review-spaces/build-garden.ts from scripts/review-spaces/garden-story.ts. Do not edit by hand.', 'Everything here is made up: no real garden, city or person.'].join('\n');
  const ttl = toTurtleFull(out, sources, { header }).replace(/^# generated .*\n/m, '');
  return { ttl, statements: out, sources, empty, sourceTexts, splats };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────

export const spaceDir = (workspace: string) => path.join(workspace, 'kbs', S.SLUG);

async function main(): Promise<void> {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const workspace = path.resolve(arg('workspace') ?? path.join(ROOT, 'reckons-workspace'));
  const dir = spaceDir(workspace);
  const file = path.join(dir, `${S.SLUG}.ttl`);
  const r = await buildGarden(dir);
  const counts = r.statements.reduce<Record<string, number>>((c, x) => ({ ...c, [x.status]: (c[x.status] ?? 0) + 1 }), {});
  const summary = `${r.statements.length} facts (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${r.sources.length} sources`;
  const emptyNote = r.empty.length ? `\nLEFT EMPTY (not generated yet, no placeholder made): ${r.empty.join(', ')}` : '';
  if (process.argv.includes('--check')) {
    console.log(`build-garden --check: story validates; ${summary}${emptyNote}`);
    if (existsSync(file) && readFileSync(file, 'utf8') !== r.ttl) { console.error(`build-garden --check: ${file} is stale. Re-run without --check.`); process.exit(1); }
    console.log(existsSync(file) ? 'output is current' : 'no output at this workspace yet');
    return;
  }
  mkdirSync(path.join(dir, 'sources'), { recursive: true });
  for (const [id, text] of Object.entries(r.sourceTexts)) writeFileSync(path.join(dir, 'sources', `${id}.md`), text + '\n');
  for (const sl of S.SLOTS) if (existsSync(path.join(dir, 'assets', 'generated', sl.id, 'image.webp'))) {
    mkdirSync(path.join(dir, 'assets', 'previews'), { recursive: true });
    copyFileSync(path.join(dir, 'assets', 'generated', sl.id, 'image.webp'), path.join(dir, 'assets', 'previews', `${sl.id}.webp`));
  }
  for (const sp of r.splats) { mkdirSync(path.join(dir, 'assets', 'splats'), { recursive: true }); copyFileSync(sp.file, path.join(dir, 'assets', 'splats', sp.id)); }
  writeFileSync(file, r.ttl);
  console.log(`wrote ${file}\n${summary}${emptyNote}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-garden.ts')) void main();
