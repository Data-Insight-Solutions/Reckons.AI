/** F312 done-test, generator half: decisions with SYNTHETIC tiny images become a knowledge base the importer and the accept rules read. */
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildOptionReviewSpace, writeSpaceFolder, type SpaceInput } from '../content/option-review-space';
import { importTurtleFull } from '../../src/lib/rdf/import-ttl';
import { readStoredProposal, acceptOption, optionState, settleIfReached } from '../../src/lib/rdf/reckoning-accept';
import { storedDecisions, writtenOptions } from '../../src/lib/rdf/reckoning-written';
import { parseAssetRefs } from '../../src/lib/storage/kb-assets';

// A 1x1 PNG, written as bytes so no real picture is ever involved.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');

let dir: string;
let input: SpaceInput;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'optrev-'));
  const f = (n: string, b: Buffer) => { const p = path.join(dir, n); writeFileSync(p, b); return p; };
  input = {
    space: 'Synthetic Review',
    decisions: [
      { id: 'svc', question: 'Which picture stands for Service?', subject: 'Service', predicate: 'represented by',
        options: [{ label: 'One', image: f('1.png', PNG) }, { label: 'Two', image: f('2.svg', SVG) }, { label: 'Three', image: f('3.png', PNG) }] },
      { id: 'doc', question: 'Which picture stands for Document?', subject: 'Document', predicate: 'represented by',
        options: [{ label: 'One', image: f('4.png', PNG) }, { label: 'Two', image: f('5.png', PNG) }] },
    ],
  };
});

describe('buildOptionReviewSpace', () => {
  it('is deterministic', () => {
    const a = buildOptionReviewSpace(input, { allow: [dir] });
    const b = buildOptionReviewSpace(input, { allow: [dir] });
    expect(a.ttl).toBe(b.ttl);
    expect([...a.assets.keys()]).toEqual([...b.assets.keys()]);
    expect(a.decisions).toBe(2);
    expect(a.options).toBe(5);
  });

  it('writes one image file per option, referenced by its candidate AND its option node (the node the canvas shows)', () => {
    const built = buildOptionReviewSpace(input, { allow: [dir] });
    const refs = parseAssetRefs(built.ttl);
    expect(refs).toHaveLength(10); // 5 options x (candidate + option node), same 5 files
    expect(new Set(refs.map((r) => r.value)).size).toBe(5);
    expect(refs.filter((r) => /-option-[a-d]$/.test(r.entityIri))).toHaveLength(5); // each option node has its picture
    for (const r of refs) { expect(r.category).toBe('icons'); expect(built.assets.has(r.value)).toBe(true); }
    expect(refs.map((r) => r.value)).toContain('assets/icons/svc-candidate-2.svg');
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'optrev-out-')), 'synthetic-review');
    const w = writeSpaceFolder(out, built);
    expect(w.files).toBe(5);
    expect(existsSync(path.join(out, 'synthetic-review.ttl'))).toBe(true);
    expect(readFileSync(path.join(out, 'assets/icons/svc-candidate-1.png')).equals(PNG)).toBe(true);
  });

  it('reads back through the importer as pending options, and accepting one supersedes the others (the existing rules)', async () => {
    const built = buildOptionReviewSpace(input, { allow: [dir] });
    const { statements } = await importTurtleFull(built.ttl, { name: 'x' });
    const decisions = storedDecisions(statements);
    expect(decisions.map((d) => d.id)).toEqual(['doc', 'svc']);
    const stored = readStoredProposal(statements, 'svc')!;
    expect(stored.proposal.options.map((o) => o.label)).toEqual(['One', 'Two', 'Three']);
    expect(stored.proposal.recommendedId).toBe(stored.proposal.options[0].id);
    const [a, b, c] = stored.proposal.options.map((o) => o.id);
    expect(optionState(statements, 'svc', a)).toBe('proposed');
    const picked = acceptOption(stored.proposal, b, statements, stored.statusRowId);
    expect(picked).toMatchObject({ ok: true });
    if (!picked.ok) return;
    expect(picked.plan.jobs).toHaveLength(0);
    expect(picked.plan.counts).toMatchObject({ statements: 1, otherOptions: 2 });
    const rowsOf = (id: string) => statements.filter((s) => s.proposalOption === id).map((s) => s.id);
    expect(rowsOf(a).every((id) => picked.plan.supersede.includes(id))).toBe(true);
    expect(rowsOf(c).every((id) => picked.plan.supersede.includes(id))).toBe(true);
    // the decision's question is the target: once the chosen option's statement is confirmed, the proposal closes
    const confirmed = statements.map((st) => (picked.plan.confirm.includes(st.id) ? { ...st, status: 'confirmed' as const } : st));
    const active = { ...stored, proposal: picked.plan.proposal };
    expect(settleIfReached(active, statements).closed).toBe(false);
    expect(settleIfReached(active, confirmed).closed).toBe(true);
    // the other decision is untouched
    expect(picked.plan.supersede.some((id) => statements.find((s) => s.id === id)?.proposalOption?.includes('-doc-'))).toBe(false);
    // the option card reads each picture from its candidate's icon
    const icons = new Map(parseAssetRefs(built.ttl).map((r) => [r.entityIri, `data:${r.value}`]));
    const shown = writtenOptions(statements, 'svc', icons);
    expect(shown.map((o) => o.image)).toEqual(['data:assets/icons/svc-candidate-1.png', 'data:assets/icons/svc-candidate-2.svg', 'data:assets/icons/svc-candidate-3.png']);
    expect(shown.every((o) => o.statements === 1)).toBe(true);
    expect(shown[0].rationale).toContain('No preference was made');
    expect(shown[1].rationale).not.toContain('No preference');
  });
});

