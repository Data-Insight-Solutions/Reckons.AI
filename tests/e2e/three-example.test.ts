import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

// attach() re-serves three-example.html through page.route to add production's X-Frame-Options.
// Chrome treats a fulfilled document as public address space, so Local Network Access then blocks
// the sandboxed frame's own /three-example.js from 127.0.0.1. Production serves both from one
// public host; only this loopback test needs the check off.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const example = 'https://threejs.org/examples/webgl_reckons_fixture.html';
// Purpose-built synthetic example. CI never depends on upstream demo changes or network access.
const scene = `
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const gl = canvas.getContext('webgl2');
  const shader = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s,text); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, '#version 300 es\\nvoid main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}'));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision mediump float;out vec4 c;void main(){c=vec4(0,1,0,1);}'));
  gl.linkProgram(p); gl.useProgram(p); gl.drawArrays(gl.TRIANGLES,0,3);
  try { parent.document.body; document.body.dataset.parentAccess='yes'; } catch { document.body.dataset.parentAccess='blocked'; }
  try { localStorage.setItem('escape','yes'); document.body.dataset.storageAccess='yes'; } catch { document.body.dataset.storageAccess='blocked'; }
`;
async function stub(page: Page, script = scene, status = 200) {
  await page.route('https://threejs.org/**', route => route.fulfill({
    status, headers: { 'access-control-allow-origin': '*' }, contentType:'text/html',
    body:`<!doctype html><html><head><title>Synthetic example</title></head><body><script type="module">${script}</script></body></html>`,
  }));
}
async function attach(page: Page) {
  // Production serves static files with SAMEORIGIN. Verify that header together with the
  // opaque-origin sandbox, rather than testing only Vite's more permissive response.
  await page.route('**/three-example.html?**', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'x-frame-options': 'SAMEORIGIN' } });
  });
  await clearStorage(page); await waitForApp(page);
  await page.goto('/about');
  await page.locator('.starter-card', { hasText: /generated assets/i }).click();
  await page.waitForURL(url => url.pathname === '/');
  await expect(page.locator('main canvas').first()).toBeVisible();
  const collapse = page.getByRole('button', { name: 'Collapse notifications', exact:true });
  if (await collapse.isVisible()) await collapse.click();
  await page.getByPlaceholder('search nodes or facts…').fill('gen-carved-turtle-image');
  await page.locator('.sb-node-row').filter({has: page.locator('.sb-node-iri')}).filter({hasText:'gen-carved-turtle-image'}).first().click();
  await page.getByRole('button',{name:'Attach Three.js example',exact:true}).click();
  await page.getByLabel('Example URL', {exact:true}).fill(example);
  await page.getByRole('button',{name:'Attach example',exact:true}).click();
  await page.getByRole('button',{name:'Open example viewer',exact:true}).click();
  await expect(page.getByRole('button',{name:'Load example',exact:true})).toBeVisible();
}

test('node attachments are inert until loaded, isolated, stoppable, and removable', async ({page}) => {
  let requests = 0;
  page.on('request', r => { if (r.url().startsWith('https://threejs.org/')) requests++; });
  await stub(page); await attach(page);
  expect(requests).toBe(0);
  await expect(page.locator('.three-example-viewer iframe')).toHaveCount(0);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.getByText('Example running',{exact:true})).toBeVisible();
  const frame = page.frameLocator('iframe[title="Interactive Three.js example"]');
  await expect(frame.locator('body')).toHaveAttribute('data-parent-access','blocked');
  await expect(frame.locator('body')).toHaveAttribute('data-storage-access','blocked');
  await expect(page.locator('.three-example-viewer iframe')).toHaveAttribute('sandbox','allow-scripts');
  if (process.env.STORY_CAPTURE_DIR) await page.screenshot({path:`${process.env.STORY_CAPTURE_DIR}/${test.info().project.name}-three.png`});
  await page.getByRole('button',{name:'Stop example',exact:true}).click();
  await expect(page.locator('.three-example-viewer iframe')).toHaveCount(0);
  await expect(page.getByText('Example stopped and unloaded.')).toBeVisible();
  const fullscreenClose = page.locator('.asset-fs-close');
  if (await fullscreenClose.isVisible()) {
    await fullscreenClose.click();
  } else await page.locator('.asset-large .asset-controls button[title="Close"]').click();
  await page.getByRole('button',{name:'Remove example',exact:true}).click();
  await expect(page.getByRole('button',{name:'Attach Three.js example',exact:true})).toBeVisible();
});

