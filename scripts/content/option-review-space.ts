/**
 * F312 — turn a list of image decisions into a knowledge base a person reviews INSIDE Reckons.AI.
 *
 * Matt, 2026-11-26: "instead of review.html can you just give me a space? ... a way to choose 1 of several options
 * within the space ... Lets get review working for image options, instead of an html."
 *
 * Input JSON: { space, decisions: [{ id, question, subject, predicate, options: [{ label, image }] }] }
 *   image = absolute path to a PNG, JPEG, WebP, GIF or SVG.
 * Output (--out DIR): DIR/<basename>.ttl and DIR/assets/icons/<candidate>.<ext>, the workspace folder layout
 * (storage/kb-assets.ts), loaded like any other knowledge-base folder.
 *
 * Each decision is ONE Reckoning with ONE stored proposal (rdf/reckoning-proposal.ts buildProposalRows): each image is an
 * option. Its candidate entity ("<subject>: <label>") carries the image as its kasset:icon, so the picture sits on its
 * node, and the option proposes ONE pending statement: <subject> <predicate> <candidate>; the decision's question is the open fact <subject> <predicate> ?, which is the Reckoning's target, so accepting an option closes the proposal. Accepting an option is the
 * existing OptionDecision (rdf/reckoning-accept.ts): it confirms that statement and supersedes the others. Nothing
 * here decides anything; every statement is written pending.
 *
 * Deterministic (fixed time, no random ids, the exporter's clock line replaced). Refuses an image outside the folders
 * it was told it may read, and any option count the proposal model cannot hold (2 to 4).
 *
 *   npx tsx scripts/content/option-review-space.ts --in decisions.json --out DIR [--allow DIR ...]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Statement, Source } from '../../src/lib/rdf/types';
import { reckoningStatements, reckoningSource } from '../../src/lib/rdf/reckoning-entity';
import { buildProposalRows, slugOf, type ParsedProposal } from '../../src/lib/rdf/reckoning-proposal';
import { toTurtleFull } from '../../src/lib/rdf/serialize';
import { ASSET_ICON } from '../../src/lib/storage/kb-assets';

export type DecisionOption = { label: string; image: string };
/** `recommended` (a 1-based option number) is the proposer's own pick; omit it when there is none (see NO_PREFERENCE). */
export type Decision = { id: string; question: string; subject: string; predicate: string; options: DecisionOption[]; recommended?: number };
export type SpaceInput = { space: string; decisions: Decision[] };

const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const AT = Date.parse('2026-11-26T00:00:00Z');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const KEYS = 'abcd';
/**
 * A proposal must name one option as recommended before it can be accepted (proposal.ts isWellFormed). A decision with
 * no preference still records the first, and its rationale says so, because the card shows "(recommended)" beside it.
 */
const NO_PREFERENCE = ' No preference was made: it is recorded as recommended only because a proposal must name one.';

export type BuiltSpace = { name: string; ttl: string; assets: Map<string, Uint8Array>; decisions: number; options: number };

function fail(msg: string): never { throw new Error(msg); }

/** The real path of `file`, which must sit inside one of `roots` (symlinks resolved, so a link cannot escape). */
function insideRoots(file: string, roots: readonly string[]): string {
  if (!path.isAbsolute(file)) fail(`Image path is not absolute: ${file}`);
  if (!existsSync(file)) fail(`Image does not exist: ${file}`);
  const real = realpathSync(file);
  const ok = roots.some((r) => { const root = realpathSync(r); return real === root || real.startsWith(root + path.sep); });
  if (!ok) fail(`Image is outside the folders this run may read: ${file}`);
  return real;
}

function checkImage(real: string, bytes: Uint8Array): string {
  const ext = path.extname(real).toLowerCase();
  if (!IMAGE_EXT.has(ext)) fail(`Not an image type (${[...IMAGE_EXT].join(' ')}): ${real}`);
  const head = Buffer.from(bytes.subarray(0, 64)).toString('latin1');
  const ok = ext === '.png' ? head.startsWith('\x89PNG')
    : ext === '.svg' ? /<svg|<\?xml/.test(head)
    : ext === '.gif' ? head.startsWith('GIF8')
    : ext === '.webp' ? head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'
    : head.startsWith('\xff\xd8');
  if (!ok) fail(`File content does not match its ${ext} name: ${real}`);
  return ext;
}

