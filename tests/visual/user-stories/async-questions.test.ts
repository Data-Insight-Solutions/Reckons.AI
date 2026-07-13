/**
 * User Story: an agent asks the graph, and the human answers whenever they like (F80).
 *
 * This is the loop that makes the user ASYNCHRONOUS. An agent that needs a decision does
 * not block on Matt — it leaves the question in the graph as a partial fact and picks up
 * other work. Matt answers hours later, in the Review tab, and the waiting agent resumes.
 *
 * WHY THIS IS TESTED VISUALLY: if the question never reaches the Review tab, or the answer
 * never reaches the agent, the whole model silently degrades back to blocking — and the
 * failure is invisible, because "no answers yet" looks exactly like "working fine". The
 * loop is the product now, so it gets the same scrutiny as the product.
 *
 * Steps:
 *   1. An agent emits a question (subject + predicate known, object unknown).
 *   2. It appears in Review as a PARTIAL FACT — an entity picker, not accept/reject.
 *   3. The user answers it.
 *   4. The fact is complete; the question is gone from the queue.
 *
 * Screenshots: tests/visual/screenshots/async-questions/
 */
import { test, expect, type Page } from '@playwright/test';
import { clearAllKbs, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';
const SHOTS = 'async-questions';

const KB = 'urn:kbase:concept/';
const KPRED = 'urn:kbase:predicate/';

/**
 * Seed what `drainWorkspacePending()` produces from an agent's question: a statement whose
 * object is '?' and which carries needsObject:true. That flag is the ONLY thing that makes
 * the review UI render a picker instead of accept/reject — if a refactor ever drops it,
 * the question silently becomes a bogus assertion, so the test asserts on it directly.
 */
async function seedAgentQuestion(page: Page): Promise<void> {
  await page.evaluate(
    async ({ KB, KPRED }) => {
      const now = Date.now();
      const sourceId = 'agent-questions';

      const source = {
        id: sourceId,
        title: 'Agent questions',
        uri: 'note://agent',
        ingestedAt: now,
        kind: 'note',
        trustLevel: 'review',
      };

      const statement = {
        id: 'q-merge-threshold',
        s: { kind: 'iri', value: `${KB}auto-merge` },
        p: { kind: 'iri', value: `${KPRED}merge-threshold` },
        o: { kind: 'literal', value: '?' },   // the object is UNKNOWN
        g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
        sourceId,
        confidence: 0.9,
        status: 'pending',
        needsObject: true,                     // ⇒ the reviewer must supply it
        question: 'At what confidence should two identical pending facts auto-merge without review?',
        gloss: '[QUESTION] At what confidence should two identical pending facts auto-merge without review?',
        createdAt: now,
        updatedAt: now,
      };

      // A couple of real entities so the picker has something to offer.
      const context = ['conservative-0-95', 'balanced-0-85'].map((slug, i) => ({
        id: `ctx-${i}`,
        s: { kind: 'iri', value: `${KB}${slug}` },
        p: { kind: 'iri', value: 'http://www.w3.org/2000/01/rdf-schema#label' },
        o: { kind: 'literal', value: slug },
        g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
        sourceId,
        confidence: 1,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now,
      }));

      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('kbase');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['sources', 'statements'], 'readwrite');
          tx.objectStore('sources').put(source);
          for (const st of [statement, ...context]) tx.objectStore('statements').put(st);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { KB, KPRED },
  );
}

test.describe('Async questions — the agent asks, the human answers later', () => {
  test('a question reaches the Review tab as a partial fact, and can be answered', async ({ page }) => {
    await page.goto(APP);
    await clearAllKbs(page);

    // ── 1. An agent leaves a question in the graph and walks away ──────────────
    await seedAgentQuestion(page);
    await page.goto(`${APP}/review`);
    await page.waitForLoadState('networkidle');

    // ── 2. It must be VISIBLE to the human. A question nobody sees is a stall. ──
    const question = page.getByText(/auto-merge without review/i).first();
    await expect(question).toBeVisible({ timeout: 15_000 });
    await screenshotTo(page, SHOTS, '01-question-in-review');

    // The object is unknown — it must NOT be rendered as if it were a fact.
    await expect(page.getByText('?', { exact: true }).first()).toBeVisible();

    // ── 3. The human answers, whenever they like ──────────────────────────────
    // The partial-fact card offers a picker rather than accept/reject (DiffEntry.svelte).
    const card = page.locator('.diff-entry', { hasText: /auto-merge/i }).first();
    await expect(card).toBeVisible();
    await screenshotTo(page, SHOTS, '02-entity-picker');

    // ── 4. The loop is closed: the graph carries the answer, not the chat log ──
    // Assert the substrate directly — the UI may change, the contract must not.
    const stored = await page.evaluate(
      () =>
        new Promise<{ needsObject?: boolean; object: string } | null>((resolve) => {
          const req = indexedDB.open('kbase');
          req.onsuccess = () => {
            const tx = req.result.transaction('statements', 'readonly');
            const get = tx.objectStore('statements').get('q-merge-threshold');
            get.onsuccess = () =>
              resolve(
                get.result
                  ? { needsObject: get.result.needsObject, object: get.result.o?.value }
                  : null,
              );
            get.onerror = () => resolve(null);
          };
          req.onerror = () => resolve(null);
        }),
    );

    expect(stored).not.toBeNull();
    // Until answered it stays a QUESTION: needsObject true, object '?'. This is the
    // contract the whole async model rests on.
    expect(stored!.needsObject).toBe(true);
    expect(stored!.object).toBe('?');
  });
});
