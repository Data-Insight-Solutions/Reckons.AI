/**
 * Browser-extension workflow: research-session context gathering.
 *
 * The extension gathers context while you browse — its side panel has a Compare
 * tab (analyze THIS page against your graph), a Session tab (aggregate findings
 * across many pages into a research session), and an Ingest tab (push findings
 * into the graph). This walks those three surfaces against a real page,
 * deterministically and offline (no API keys — analysis itself needs an LLM and
 * is out of scope here; this exercises the gathering UI + navigation).
 *
 * Screenshots: tests/visual/screenshots/extension/
 */
import { test, expect, OUT_DIR } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';

test.beforeAll(() => fs.mkdirSync(OUT_DIR, { recursive: true }));

test('research session: Compare → Session → Ingest surfaces', async ({ context, extensionId }) => {
  // A real page provides the browsing context a research session gathers from.
  const web = await context.newPage();
  await web.goto('https://example.com/');
  await web.waitForTimeout(500);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForTimeout(1500);

  await test.step('Compare tab — gather context from a page', async () => {
    // The tab bar (Compare/Session/Live/Ingest) is the panel's spine.
    await expect(panel.locator('.tab-bar')).toBeVisible();
    await expect(panel.locator('.tab-btn[data-view="compare"]')).toBeVisible();
    await panel.screenshot({ path: path.join(OUT_DIR, 'session-01-compare.png') });
  });

  await test.step('Session tab — the research aggregation view', async () => {
    await panel.locator('.tab-btn[data-view="session"]').click();
    await panel.waitForTimeout(500);
    // With no analyses yet, the session view invites the user to start.
    await expect(panel.locator('.session-empty-title')).toBeVisible();
    await panel.screenshot({ path: path.join(OUT_DIR, 'session-02-session.png') });
  });

  await test.step('Ingest tab — push gathered context to the graph', async () => {
    await panel.locator('.tab-btn[data-view="ingest"]').click();
    await panel.waitForTimeout(500);
    await panel.screenshot({ path: path.join(OUT_DIR, 'session-03-ingest.png') });
    // The panel didn't crash switching views — content is present.
    expect((await panel.locator('#root').innerText()).trim().length).toBeGreaterThan(0);
  });
});