test('fetch and runtime errors unload the example; retry and context loss are handled', async ({page}) => {
  await stub(page, '', 404); await attach(page);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.locator('.three-example-viewer [role="alert"]')).toContainText('HTTP 404');
  await expect(page.locator('.three-example-viewer iframe')).toHaveCount(0);
  await stub(page, "throw new Error('Synthetic incompatible example')");
  await page.getByRole('button',{name:'Retry example',exact:true}).click();
  await expect(page.locator('.three-example-viewer [role="alert"]')).toContainText('Synthetic incompatible example');
  await stub(page);
  await page.getByRole('button',{name:'Retry example',exact:true}).click();
  await expect(page.getByText('Example running',{exact:true})).toBeVisible();
  await page.frameLocator('iframe[title="Interactive Three.js example"]').locator('canvas').evaluate(canvas => {
    (canvas as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(page.locator('.three-example-viewer [role="alert"]')).toContainText('graphics context was lost');
  await expect(page.locator('.three-example-viewer iframe')).toHaveCount(0);
});

test('a loaded document without a rendered scene times out and ignores forged messages', async ({page}) => {
  await page.clock.install();
  await stub(page, 'document.body.textContent="No rendered scene";'); await attach(page);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.frameLocator('iframe[title="Interactive Three.js example"]').locator('body')).toContainText('No rendered scene');
  await page.evaluate(() => {
    const frame = document.querySelector('.three-example-viewer iframe') as HTMLIFrameElement;
    window.postMessage({channel:'reckons-three-example',token:new URL(frame.src).searchParams.get('token'),type:'rendered'}, '*');
  });
  await expect(page.getByText('Loading example…',{exact:true})).toBeVisible();
  await page.clock.fastForward(46_000);
  await expect(page.locator('.three-example-viewer [role="alert"]')).toContainText('did not render within 45 seconds');
  await expect(page.locator('.three-example-viewer iframe')).toHaveCount(0);
});

test('missing graphics support fails before downloading the example', async ({page}) => {
  await page.addInitScript(() => {
    if (location.pathname !== '/three-example.html') return;
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  let downloaded = false;
  page.on('request', r => { if (r.url() === example) downloaded = true; });
  await stub(page); await attach(page);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.locator('.three-example-viewer [role="alert"]')).toContainText('cannot provide the graphics API');
  expect(downloaded).toBe(false);
});

test('a missing heartbeat unloads a previously rendered example', async ({page}) => {
  await page.clock.install();
  await stub(page); await attach(page);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.getByText('Example running',{exact:true})).toBeVisible();
  await page.frameLocator('iframe[title="Interactive Three.js example"]').locator('body').evaluate(() => {
    // Stop this isolated document's existing timers. Virtual clocks use large timer IDs;
    // get the current sequence rather than assuming it starts at 1.
    const last = window.setInterval(() => {}, 60_000);
    for (let id = last; id >= Math.max(0, last - 10); id--) clearInterval(id);
  });
  await page.clock.fastForward(12_000);
  await expect(page.locator('.three-example-viewer [role="alert"]')).toContainText('stopped responding');
  await expect(page.locator('.three-example-viewer iframe')).toHaveCount(0);
});

test('the isolated document keeps its network policy after replacement', async ({page}) => {
  await stub(page, scene + `
    fetch('https://example.invalid/blocked').then(() => document.body.dataset.external='allowed', () => document.body.dataset.external='blocked');
    try { parent.location.href='https://example.invalid/navigation'; } catch { document.body.dataset.navigation='blocked'; }
  `);
  let leaked = false;
  await page.route('https://example.invalid/**', route => { leaked = true; return route.fulfill({body:'unexpected'}); });
  await attach(page);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.getByText('Example running',{exact:true})).toBeVisible();
  const body = page.frameLocator('iframe[title="Interactive Three.js example"]').locator('body');
  await expect(body).toHaveAttribute('data-external','blocked');
  await expect(body).toHaveAttribute('data-navigation','blocked');
  expect(leaked).toBe(false);
});

// Regression: real examples (e.g. skinning_ik) load their model textures as blob: URLs through fetch.
// With connect-src lacking blob: the model never drew and the example showed as an empty white scene.
test('an example can read its own blob: and data: resources but still not the network', async ({page}) => {
  await stub(page, scene + `
    const blob = URL.createObjectURL(new Blob(['x']));
    fetch(blob).then(() => document.body.dataset.blob='allowed', () => document.body.dataset.blob='blocked');
    fetch('data:text/plain,x').then(() => document.body.dataset.data='allowed', () => document.body.dataset.data='blocked');
  `);
  await attach(page);
  await page.getByRole('button',{name:'Load example',exact:true}).click();
  await expect(page.getByText('Example running',{exact:true})).toBeVisible();
  const body = page.frameLocator('iframe[title="Interactive Three.js example"]').locator('body');
  await expect(body).toHaveAttribute('data-blob','allowed');
  await expect(body).toHaveAttribute('data-data','allowed');
  const frame = page.locator('.three-example-viewer iframe');
  // Nothing may dim or cover the frame either.
  const veil = await frame.evaluate(el => { const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    let o = 1; for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return { top: top === el, opacity: o }; });
  expect(veil).toEqual({ top: true, opacity: 1 });
});

