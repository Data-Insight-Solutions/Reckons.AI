#!/usr/bin/env npx tsx
/**
 * Writes the v0.2.9 REVIEW space `review-garden-redesign-v029` (Larkspur Lane Community Garden, invented; the
 * content is in garden-redesign-story.ts) into a PRIVATE workspace folder, in the app's own annotated export
 * form so every fact keeps its standing, its source and its quoted passage when the app imports it.
 *
 *   npx tsx scripts/review-spaces/build-garden-redesign.ts --workspace=<dir> [--queue] [--cad] [--check]
 *
 * A review space is not an example: it is never written under static/ or content/, never listed in the app's
 * example list, and this script refuses a workspace that is inside this repository's tracked folders.
 *
 *   <workspace>/kbs/review-garden-redesign-v029/review-garden-redesign-v029.ttl
 *   <workspace>/kbs/review-garden-redesign-v029/sources/<id>.md           the sources' text, which the facts quote
 *   <workspace>/kbs/review-garden-redesign-v029/assets/previews|models|cad|splats   what jobs and the CAD run made
 *
 * --queue  writes one generation request per picture (and one splat chained from the garden picture) into
 *          <workspace>/.reckons-generation/jobs/ and lets the repository's own GenerationRunner enqueue them in the
 *          local job queue. NOTHING RUNS INLINE. Ids are derived from the slot, so a second run adds nothing.
 * --cad    builds the corner bracket from its part spec with scripts/content/cad (build123d, then Blender).
 * Re-run without flags after the jobs finish: each completed, receipt-checked picture is copied in and linked.
 * A slot whose job has not finished is LEFT EMPTY and reported; no placeholder is ever made.
 *
 * --check validates the story and, if an output exists, that it is current.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDiff, type Diff } from '../../src/lib/rdf/diff.js';
import { GENERATION_DIR, parseJob, parseRequest, type GenerationRequest } from '../../src/lib/generation/protocol.js';
import { reckoningSource, reckoningStatements } from '../../src/lib/rdf/reckoning-entity.js';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { hashSourceText } from '../../src/lib/rdf/source-cache.js';
import { iri, lit, type Source, type Statement, type Term } from '../../src/lib/rdf/types.js';
import { attachRows, contentId, linkRows, type AttachRow } from '../content/scan-attach.js';
import { STORY } from '../starter/site-story.js';
import * as S from './garden-redesign-story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const PREVIEW = 'urn:kbase:asset/preview';
const MODEL = 'urn:kbase:asset/model';
const XSD_DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const KP = (p: string) => S.PRED + p;
const C = (id: string) => S.CONCEPT + id;
const at = (day: string) => Date.parse(`${day}T09:00:00Z`);
const AT = at('2026-11-04');

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const SRC = (id: string) => `urn:kbase:source/${id}`;
const term = (o: string | { ref: string }): Term => (typeof o === 'string' ? lit(o) : iri(C(o.ref)));
const CUR = 'story-curated';

function st(sourceId: string, s: string, p: string, o: Term, status: Statement['status'], extra: Partial<Statement> = {}, when = AT): Statement {
  return {
    id: `lgr-${sha(`${sourceId}|${s}|${p}|${o.kind}:${o.value}`)}`, s: iri(s), p: iri(p), o, g: iri(SRC(sourceId)), sourceId,
    confidence: status === 'confirmed' ? 1 : 0.8, status, createdAt: when, updatedAt: when, ...extra,
  };
}

// ── validation: the story must hold together before anything is written ─────────────────────────────────

export function validateStory(): string[] {
  const bad: string[] = [];
  const ents = new Set([...S.ENTITIES, ...S.LATER_ENTITIES].map((e) => e.id));
  const text = new Map([...S.SOURCES, S.LATER_NOTE].map((s) => [s.id, s.text]));
  const needEnt = (id: string, where: string) => { if (!ents.has(id)) bad.push(`${where}: unknown entity "${id}"`); };
  const needQuote = (src: string, ex: string, where: string) => {
    const t = text.get(src);
    if (t === undefined) bad.push(`${where}: unknown source "${src}"`);
    else if (!t.includes(ex)) bad.push(`${where}: passage not found in ${src}: "${ex}"`);
  };
  for (const e of S.ENTITIES) if (e.parent) needEnt(e.parent, `parent of ${e.id}`);
  for (const f of S.HELD) {
    needEnt(f.s, `fact ${f.s} ${f.p}`);
    if (typeof f.o !== 'string') needEnt(f.o.ref, `fact ${f.s} ${f.p} object`);
    if (f.source && f.excerpt) needQuote(f.source, f.excerpt, `fact ${f.s} ${f.p}`);
  }
  needEnt(S.QUESTION.s, 'question');
  for (const b of S.QUESTION.blocks) needEnt(b, 'question blocks');
  needQuote(S.QUESTION.source, S.QUESTION.excerpt, 'question');
  for (const f of S.LATER_FACTS) { needEnt(f.s, `later fact ${f.s} ${f.p}`); needQuote(S.LATER_NOTE.id, f.excerpt, `later fact ${f.s} ${f.p}`); }
  for (const e of S.ENTITIES) if (e.preview && !S.SLOTS.some((s) => s.id === e.preview)) bad.push(`${e.id}: preview slot "${e.preview}" is not defined`);
  for (const r of S.RECKONINGS) for (const [s, p] of r.situation) if (!heldId(s, p)) bad.push(`reckoning ${r.id}: no held fact ${s} ${p}`);
  for (const step of S.WALK) for (const h of step.highlights) needEnt(h, `walk step "${step.title}"`);
  const features = S.WALK.map((w) => w.feature).filter((f) => f !== 'intro');
  for (const f of ['reckoning', 'compare', 'cad', 'hub-assets'] as const) if (features.filter((x) => x === f).length !== 1) bad.push(`the walk needs exactly one step for ${f}`);
  return bad;
}

// ── the held statements and the later note, as Statements ─────────────────────────────────────────────

const heldStatement = (f: S.Fact): Statement => st(f.source ?? CUR, C(f.s), KP(f.p), term(f.o), 'confirmed', f.excerpt ? { excerpt: f.excerpt, grounded: true } : {}, at(S.SOURCES.find((x) => x.id === f.source)?.at ?? '2026-11-04'));
const questionStatement = (): Statement => st(S.QUESTION.source, C(S.QUESTION.s), KP(S.QUESTION.p), lit('?'), 'pending',
  { needsObject: true, question: S.QUESTION.question, blocks: S.QUESTION.blocks.map(C), excerpt: S.QUESTION.excerpt, grounded: true });
function heldId(s: string, p: string): string | null {
  const f = S.HELD.find((x) => x.s === s && x.p === p);
  if (f) return heldStatement(f).id;
  return s === S.QUESTION.s && p === S.QUESTION.p ? questionStatement().id : null;
}
export const laterStatements = (): Statement[] => S.LATER_FACTS.map((f) =>
  st(S.LATER_NOTE.id, C(f.s), KP(f.p), lit(f.o), 'pending', { excerpt: f.excerpt, grounded: true }, at(S.LATER_NOTE.at)));

/** What the app's own comparison (computeDiff) says about the later note against the held facts, per later fact. */
export function compareOutcomes(): { fact: S.LaterFact; kind: string }[] {
  const diff: Diff = computeDiff(laterStatements(), S.HELD.map(heldStatement));
  return S.LATER_FACTS.map((fact, i) => ({ fact, kind: diff.entries[i].kind }));
}