describe('refusals', () => {
  it('refuses an image outside the allowed folders, including through a symlink', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'optrev-else-'));
    const p = path.join(elsewhere, 'x.png');
    writeFileSync(p, PNG);
    const bad = structuredClone(input);
    bad.decisions[0].options[0].image = p;
    expect(() => buildOptionReviewSpace(bad, { allow: [dir] })).toThrow(/outside the folders/);
    const link = path.join(dir, 'link.png');
    symlinkSync(p, link);
    bad.decisions[0].options[0].image = link;
    expect(() => buildOptionReviewSpace(bad, { allow: [dir] })).toThrow(/outside the folders/);
  });
  it('refuses a relative path, a missing file, a wrong type and content that is not the named type', () => {
    const t = (image: string) => { const x = structuredClone(input); x.decisions[0].options[0].image = image; return () => buildOptionReviewSpace(x, { allow: [dir] }); };
    expect(t('1.png')).toThrow(/not absolute/);
    expect(t(path.join(dir, 'nope.png'))).toThrow(/does not exist/);
    const txt = path.join(dir, 'a.txt'); writeFileSync(txt, 'hi');
    expect(t(txt)).toThrow(/Not an image type/);
    const fake = path.join(dir, 'fake.png'); writeFileSync(fake, 'not a png');
    expect(t(fake)).toThrow(/does not match/);
  });
  it('refuses option counts the proposal cannot hold, duplicate ids and duplicate labels', () => {
    const one = structuredClone(input); one.decisions[0].options = one.decisions[0].options.slice(0, 1);
    expect(() => buildOptionReviewSpace(one, { allow: [dir] })).toThrow(/2 to 4/);
    const dup = structuredClone(input); dup.decisions[1].id = 'svc';
    expect(() => buildOptionReviewSpace(dup, { allow: [dir] })).toThrow(/share the id/);
    const same = structuredClone(input); same.decisions[0].options[1].label = 'One';
    expect(() => buildOptionReviewSpace(same, { allow: [dir] })).toThrow(/labelled/);
    expect(() => buildOptionReviewSpace(input, { allow: [] })).toThrow(/No folder/);
  });
});
