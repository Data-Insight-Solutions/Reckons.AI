import { test, expect } from '@playwright/test';
import { HUMANITY_PDC_EXAMPLE } from '../../src/lib/examples/humanity-pdc';

test('PDC example opens separately, preserves sources and reopens the edited copy', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/about');
  await page.getByRole('navigation').waitFor();
  await page.evaluate(async () => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await imp('/src/lib/storage/db.ts');
    const now = Date.now();
    await db.statements.put({ id: 'keep-my-existing-note', sourceId: 'mine', s: { kind: 'iri', value: 'urn:my:note' },
      p: { kind: 'iri', value: 'urn:my:text' }, o: { kind: 'literal', value: 'Keep my work' },
      g: { kind: 'iri', value: 'urn:my:source' }, status: 'confirmed', confidence: 1, createdAt: now, updatedAt: now });
  });
  await page.getByRole('button', { name: /Humanity AI \+ PDC/ }).click();
  await expect(page).toHaveURL(/\?kb=/);
  const exampleUrl = page.url();
  // Desktop starts in 3D, where labels are camera-dependent. Verify it renders,
  // then use the 2D projection to inspect a particular entity on both devices.
  if (testInfo.project.name === 'desktop-chrome') {
    await expect(page.locator('[data-graph-renderer="3d"][data-graph-ready="true"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('group', { name: 'Graph renderer' }).getByRole('button', { name: '2D', exact: true }).click();
  }
  await expect(page.locator('[data-node-key="i:urn:kbase:concept/philanthropy-data-commons"]').first()).toBeVisible({ timeout: 30_000 });
  const state = await page.evaluate(async () => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { db, KBaseDB } = await imp('/src/lib/storage/db.ts');
    const { getRegistry } = await imp('/src/lib/storage/kb-registry.ts');
    const { extractStories } = await imp('/src/lib/rdf/story.ts');
    const statements = await db.statements.toArray();
    const sources = await db.sources.toArray();
    const original = new KBaseDB('kbase');
    const untouched = await original.statements.get('keep-my-existing-note'); original.close();
    const edited = statements.find((s: any) => s.s.value === 'urn:kbase:concept/pdc-explorer-proposal' && s.p.value.endsWith('/has-status'));
    await db.statements.update(edited.id, { status: 'rejected' });
    return { count: statements.length, sources: sources.length, states: [...new Set(statements.map((s: any) => s.status))],
      untouched: untouched?.o.value, stories: extractStories(statements).length, editedId: edited.id, registrySize: getRegistry().length };
  });
  expect(state).toMatchObject({ count: HUMANITY_PDC_EXAMPLE.triples, sources: 12, states: ['pending'], untouched: 'Keep my work', stories: 1 });
  const startStory = page.getByRole('button', { name: 'Start the story', exact: true });
  // Phone notifications show one card at a time. Dismiss earlier first-run tips.
  for (let i = 0; i < 4 && !(await startStory.isVisible()); i++) {
    await page.getByRole('button', { name: 'dismiss', exact: true }).first().click();
  }
  await startStory.click();
  const headings = ['Start with knowledge you control', 'Learn and research with local AI',
    'Read the opportunity as a graph', 'Describe the grant seeker honestly', 'Bring the two graphs together',
    'Check alignment against evidence', 'Extend the inquiry through PDC',
    'Choose what leaves the personal graph', 'Put community benefit to the test'];
  for (const [index, title] of headings.entries()) {
    if (index > 0) await page.getByRole('button', { name: 'Next step', exact: true }).click();
    await expect(page.getByRole('heading', { name: `${index + 1}. ${title}`, exact: true })).toBeVisible();
    if (index === 5) await page.screenshot({ path: testInfo.outputPath('humanity-pdc-alignment-story.png') });
  }
  await expect(page.getByRole('button', { name: 'Next step', exact: true })).toBeDisabled();
  await page.goto('/about');
  await page.getByRole('button', { name: /Humanity AI \+ PDC/ }).click();
  await expect(page).toHaveURL(exampleUrl);
  await page.getByRole('navigation').waitFor();
  const reopened = await page.evaluate(async (id) => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await imp('/src/lib/storage/db.ts');
    const { getRegistry } = await imp('/src/lib/storage/kb-registry.ts');
    return { status: (await db.statements.get(id))?.status, graphs: getRegistry().length };
  }, state.editedId);
  expect(reopened).toEqual({ status: 'rejected', graphs: state.registrySize });
  expect(errors).toEqual([]);
});
