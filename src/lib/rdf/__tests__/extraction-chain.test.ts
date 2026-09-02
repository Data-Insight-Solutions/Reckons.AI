/**
 * THE CHAIN, COMPOSED — the test that none of the per-stage suites could be.
 *
 * vocabulary-repair, entity-typing, hierarchy, fact-aggregation and review-tree each have their own
 * test file, and every one of them passes on a graph whose review experience is a flat list of
 * nineteen unrelated claims. A defect that lives in the SEAM between two stages is invisible to all
 * of them; both bugs fixed in 4b1e773 lived there.
 *
 * So these assertions are about composition, not correctness-in-isolation: what one stage hands the
 * next, and what falls on the floor between them. Several of them PIN CURRENT BAD BEHAVIOUR on
 * purpose and say so — a test that documents a known gap is how the gap stops being forgotten, and
 * when the gap is fixed the test fails loudly and gets rewritten. They are marked GAP.
 */
import { describe, it, expect } from 'vitest';
import { runChain } from '../../../../scripts/offline/extraction-chain';

const FIXTURE = 'tests/fixtures/extraction-chain.ttl';

describe('extraction chain — composed, on tests/fixtures/extraction-chain.ttl', () => {
  it('reads the graph the app builds, not the file', async () => {
    const r = await runChain(FIXTURE);
    // Plain Turtle with no reification: the importer takes the clean path and every source id is
    // fabricated. The harness must SAY so rather than reporting confident provenance.
    expect(r.read.syntheticSource).toBe(true);
    expect(r.read.statements).toBeGreaterThan(0);
    expect(r.read.entities).toBeGreaterThan(0);
  });

  it('BLOCK 1 — flags a real mis-transcription', async () => {
    const r = await runChain(FIXTURE);
    const pairs = r.vocabulary.suspects.map((s) => [s.heard, s.match].sort().join(' ~ '));
    expect(pairs).toContain('Vantage Suite ~ Vantidge Suite');
  });

  it('BLOCK 2 — never proposes merging two note ids that differ only in digits', async () => {
    const r = await runChain(FIXTURE);
    const noteSuspects = r.vocabulary.suspects.filter(
      (s) => s.heard.startsWith('note-2026') && s.match.startsWith('note-2026'),
    );
    // phoneticKey strips digits, so without a guard all four note ids key alike and score 0.95.
    // Accepting one would merge two captures and destroy the provenance link to the note.
    expect(noteSuspects).toEqual([]);
  });

  it('BLOCK 3 — sentence-shaped entity slugs are reported, not silently skipped', async () => {
    const r = await runChain(FIXTURE);
    expect(r.seams.sentenceEntities).toHaveLength(2);
    expect(r.seams.sentenceEntities.join(' ')).toContain('lumenpath-is-an-enterprise-cad-platform');
  });

  it('BLOCK 5 — the control: a real skos:broader hierarchy IS seen', async () => {
    const r = await runChain(FIXTURE);
    // Without this, "0 placed" on the real notes would be indistinguishable from a harness that
    // cannot read hierarchy at all.
    expect(r.hierarchy.roots).toBeGreaterThan(0);
    expect(r.hierarchy.placed).toBeGreaterThan(0);
    expect(r.hierarchy.maxDepth).toBeGreaterThanOrEqual(2);
  });

  /* ── GAPS: pinned so they cannot be forgotten. Each should FAIL when fixed. ──────────────── */

  it('GAP — BLOCK 4: co-hyponyms are read as duplicates by vocabulary and claimed by no hierarchy', async () => {
    const r = await runChain(FIXTURE);
    const renderPairs = r.vocabulary.suspects.filter(
      (s) => s.heard.startsWith('render setting') && s.match.startsWith('render setting'),
    );
    // THE SEAM, in one assertion. `render setting width/height/quality/...` are five DISTINCT
    // settings that share a prefix. Vocabulary reads that prefix as evidence they are the same
    // thing (wrong); hierarchy would read it as evidence they are siblings under one parent
    // (right) — but nothing infers a parent from a shared prefix, so only the wrong reader runs.
    expect(renderPairs.length).toBeGreaterThan(0);
    expect(r.hierarchy.orphans).toBeGreaterThan(0);
  });

  it('GAP — typing settles nothing on extracted note entities', async () => {
    const r = await runChain(FIXTURE);
    // Matches the real corpus: the deterministic survey proposes a type for none of them, because
    // no built-in type has the predicates a dictated note produces (the F149 rdfs:domain gap).
    expect(r.typing.proposals).toBe(0);
    expect(r.typing.undecided).toBeGreaterThan(0);
  });

  it('GAP — the decision tree is EMPTY: every claim is an orphan', async () => {
    const r = await runChain(FIXTURE);
    // This is the whole problem in one number. Nineteen real claims a person must rule on, and no
    // decision to hang any of them from, so review degrades to a flat list — exactly what the
    // hierarchical review tree exists to prevent.
    expect(r.tree.decisions).toBe(0);
    expect(r.tree.orphanJudgments).toBeGreaterThan(0);
  });
});
