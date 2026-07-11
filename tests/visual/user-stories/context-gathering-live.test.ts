/**
 * User Story: Context Gathering with a LIVE LLM (Ollama).
 *
 * Same note → facts → graph flow as context-gathering.test.ts, but the ingest
 * backend is a real local model via Ollama instead of the deterministic mock —
 * so this exercises actual extraction. Gated on Ollama being reachable with the
 * pinned model, so it skips cleanly in CI / when Ollama is down.
 *
 * Backend is selected with the test-only localStorage hooks read by
 * src/lib/storage/db.ts (__reckons_test_backend__ / __reckons_test_ollama_model__).
 * Prefer Ollama; to run everything through the in-browser WASM model instead,
 * set backend to 'wasm' (and allow the model download).
 *
 * Run: npm run test:live
 */
import { test, expect, type Page } from '@playwright/test';
import { clearAllKbs, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';
const OLLAMA = 'http://localhost:11434';
const MODEL = process.env.LIVE_OLLAMA_MODEL || 'llama3.2:3b';

async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    if (!r.ok) return false;
    const j = (await r.json()) as { models?: { name?: string; model?: string }[] };
    return (j.models ?? []).some((m) => m.name === model || m.model === model);
  } catch {
    return false;
  }
}

/** Read the active graph's sources so we can confirm which backend extracted. */
async function extractionBackends(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('kbase');
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('sources', 'readonly');
            const all = tx.objectStore('sources').getAll();
            all.onsuccess = () =>
              resolve((all.result as { extractionBackend?: string }[]).map((s) => s.extractionBackend ?? ''));
            all.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        };
        req.onerror = () => resolve([]);
      })
  );
}

test('gather context from a note — LIVE Ollama extraction', async ({ page }) => {
  test.skip(!(await ollamaHasModel(MODEL)), `Ollama model ${MODEL} not available`);
  test.setTimeout(120_000); // live model inference is slower than the mock

  // Select the live backend before the app boots (re-applied on each navigation,
  // so it survives clearAllKbs wiping localStorage).
  await page.addInitScript(
    ([backend, model]) => {
      localStorage.setItem('__reckons_test_backend__', backend);
      localStorage.setItem('__reckons_test_ollama_model__', model);
    },
    ['ollama', MODEL]
  );

  await clearAllKbs(page);
  await page.goto(`${APP}/ingest`);
  await page.waitForTimeout(1500);

  await test.step('write a note', async () => {
    await page.locator('input[placeholder="what is this about"]').fill('Backyard solar setup');
    await page
      .locator('textarea[placeholder*="write a note"]')
      .fill(
        'Alex is planning a 2 kW rooftop solar array on a south-facing garage roof. ' +
          'The budget is $4,000 and the city requires a permit before installation.'
      );
    await screenshotTo(page, 'context-gathering-live', '01-note');
  });

  await test.step('extract with the live model and land on compare', async () => {
    await page.getByRole('button', { name: /extract facts/i }).click();
    // Isolate live EXTRACTION: decline the (separate) embedding-model download so
    // the semantic dedup step falls back to structural.
    await page
      .getByRole('button', { name: /not now/i })
      .click({ timeout: 20_000 })
      .catch(() => {});
    await page.waitForURL(/\/compare/, { timeout: 90_000 });
    await page.waitForTimeout(2000);
    await screenshotTo(page, 'context-gathering-live', '02-compare-live');
  });

  await test.step('extraction ran through Ollama and produced facts', async () => {
    const backends = await extractionBackends(page);
    expect(backends, `source extraction backends: ${backends.join(',')}`).toContain('ollama');
  });
});