// ---- Graph background (kb:threejs-example-background) ----
async function closeViewer(page: Page) {
  const fullscreenClose = page.locator('.asset-fs-close');
  if (await fullscreenClose.isVisible()) await fullscreenClose.click();
  else await page.locator('.asset-large .asset-controls button[title="Close"]').click();
}
async function setBackground(page: Page) {
  await closeViewer(page);
  await page.getByRole('button',{name:'Set as background',exact:true}).click();
  await expect(page.getByRole('button',{name:'Clear background',exact:true})).toBeVisible();
}
// Close the node panel (a bottom sheet on phones) and the search dropdown so the graph and its bar are reachable.
async function toGraph(page: Page) {
  const close = page.locator('.np-close-btn');
  if (await close.isVisible()) await close.click();
  await expect(close).toHaveCount(0);
}
const bar = (page: Page) => page.getByRole('group',{name:'Background example'});

test('a background example never loads by itself, sits behind a clickable graph, and stops from the graph view', async ({page}) => {
  let requests = 0;
  page.on('request', r => { if (r.url().startsWith('https://threejs.org/')) requests++; });
  await stub(page); await attach(page); await setBackground(page); await toGraph(page);
  await expect(bar(page)).toContainText('webgl_reckons_fixture');
  await expect(page.locator('iframe[title="Three.js example background"]')).toHaveCount(0);
  expect(requests).toBe(0);
  await bar(page).getByRole('button',{name:'Load',exact:true}).click();
  await expect(bar(page)).toContainText('Background running');
  const iframe = page.locator('iframe[title="Three.js example background"]');
  await expect(iframe).toHaveAttribute('sandbox','allow-scripts');
  expect(await iframe.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  // The frame is behind the graph: the element at the middle of the stage is not the iframe.
  const top = await page.evaluate(() => { const r = document.querySelector('.graph')!.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3)?.tagName; });
  expect(top).not.toBe('IFRAME');
  await bar(page).getByRole('button',{name:'Stop',exact:true}).click();
  await expect(iframe).toHaveCount(0);
  await expect(bar(page)).toContainText('Background: webgl_reckons_fixture');
  await expect(bar(page).getByRole('button',{name:'Load',exact:true})).toBeVisible();
});

test('Interact with background hands input to the example and back', async ({page}) => {
  await stub(page); await attach(page); await setBackground(page); await toGraph(page);
  await bar(page).getByRole('button',{name:'Load',exact:true}).click();
  await expect(bar(page)).toContainText('Background running');
  const iframe = page.locator('iframe[title="Three.js example background"]');
  const toggle = bar(page).getByRole('button',{name:'Interact with background',exact:true});
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed','true');
  expect(await iframe.evaluate(el => getComputedStyle(el.parentElement!).pointerEvents)).toBe('auto');
  expect(await page.evaluate(() => { const g = document.querySelector('.graph')!;
    return [...g.children].filter(c => !c.classList.contains('three-bg-layer') && !c.classList.contains('three-bg-bar'))
      .every(c => getComputedStyle(c).pointerEvents === 'none'); })).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed','false');
  expect(await iframe.evaluate(el => getComputedStyle(el.parentElement!).pointerEvents)).toBe('none');
});

test('a failing background example unloads, shows the error with Retry, and the graph backdrop returns', async ({page}) => {
  await stub(page, "throw new Error('Synthetic background failure')"); await attach(page); await setBackground(page); await toGraph(page);
  await bar(page).getByRole('button',{name:'Load',exact:true}).click();
  await expect(bar(page).getByRole('alert')).toContainText('Synthetic background failure');
  await expect(page.locator('iframe[title="Three.js example background"]')).toHaveCount(0);
  await expect(bar(page).getByRole('button',{name:'Retry',exact:true})).toBeVisible();
  await expect(page.locator('.graph.bg-example-live')).toHaveCount(0);
});

test('the graph is see-through only while the example runs', async ({page}) => {
  await stub(page); await attach(page); await setBackground(page); await toGraph(page);
  const bg = () => page.locator('.graph').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await bg()).not.toBe('rgba(0, 0, 0, 0)');
  await bar(page).getByRole('button',{name:'Load',exact:true}).click();
  await expect(bar(page)).toContainText('Background running');
  expect(await bg()).toBe('rgba(0, 0, 0, 0)');
  await bar(page).getByRole('button',{name:'Stop',exact:true}).click();
  expect(await bg()).not.toBe('rgba(0, 0, 0, 0)');
});

test('Clear background in the node editor removes the bar', async ({page}) => {
  await stub(page); await attach(page); await setBackground(page);
  await expect(bar(page)).toBeVisible();
  // Clear from the node editor, then confirm the bar goes.
  await page.getByRole('button',{name:'Clear background',exact:true}).click();
  await expect(bar(page)).toHaveCount(0);
});