const stableIdOf = (name: string) => {
  const h = createHash('sha1').update(`option-review-space:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function buildOptionReviewSpace(input: SpaceInput, opts: { allow: readonly string[] }): BuiltSpace {
  if (!input || typeof input.space !== 'string' || !input.space.trim()) fail('The input needs a "space" name.');
  if (!Array.isArray(input.decisions) || input.decisions.length === 0) fail('The input needs at least one decision.');
  if (opts.allow.length === 0) fail('No folder is allowed: pass --allow.');
  const name = input.space.trim();
  const spaceSource = `option-review-${slugOf(name)}`;
  const g = (id: string) => ({ kind: 'iri' as const, value: `urn:kbase:source/${id}` });
  const row = (id: string, s: string, p: string, o: string, sourceId: string): Statement => ({
    id, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: o },
    g: g(sourceId), sourceId, status: 'confirmed', confidence: 1, createdAt: AT, updatedAt: AT,
  });

  const sources: Source[] = [{ id: spaceSource, title: `${name}: options to review`, uri: `note://option-review/${slugOf(name)}`, kind: 'note', ingestedAt: AT }];
  const all: Statement[] = [];
  const out: Statement[] = [];
  const assets = new Map<string, Uint8Array>();
  const assetLines: string[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  const subjects = new Map<string, string>();
  let optionCount = 0;

  for (const d of input.decisions) {
    const rid = slugOf(String(d?.id ?? ''));
    if (!rid) fail('A decision has no id with letters or digits.');
    if (ids.has(rid)) fail(`Two decisions share the id "${rid}".`);
    ids.add(rid);
    for (const k of ['question', 'subject', 'predicate'] as const) if (typeof d[k] !== 'string' || !d[k].trim()) fail(`Decision "${rid}" needs a "${k}".`);
    if (!Array.isArray(d.options) || d.options.length < 2 || d.options.length > KEYS.length) fail(`Decision "${rid}" needs 2 to ${KEYS.length} options, has ${d.options?.length ?? 0}.`);

    // The entity the decision is about: one per distinct subject name.
    let subjectIri = subjects.get(d.subject.toLowerCase());
    if (!subjectIri) {
      subjectIri = `urn:kbase:concept/${slugOf(d.subject)}`;
      if ([...subjects.values()].includes(subjectIri)) fail(`Subject "${d.subject}" collides with another by name.`);
      subjects.set(d.subject.toLowerCase(), subjectIri);
      const r = row(`${spaceSource}-subject-${slugOf(d.subject)}`, subjectIri, LABEL, d.subject.trim(), spaceSource);
      all.push(r); out.push(r);
    }

    const pick = d.recommended === undefined ? 1 : d.recommended;
    if (!Number.isInteger(pick) || pick < 1 || pick > d.options.length) fail(`Decision "${rid}": recommended must be an option number from 1 to ${d.options.length}.`);
    const proposal: ParsedProposal = { options: [], recommendedKey: KEYS[pick - 1] };
    // The open question the decision answers: its answer is the accepted option's statement (the target of the Reckoning).
    const questionId = `${spaceSource}-question-${rid}`;
    const questionRow: Statement = {
      id: questionId, s: { kind: 'iri', value: subjectIri }, p: { kind: 'iri', value: `urn:kbase:predicate/${slugOf(d.predicate)}` },
      o: { kind: 'literal', value: '?' }, g: g(spaceSource), sourceId: spaceSource, status: 'pending', confidence: 0.5,
      createdAt: AT, updatedAt: AT, needsObject: true, question: d.question.trim(), gloss: d.question.trim(),
    };
    out.push(questionRow);
    d.options.forEach((o, i) => {
      if (typeof o?.label !== 'string' || !o.label.trim()) fail(`Decision "${rid}" option ${i + 1} needs a label.`);
      const real = insideRoots(o.image, opts.allow);
      const bytes = new Uint8Array(readFileSync(real));
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) fail(`Image is empty or over ${MAX_IMAGE_BYTES} bytes: ${real}`);
      const ext = checkImage(real, bytes);

      const candidateLabel = `${d.subject.trim()}: ${o.label.trim()}`;
      if (labels.has(candidateLabel.toLowerCase())) fail(`Two options are labelled "${candidateLabel}"; make the labels differ.`);
      labels.add(candidateLabel.toLowerCase());
      const candidate = `urn:kbase:concept/${rid}-candidate-${i + 1}`;
      const r = row(`${spaceSource}-candidate-${rid}-${i + 1}`, candidate, LABEL, candidateLabel, spaceSource);
      all.push(r); out.push(r);
      const file = `${rid}-candidate-${i + 1}${ext}`;
      assets.set(`assets/icons/${file}`, bytes);
      assetLines.push(`<${candidate}> <${ASSET_ICON}> "assets/icons/${file}" .`);

      proposal.options.push({
        key: KEYS[i], label: o.label.trim(),
        rationale: `Candidate ${i + 1} of ${d.options.length} for: ${d.question.trim()}`.slice(0, 200) + (d.recommended === undefined && i === 0 ? NO_PREFERENCE : ''),
        statements: [{ s: d.subject.trim(), p: d.predicate.trim(), o: candidateLabel }],
        jobs: [], missingInputs: [], citations: [],
      });
      optionCount++;
    });

    sources.push(reckoningSource(rid, d.question, AT));
    out.push(...reckoningStatements(rid, [], d.question, AT, { statementId: questionId, assetType: null, note: '' }));
    const built = buildProposalRows(proposal, { reckoning: { id: rid, target: { statementId: questionId, assetType: null, note: '' } }, at: AT, all });
    if (built.blocked.length > 0) fail(`Decision "${rid}" was refused by the content filter: ${built.blocked.map((b) => `${b.what}: ${b.reasons.join(', ')}`).join('; ')}`);
    out.push(...built.rows);
  }

  const ttl = toTurtleFull(out, sources, { kbStableId: stableIdOf(name), header: `${name}: options to review (generated by scripts/content/option-review-space.ts). Every option is a pending statement; Accept in the app decides.` })
    .replace(/^# generated .*$/m, '# generated deterministically')
    + '\n# Asset references\n# 2D node icons (the candidate image of each option)\n' + assetLines.join('\n') + '\n';
  return { name, ttl, assets, decisions: input.decisions.length, options: optionCount };
}

/** Write the workspace folder: DIR/<basename>.ttl and DIR/assets/icons/*. */
export function writeSpaceFolder(out: string, built: BuiltSpace): { ttlPath: string; files: number } {
  mkdirSync(path.join(out, 'assets', 'icons'), { recursive: true });
  const ttlPath = path.join(out, `${path.basename(path.resolve(out))}.ttl`);
  writeFileSync(ttlPath, built.ttl);
  for (const [rel, bytes] of built.assets) writeFileSync(path.join(out, rel), bytes);
  return { ttlPath, files: built.assets.size };
}

function main(argv: string[]) {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const inFile = arg('--in');
  const out = arg('--out');
  if (!inFile || !out) { console.error('usage: option-review-space.ts --in decisions.json --out DIR [--allow DIR ...]'); process.exit(2); }
  const allow = argv.flatMap((a, i) => (a === '--allow' && argv[i + 1] ? [path.resolve(argv[i + 1])] : []));
  const roots = allow.length > 0 ? allow : [path.dirname(path.resolve(inFile))];
  if (!statSync(inFile).isFile()) fail(`Not a file: ${inFile}`);
  const built = buildOptionReviewSpace(JSON.parse(readFileSync(inFile, 'utf8')), { allow: roots });
  const w = writeSpaceFolder(path.resolve(out), built);
  console.log(`${built.decisions} decisions, ${built.options} options, ${w.files} images -> ${w.ttlPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
