# Session handoff — read this first if you are picking up mid-stream

**Last updated: 2026-07-12, pre-announcement week.**

If you are a fresh session (local or cloud) and Matt says "continue", this is where you
continue from. Do not re-derive it; do not re-audit what is already audited.

## Do this now

1. `git fetch && git checkout fix/production-claim-evidence` (open as **PR #100** → `dev`)
2. `npx tsx scripts/offline/status-evidence.ts` — lists the shipped-but-untested features
3. Work down that list. Details below.

## The one rule everything else hangs off: `kb:honest-status`

Never describe a control, feature, or capability that does not exist. Distinguish BUILT
from INTENDED **at the point of each claim**, not in a footnote. Report failures as loudly
as successes.

This session has already caught **three overclaims and three production bugs**, and it
found every one of them by writing the first test for something marked `production`.
Finding another is a win, not a setback. Assume more are there.

## Current task: convert declared risk into real coverage

`scripts/offline/status-evidence.ts` enforces: **a shipped feature must either LINK a test
(`kpred:tested-by`) or DECLARE it has none (`kpred:test-coverage "none"`).** You may ship
untested code; you may not do it *silently*.

Status: **49 tested · 16 declared-untested · 0 undeclared.**

Work down the 17. For each: read the code, write REAL tests, fix any bug the tests expose,
link the test, remove the `test-coverage "none"` declaration.

Remaining (roughly hardest-consequence first):

- **Predicate Manager**, **History Mode**, **Comparison View**, **Model Cache Management**
- **n8n Cloud Sync**, **Whisper STT**, **Kokoro TTS**, **Voice Interface**, **Asset viewer**
- **Partial Facts**, **Offline Alignment-Review**, **Session tokens**, **Git Analysis**

### Two rules that are not negotiable

1. **Verify a test actually exercises the feature before linking it.** A `kpred:tested-by`
   link to a test that does not cover the feature is **manufactured evidence** — strictly
   worse than an honest gap. Never link on a filename match.
2. **When a test falsifies a claim, correct the CLAIM — never weaken the test.** This has
   already happened twice (see below).

If you genuinely cannot test something, leave `kpred:test-coverage "none"` in place. A
declared gap is fine. A fake test is not.

## What this session already found (do not re-litigate)

| Feature | What the first test found |
|---|---|
| `kb_compress` | The headline "60–70% token reduction" claim was **false** — measured ~18% vs realistic grouped Turtle. The figure conflated the *encoding* with *subgraph selection*, which is where the real saving lives. Also: `stats.facts` counted facts from entities the budget had dropped. |
| Trust System | **Confirming a fact made its source LESS trusted.** `getTrustScore` discarded the baseline the moment any event existed (0.8 → 0.05 on first confirm). |
| Publish gate (F66) | Markdown pages were built from **unfiltered** statements, and blocked content was **silently dropped** rather than refused. |
| Passage Grounding | **Citations were never verified.** The prompt says "copy it exactly — do not paraphrase"; nothing ever checked that it had. `triplesToStatements` did not even *receive* the source text, so it structurally could not. A fabricated quote was rendered to the user as provenance. Now verified at ingest; a forged excerpt is DROPPED, not displayed. |
| `SAFETY.md` | Claimed a publish gate that did not exist, and that the ethics preamble "cannot be overridden" (it is open-source client code). |

Pattern: the bugs survived because the logic was **tangled with I/O and therefore
untestable**. Extracting pure logic (`mcp-server/src/compress.ts`, `src/lib/storage/trust.ts`)
is not cleanup — it is what makes the bug findable. Keep doing that.

## Work tiering (F74.3) — route before you do

1. **Script** — the answer is checkable by a rule → deterministic code, zero tokens.
2. **Local agent** — judgment over language, output is a gated proposal → Ollama, inside a
   harness, writes only to `knowledge.pending.jsonl`. **Not available in the cloud env.**
3. **Claude Code** — cross-file reasoning, decides process, writes code that lands.

Offloading is **not free**: a noisy local job moves cost from generation to *triage*.
Prefer growing the script tier.

## Hard constraints

- **Never merge. Never target `main`.** Matt merges. `main` deploys to production.
- PRs target **`dev`**. Verify with `gh pr view <n> --json baseRefName` before anything.
- Everything must pass before commit:
  ```
  npx vitest run
  cd mcp-server && npm test && npm run build
  npx tsx scripts/offline/graph-lint.ts        # 0 errors
  npx tsx scripts/offline/status-evidence.ts   # 0 UNDECLARED
  npx tsx scripts/offline/safety-attestation.ts # 6/6
  npx tsx scripts/md-align.ts                  # aligned
  ```

## Open, needs Matt (do not decide unilaterally)

- **F76 bring-your-own-host** — the other half of Option C ("export and self-host" is only
  fair if self-hosting is easy). Open question: OAuth-pushing on the user's behalf makes us
  a *mediated distribution* path and drags the F66 gate into what should be pure export.
- **`kpred:feature-id`** — the IRI is already the identifier; this second key has collided
  three times (F22/F26/F27). Recommend deleting the predicate.
- **Counsel:** does 18 U.S.C. § 2258A attach to a tool that hosts nothing? The one question
  Option C does not dispose of. See `COUNSEL-BRIEF.md`.
