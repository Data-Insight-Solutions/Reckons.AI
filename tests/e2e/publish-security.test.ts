import { test, expect } from '@playwright/test';
import { generateStaticSite } from '../../src/lib/publish/site-generator';
import type { Statement } from '../../src/lib/rdf/types';

function statement(predicate: string, value: string, iri = false): Statement {
  return { id: predicate, s: { kind: 'iri', value: 'urn:example:home' }, p: { kind: 'iri', value: predicate },
    o: { kind: iri ? 'iri' : 'literal', value }, g: { kind: 'iri', value: 'urn:example:graph' },
    sourceId: 'fixture', status: 'confirmed', confidence: 1, createdAt: 0, updatedAt: 0 };
}

test('published HTML strips active content and its CSP blocks subsequently inserted scripts', async ({ page }) => {
  const body = `# Safe heading\n\n**Readable text**\n\n<script>window.compromised=1</script>
<img src="/broken.png" onerror="window.compromised=2">
<img src="https://tracker.example/pixel"><svg onload="window.compromised=3"></svg>
<a href="javascript:window.compromised=4">unsafe link</a>
<iframe srcdoc="<script>parent.compromised=5</script>"></iframe>
<style>body{background:url(https://tracker.example/style)}</style>
<meta http-equiv="refresh" content="0;url=https://tracker.example/redirect">
<base href="https://tracker.example/">`;
  const { files } = generateStaticSite([
    statement('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:kbase:type/WebPage', true),
    statement('http://www.w3.org/2000/01/rdf-schema#label', '<img onerror="bad">'),
    statement('urn:reckons:page/status', 'published'), statement('urn:reckons:page/slug', 'home'),
    statement('urn:reckons:page/body', body),
  ]);
  const external: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://published.example') { external.push(url.href); await route.abort(); return; }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    await route.fulfill({ status: files[file] ? 200 : 404, contentType: file.endsWith('.css') ? 'text/css' : 'text/html', body: files[file] ?? 'Missing' });
  });
  await page.goto('https://published.example/');
  await expect(page.getByRole('heading', { name: 'Safe heading' })).toBeVisible();
  await expect(page.locator('strong')).toHaveText('Readable text');
  await expect(page.locator('script, iframe, svg, base, [onerror], a[href^="javascript:"]')).toHaveCount(0);
  const state = await page.evaluate(async () => {
    const script = document.createElement('script');
    script.textContent = 'window.compromised=6';
    document.body.append(script);
    await new Promise(resolve => setTimeout(resolve, 50));
    return { compromised: (window as any).compromised ?? null, href: location.href };
  });
  expect(state).toEqual({ compromised: null, href: 'https://published.example/' });
  expect(external).toEqual([]);
});
