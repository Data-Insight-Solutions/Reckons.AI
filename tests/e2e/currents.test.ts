import { test, expect } from '@playwright/test';

test('opt-in Currents delivers pending facts and preserves dismissal after reload', async ({ page }) => {
  test.setTimeout(60_000);
  const registrations: Array<{ enabled: boolean; graphStableId: string; slug: string }> = [];
  let reads = 0;
  await page.route('http://localhost:5188/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    } else if (url.pathname.endsWith('reckons-currents-register')) {
      registrations.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    } else {
      reads++;
      await route.fulfill({ json: [{
        title: 'Synthetic astronomy update', url: 'https://example.com/astronomy',
        currentSlug: 'test-stream', graphStableId: url.searchParams.get('graphStableId'),
        fetchedAt: '2026-10-12T00:00:00Z',
      }] });
    }
  });

  await page.goto('/kb');
  const currents = page.locator('#currents');
  await currents.getByRole('button', { name: '+ configure', exact: true }).click();
  await currents.getByRole('button', { name: '+ add current', exact: true }).click();
  await currents.locator('.current-label').fill('Test stream');
  await currents.locator('.current-source').fill('https://example.com/feed');
  await currents.getByRole('button', { name: 'save currents', exact: true }).click();
  await expect(currents.getByRole('button', { name: 'save currents', exact: true })).toBeEnabled();

  await page.goto('/settings/integrations');
  const integration = page.locator('#s-n8n');
  await integration.getByRole('textbox').fill('http://localhost:5188');
  await integration.getByRole('button', { name: 'save', exact: true }).click();
  await expect(integration.getByRole('button', { name: 'save', exact: true })).toBeEnabled();
  expect(registrations).toHaveLength(0);
  expect(reads).toBe(0);

  await integration.getByRole('checkbox').check();
  await integration.getByRole('button', { name: 'save', exact: true }).click();
  const arrivalStatuses = () => page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    return (await db.statements.toArray()).filter((st) => st.id.startsWith('arrival|')).map((st) => st.status);
  });
  await expect.poll(arrivalStatuses).toEqual(['pending', 'pending', 'pending']);
  expect(registrations[0]).toMatchObject({ enabled: true, slug: 'test-stream' });

  // Use the same durable review action as the UI, then replay through a real app reload.
  await page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { statements, setStatuses } = await runtimeImport('/src/lib/stores/kb.svelte.ts') as typeof import('../../src/lib/stores/kb.svelte');
    await setStatuses(statements().filter((st) => st.id.startsWith('arrival|')).map((st) => ({ id: st.id, status: 'rejected' as const })));
  });
  const beforeReload = reads;
  await page.reload();
  await expect.poll(() => reads).toBeGreaterThan(beforeReload);
  await expect.poll(arrivalStatuses).toEqual(['rejected', 'rejected', 'rejected']);
  await expect(integration.getByRole('checkbox')).toBeChecked();

  await page.goto('/kb');
  await currents.getByRole('button', { name: 'edit (1)', exact: true }).click();
  await currents.getByRole('button', { name: 'remove', exact: true }).click();
  await currents.getByRole('button', { name: 'save currents', exact: true }).click();
  await expect.poll(() => registrations.at(-1)?.enabled).toBe(false);
});
