import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStreams, type Stream } from '../../scripts/visual-streams/contract';
import { runStream, needsReview, type Ask } from '../../scripts/visual-streams/runner';

let server: Server;
let base: string;
let writes = 0;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body><nav><a href="/review">Review</a></nav>
      <h1>${req.url === '/review' ? 'Review ready' : 'Start'}</h1>
      <input aria-label="Note"><button id="save" onclick="document.querySelector('h1').textContent=document.querySelector('input').value; localStorage.setItem('saved','yes')">Save</button>
      <button id="post" onclick="fetch('/write',{method:'POST'}).catch(()=>{})">Send</button>
      <button id="error" onclick="setTimeout(()=>{throw new Error('fixture browser error')},0)">Error</button>
      <p id="storage"></p><script>document.querySelector('#storage').textContent=localStorage.getItem('saved')||'empty'</script>
      ${req.url === '/moving' ? `<script>new MutationObserver(() => {
        const a=document.querySelector('a[data-vlm-target]');
        if(a) setTimeout(()=>{a.style.marginLeft='100px'},100);
      }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-vlm-target']})</script>` : ''}
      </body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'This runner launches Chromium'); });

function stream(overrides: Partial<Stream> = {}): Stream {
  return parseStreams({ version: 1, streams: [{ id: 'fixture', mode: 'explore', goal: 'Open Review', startPath: '/',
    maxSteps: 3, timeoutMs: 15000, lenses: [{ id: 'layout', question: 'Is it readable?' }], ...overrides }] })[0];
}
const ok = JSON.stringify({ verdict: 'ok', detail: 'The controls are visible' });
const finish = JSON.stringify({ action: 'finish', reason: 'The goal is reached' });
const alwaysFinish: Ask = async ({ prompt }) => prompt.startsWith('Review the') ? ok : finish;

test('VLM chooses a real control; receipts retain ordered evidence and assertions', async ({ browser }, info) => {
  let actions = 0;
  const ask: Ask = async ({ prompt, images }) => {
    expect(images.length).toBeGreaterThan(0);
    if (prompt.startsWith('Review the')) return ok;
    return actions++ ? finish : JSON.stringify({ action: 'click', target: 1, reason: 'Review is visible' });
  };
  const directory = info.outputPath('guided');
  const report = await runStream(browser, stream({ assertions: [{ path: '/review', selector: 'h1', text: 'Review ready' }] }), base, directory, ask);
  expect(report.status).toBe('verified');
  expect(report.stoppedBy).toBe('assertions');
  expect(actions).toBe(1);
  expect(report.frames).toHaveLength(2);
  expect(report.frames[0].action).toMatchObject({ action: 'click', target: 1 });
  expect(report.frames.every(f => f.sha256.length === 64)).toBe(true);
  expect(JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')).status).toBe('verified');
});

test('scripted fill/click uses multiple lenses; the next stream has empty storage', async ({ browser }, info) => {
  const report = await runStream(browser, stream({ mode: 'scripted', steps: [
    { action: 'fill', selector: 'input', text: 'Synthetic note' }, { action: 'click', selector: '#save' },
  ], assertions: [{ selector: 'h1', text: 'Synthetic note' }], lenses: [
    { id: 'layout', question: 'Layout?' }, { id: 'progress', question: 'Progress?' },
  ] }), base, info.outputPath('scripted'), async () => ok);
  expect(report.status).toBe('verified');
  expect(report.frames.map(f => f.reviews.length)).toEqual([2, 2, 2]);
  const next = await runStream(browser, stream({ assertions: [{ selector: '#storage', text: 'empty' }] }), base, info.outputPath('fresh'), alwaysFinish);
  expect(next.status).toBe('verified');
});

test('a model claiming finish cannot pass a failing goal assertion', async ({ browser }, info) => {
  const report = await runStream(browser, stream({ assertions: [{ path: '/review' }] }), base, info.outputPath('false-finish'), alwaysFinish);
  expect(report.status).toBe('error');
  expect(report.assertions[0].pass).toBe(false);
});

test('a control moving during inference is rejected before clicking', async ({ browser }, info) => {
  const report = await runStream(browser, stream({ startPath: '/moving' }), base, info.outputPath('stale'), async ({ prompt }) => {
    if (prompt.startsWith('Review the')) return ok;
    await new Promise(resolve => setTimeout(resolve, 350));
    return '{"action":"click","target":1,"reason":"Review link"}';
  });
  expect(report.status).toBe('error');
  expect(report.errors.join(' ')).toContain('Target moved');
  expect(report.frames).toHaveLength(1);
});

test('freeform exploration remains unverified without a browser oracle', async ({ browser }, info) => {
  const report = await runStream(browser, stream(), base, info.outputPath('unverified'), alwaysFinish);
  expect(report.status).toBe('unverified');
});

test('exhaustion, invalid actions and malformed reviews never pass', async ({ browser }, info) => {
  const exhausted = await runStream(browser, stream({ maxSteps: 1 }), base, info.outputPath('exhausted'), async ({ prompt }) =>
    prompt.startsWith('Review the') ? ok : '{"action":"scroll","delta":100,"reason":"look"}');
  expect(exhausted.status).toBe('exhausted');
  const invalid = await runStream(browser, stream(), base, info.outputPath('invalid'), async ({ prompt }) =>
    prompt.startsWith('Review the') ? ok : '{"action":"click","target":99,"reason":"invented"}');
  expect(invalid.status).toBe('error');
  expect(invalid.frames[0].actionRaw).toContain('99');
  const malformed = await runStream(browser, stream(), base, info.outputPath('malformed'), async () => 'YES');
  expect(malformed.status).toBe('error');
  expect(malformed.frames[0].reviews[0].raw).toBe('YES');
});

test('visible issues require review even when goal assertions pass', async ({ browser }, info) => {
  const report = await runStream(browser, stream({ assertions: [{ path: '/' }] }), base, info.outputPath('issues'), async ({ prompt }) =>
    prompt.startsWith('Review the') ? '{"verdict":"issue","detail":"Navigation text overlaps"}' : finish);
  expect(report.status).toBe('verified');
  expect(needsReview(report)).toBe(true);
});

test('browser errors and deadline cancellation produce failed receipts', async ({ browser }, info) => {
  const error = await runStream(browser, stream({ mode: 'scripted', steps: [{ action: 'click', selector: '#error' }] }), base, info.outputPath('browser-error'), async () => ok);
  expect(error.status).toBe('error');
  expect(error.errors.join(' ')).toContain('fixture browser error');
  const timeout = await runStream(browser, stream({ timeoutMs: 1000 }), base, info.outputPath('deadline'), async ({ signal }) => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return ok;
  });
  expect(timeout.status).toBe('error');
  expect(timeout.errors.join(' ')).toContain('deadline');
});

test('scripted navigation works and server mutations are blocked', async ({ browser }, info) => {
  writes = 0;
  const report = await runStream(browser, stream({ mode: 'scripted', steps: [
    { action: 'goto', path: '/review' }, { action: 'click', selector: '#post' },
  ] }), base, info.outputPath('network'), async () => ok);
  expect(report.blockedRequests).toContain(`POST ${base}/write`);
  expect(writes).toBe(0);
  expect(report.status).toBe('error');
});