// ── generation requests: one per picture, a splat chained from the garden picture ───────────────────────

/** A stable version-4 UUID from a name, so the same slot always gets the same job and a re-run adds nothing. */
export function jobId(name: string): string {
  const h = createHash('sha256').update(`${S.SLUG}|${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function generationRequests(): GenerationRequest[] {
  const out: GenerationRequest[] = [];
  for (const sl of S.SLOTS) {
    out.push({ version: 1, id: jobId(`${sl.id}/image`), spaceId: S.SLUG, stage: 'image', prompt: sl.prompt, seed: sl.seed });
    if (sl.splat) out.push({ version: 1, id: jobId(`${sl.id}/splat`), spaceId: S.SLUG, stage: 'splat', prompt: sl.prompt, seed: sl.seed, parentId: jobId(`${sl.id}/image`) });
  }
  return out.map((r) => parseRequest(r));
}

const jobsDir = (workspace: string) => path.join(workspace, GENERATION_DIR, 'jobs');

/** Write the request files (never overwriting an existing one). Returns the ids written and those already there. */
export function writeRequests(workspace: string): { written: string[]; existing: string[] } {
  const written: string[] = []; const existing: string[] = [];
  for (const r of generationRequests()) {
    const dir = path.join(jobsDir(workspace), r.id);
    if (existsSync(path.join(dir, 'request.json'))) { existing.push(r.id); continue; }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, 'request.json'), JSON.stringify(r), { mode: 0o600 });
    written.push(r.id);
  }
  return { written, existing };
}

/** A finished, receipt-checked job's output file, or null while it is queued, running, failed or cancelled. */
export function finishedOutput(workspace: string, request: GenerationRequest): string | null {
  const dir = path.join(jobsDir(workspace), request.id);
  try {
    const job = parseJob(JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')), request);
    if (job.state !== 'completed' || !job.receipt) return null;
    const file = path.join(dir, job.receipt.output.file);
    const bytes = readFileSync(file);
    return createHash('sha256').update(bytes).digest('hex') === job.receipt.output.sha256 ? file : null;
  } catch { return null; }
}

// ── the whole space ─────────────────────────────────────────────────────────────────────────────────────

export interface BuildResult { ttl: string; statements: Statement[]; sources: Source[]; empty: string[]; sourceTexts: Record<string, string>; copies: { from: string; to: string }[] }

export async function buildGarden(workspace: string): Promise<BuildResult> {
  const problems = validateStory();
  if (problems.length) throw new Error(`the story does not validate:\n  ${problems.join('\n  ')}`);
  const spaceDir = path.join(workspace, 'kbs', S.SLUG);
  const out: Statement[] = [];
  const empty: string[] = [];
  const copies: BuildResult['copies'] = [];
  const reqs = generationRequests();

  for (const e of [...S.ENTITIES]) {
    out.push(st(CUR, C(e.id), RDF_TYPE, iri(S.TYPE + e.type), 'confirmed'));
    out.push(st(CUR, C(e.id), RDFS_LABEL, lit(e.label), 'confirmed'));
    if (e.comment) out.push(st(CUR, C(e.id), RDFS_COMMENT, lit(e.comment), 'confirmed'));
    if (e.parent) out.push(st(CUR, C(e.id), BROADER, iri(C(e.parent)), 'confirmed'));
    if (e.date) out.push(st(CUR, C(e.id), KP(e.date.p), lit(`${e.date.value}T00:00`, XSD_DT), 'confirmed'));
    if (e.preview) {
      const r = reqs.find((q) => q.id === jobId(`${e.preview}/image`))!;
      const file = finishedOutput(workspace, r);
      if (file) {
        const rel = `assets/previews/${e.preview}.webp`;
        copies.push({ from: file, to: path.join(spaceDir, rel) });
        out.push(st(CUR, C(e.id), PREVIEW, lit(rel), 'confirmed'));
      } else empty.push(`picture: ${e.preview}`);
    }
  }
  for (const f of S.HELD) out.push(heldStatement(f));
  out.push(questionStatement());

  // The later note: pending, to be compared against what is held. Its own subject only it names is pending too.
  for (const e of S.LATER_ENTITIES) {
    out.push(st(S.LATER_NOTE.id, C(e.id), RDF_TYPE, iri(S.TYPE + e.type), 'pending', {}, at(S.LATER_NOTE.at)));
    out.push(st(S.LATER_NOTE.id, C(e.id), RDFS_LABEL, lit(e.label), 'pending', {}, at(S.LATER_NOTE.at)));
  }
  out.push(...laterStatements());

  // Reckonings: the person's own choice, written confirmed by the app's own writer.
  const reckonSources: Source[] = [];
  for (const r of S.RECKONINGS) {
    const ids = r.situation.map(([s, p]) => heldId(s, p)!);
    const target = { statementId: r.target.question ? questionStatement().id : null, assetType: r.target.assetType, note: r.target.note };
    out.push(...reckoningStatements(r.id, ids, r.note, at('2026-11-17'), target));
    reckonSources.push(reckoningSource(r.id, r.note, at('2026-11-17')));
  }

  // The corner bracket: attached only once the CAD run produced its files.
  const cadDir = path.join(spaceDir, 'assets', 'cad', `cad-${S.BRACKET_SPEC.name}`);
  const receiptFile = path.join(cadDir, 'cad-receipt.json');
  if (existsSync(receiptFile)) {
    const rc = JSON.parse(readFileSync(receiptFile, 'utf8')) as { specSha256: string; origin: string; volumeMm3: number; tools: Record<string, string>; bboxMm: { x: number; y: number; z: number }; files: { glb?: { name: string } }; blender?: { frames: { name: string }[] } };
    const specEnt = C('corner-bracket-spec');
    out.push(st(CUR, C('corner-bracket'), MODEL, lit(`assets/models/${S.BRACKET_SPEC.name}.glb`), 'confirmed'));
    if (rc.blender?.frames[0]) out.push(st(CUR, C('corner-bracket'), PREVIEW, lit(`assets/previews/${S.BRACKET_SPEC.name}.png`), 'confirmed'));
    out.push(st(CUR, specEnt, RDF_TYPE, iri(S.TYPE + 'Concept'), 'confirmed'));
    out.push(st(CUR, specEnt, RDFS_LABEL, lit('Part spec: corner bracket'), 'confirmed'));
    out.push(st(CUR, specEnt, BROADER, iri(C('corner-bracket')), 'confirmed'));
    out.push(st(CUR, specEnt, RDFS_COMMENT, lit('A part described as numbers in millimetres. The solid was built from exactly these and its measured box was checked against them.'), 'confirmed'));
    for (const [k, v] of Object.entries(S.BRACKET_SPEC.params)) out.push(st(CUR, specEnt, KP(`param-${k.replace(/_/g, '-')}`), lit(String(v)), 'confirmed'));
    out.push(st(CUR, C('corner-bracket'), KP('made-from'), iri(specEnt), 'confirmed'));
    out.push(st(CUR, C('corner-bracket'), KP('origin-label'), lit(rc.origin), 'confirmed'));
    out.push(st(CUR, C('corner-bracket'), KP('generated-with'), lit(`build123d ${rc.tools.build123d} and ${rc.tools.blender ?? 'Blender'}`), 'confirmed'));
    out.push(st(CUR, C('corner-bracket'), KP('measured-box'), lit(`${rc.bboxMm.x} x ${rc.bboxMm.y} x ${rc.bboxMm.z} mm`), 'confirmed'));
    out.push(st(CUR, C('corner-bracket'), KP('spec-sha256'), lit(rc.specSha256), 'confirmed'));
    copies.push({ from: path.join(cadDir, rc.files.glb?.name ?? 'part.glb'), to: path.join(spaceDir, 'assets', 'models', `${S.BRACKET_SPEC.name}.glb`) });
    if (rc.blender?.frames[0]) copies.push({ from: path.join(cadDir, rc.blender.frames[0].name), to: path.join(spaceDir, 'assets', 'previews', `${S.BRACKET_SPEC.name}.png`) });
  } else empty.push('cad: corner-bracket (run with --cad)');

  // The garden splat, attached the way the scan job attaches one; labelled generated, because it is invented.
  const splatReq = reqs.find((r) => r.stage === 'splat');
  const splatFile = splatReq ? finishedOutput(workspace, splatReq) : null;
  if (splatFile) {
    const id = contentId(readFileSync(splatFile), 'ply');
    copies.push({ from: splatFile, to: path.join(spaceDir, 'assets', 'splats', id) });
    const row = (r: AttachRow): Statement => {
      const o = r.question ? lit('?') : r.objectKind === 'iri' ? iri(r.object!) : lit(r.object!);
      return st('scan-job', r.subject, r.predicate, o, 'pending', r.question ? { needsObject: true, question: r.question } : {});
    };
    for (const r of [...attachRows(S.SLUG, id, 'Splat of the garden (generated from one picture)', 'generated'), ...linkRows(S.SLUG, id, { derivedFrom: [C('garden')] }, true)]) out.push(row(r));
  } else if (splatReq) empty.push('splat: garden');

  // The guided walk, in the app's story vocabulary (src/lib/rdf/story.ts), held.
  const storyIri = `${STORY}garden-redesign-v029`;
  const sp = (p: string) => `${STORY}${p}`;
  out.push(st(CUR, storyIri, RDF_TYPE, iri(`${STORY}Story`), 'confirmed'));
  out.push(st(CUR, storyIri, RDFS_LABEL, lit('Walk through the garden redesign'), 'confirmed'));
  out.push(st(CUR, storyIri, sp('description'), lit('Five short steps: the garden, a reckoning, a comparison, a built part and the generated pictures.'), 'confirmed'));
  out.push(st(CUR, storyIri, sp('autoplay'), lit('false'), 'confirmed'));
  S.WALK.forEach((w, k) => {
    const step = `${STORY}garden-redesign-v029-step-${k + 1}`;
    out.push(st(CUR, step, RDF_TYPE, iri(`${STORY}Step`), 'confirmed'));
    out.push(st(CUR, step, sp('partOf'), iri(storyIri), 'confirmed'));
    out.push(st(CUR, step, sp('order'), lit(String(k + 1), XSD_INT), 'confirmed'));
    out.push(st(CUR, step, sp('title'), lit(w.title), 'confirmed'));
    out.push(st(CUR, step, sp('content'), lit(w.content), 'confirmed'));
    if (w.question) out.push(st(CUR, step, sp('question'), lit(w.question), 'confirmed'));
    if (w.layout) out.push(st(CUR, step, sp('layout'), lit(w.layout), 'confirmed'));
    for (const h of w.highlights) out.push(st(CUR, step, sp('highlight'), iri(C(h)), 'confirmed'));
  });

  const sourceTexts: Record<string, string> = Object.fromEntries([...S.SOURCES, S.LATER_NOTE].map((s) => [s.id, s.text]));
  const mk = async (s: S.StorySource): Promise<Source> => ({ id: s.id, title: s.title, uri: `note://review/${s.id}`, kind: 'document', ingestedAt: at(s.at), trustLevel: 'review', hash: await hashSourceText(s.text) });
  const sources: Source[] = [
    { id: CUR, title: 'Larkspur Lane review story, as written for the v0.2.9 review', uri: 'note://review/story-curated', kind: 'turtle', ingestedAt: AT, trustLevel: 'trusted' },
    ...(await Promise.all([...S.SOURCES, S.LATER_NOTE].map(mk))),
    ...reckonSources,
  ];
  if (splatFile) sources.push({ id: 'scan-job', title: 'Scans attached by the scan job', uri: 'note://review/scan-job', kind: 'document', ingestedAt: AT, trustLevel: 'review' });
  const header = ['Reckons.AI review space for v0.2.9: Larkspur Lane Community Garden (invented).', 'GENERATED by scripts/review-spaces/build-garden-redesign.ts from garden-redesign-story.ts. Do not edit by hand.', 'Everything here is made up: no real garden, street or person. Not an example; never to be committed.'].join('\n');
  const ttl = toTurtleFull(out, sources, { header }).replace(/^# generated .*\n/m, '');
  return { ttl, statements: out, sources, empty, sourceTexts, copies };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────

/** A review space must not land where the repository tracks files. */
export function refuseTracked(workspace: string): void {
  const rel = path.relative(ROOT, workspace);
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && /^(static|content|src|scripts|docs)(\/|$)/.test(rel)) {
    throw new Error(`refusing ${workspace}: a review space is never written under a tracked folder of the repository`);
  }
}

async function main(): Promise<void> {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const flag = (k: string) => process.argv.includes(`--${k}`);
  const workspace = path.resolve(arg('workspace') ?? '');
  if (!arg('workspace')) { console.error('usage: build-garden-redesign.ts --workspace=<private workspace folder> [--queue] [--cad] [--check]'); process.exit(2); }
  refuseTracked(workspace);
  const dir = path.join(workspace, 'kbs', S.SLUG);
  const file = path.join(dir, `${S.SLUG}.ttl`);

  if (flag('queue') && !flag('check')) {
    const { written, existing } = writeRequests(workspace);
    console.log(`generation requests: ${written.length} written, ${existing.length} already there`);
    try {
      const { GenerationRunner } = await import('../content/generation-runner.js');
      const runner = new GenerationRunner(workspace);
      const added = runner.tick();
      runner.close();
      console.log(added ? 'queued in the local job queue (see: npx tsx scripts/agent/queue.ts list)' : 'nothing new to queue');
    } catch (e) { console.error(`NOT queued: ${(e as Error).message}\nA queue worker serving this folder will enqueue the written requests on its next pass.`); }
    for (const r of generationRequests()) console.log(`  ${r.stage.padEnd(6)} gen-${r.stage}-${r.id.slice(0, 8)}  ${r.id}`);
  }
  if (flag('cad') && !flag('check')) {
    const { buildPart, showPart, publishPart, cadAvailable, cadPython } = await import('../content/cad/run.js');
    if (!cadAvailable()) { console.error(`CAD not built: build123d is not available at ${cadPython()}`); }
    else {
      const built = buildPart(S.BRACKET_SPEC);
      const shown = showPart(built.receipt, built.outDir);
      console.log(`bracket published to ${publishPart(shown, built.outDir, path.join(dir, 'assets', 'cad'))}`);
    }
  }

  const r = await buildGarden(workspace);
  const counts = r.statements.reduce<Record<string, number>>((c, x) => ({ ...c, [x.status]: (c[x.status] ?? 0) + 1 }), {});
  const summary = `${r.statements.length} facts (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${r.sources.length} sources`;
  const emptyNote = r.empty.length ? `\nLEFT EMPTY (not made yet, no placeholder): ${r.empty.join(', ')}` : '';
  console.log(`compare outcomes: ${compareOutcomes().map((o) => `${o.fact.s}/${o.fact.p} ${o.kind}`).join('; ')}`);
  if (flag('check')) {
    console.log(`build-garden-redesign --check: story validates; ${summary}${emptyNote}`);
    if (existsSync(file) && readFileSync(file, 'utf8') !== r.ttl) { console.error(`${file} is stale. Re-run without --check.`); process.exit(1); }
    return;
  }
  mkdirSync(path.join(dir, 'sources'), { recursive: true });
  for (const [id, text] of Object.entries(r.sourceTexts)) writeFileSync(path.join(dir, 'sources', `${id}.md`), `${text}\n`);
  for (const c of r.copies) { mkdirSync(path.dirname(c.to), { recursive: true }); copyFileSync(c.from, c.to); }
  writeFileSync(file, r.ttl);
  console.log(`wrote ${file}\n${summary}${emptyNote}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-garden-redesign.ts')) void main();
