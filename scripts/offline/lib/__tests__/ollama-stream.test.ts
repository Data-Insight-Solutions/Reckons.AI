import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { foldNdjson, ollamaStream } from '../ollama-stream';

describe('foldNdjson', () => {
  it('joins generate and chat chunks split mid-line, and keeps the final record', () => {
    const lines = ['{"response":"Hel"}\n{"respo', 'nse":"lo"}\n', '{"done":true,"eval_count":2}'];
    expect(foldNdjson(lines)).toEqual({ text: 'Hello', final: { done: true, eval_count: 2 } });
    expect(foldNdjson(['{"message":{"content":"a"}}\n{"message":{"content":"b"},"done":true}\n']).text).toBe('ab');
  });
  it('throws Ollama\'s own error line', () => {
    expect(() => foldNdjson(['{"error":"model not found"}\n'])).toThrow(/Ollama: model not found/);
  });
});

describe('ollamaStream against a local server', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  const serve = (handler: Parameters<typeof createServer>[1]) => new Promise<string>((resolve) => {
    server = createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });

  it('waits through a slow start (a queue) longer than the idle limit, then reads the stream', async () => {
    const base = await serve((_req, res) => {
      setTimeout(() => { res.write('{"response":"ok"}\n'); res.end('{"done":true}\n'); }, 300);
    });
    const r = await ollamaStream(base, 'generate', { model: 'm', prompt: 'p' }, { queueWaitMs: 2_000, idleMs: 100 });
    expect(r.text).toBe('ok');
  });

  it('fails as SILENCE when the answer stops mid-stream, and says so', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      res.write('{"response":"par"}\n'); // then nothing, never ends
    });
    await expect(ollamaStream(base, 'generate', { model: 'm', prompt: 'p' }, { queueWaitMs: 2_000, idleMs: 150 }))
      .rejects.toThrow(/went silent/);
  });

  it('keeps a multi-byte character that arrives split across two chunks', async () => {
    const bytes = Buffer.from('{"response":"café ✓"}\n{"done":true}\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "é"
    const base = await serve((_req, res) => { res.write(bytes.subarray(0, cut)); setTimeout(() => res.end(bytes.subarray(cut)), 50); });
    expect((await ollamaStream(base, 'generate', { model: 'm' })).text).toBe('café ✓');
  });

  it('asks for a stream whatever the caller passed', async () => {
    let seen: { stream?: boolean } = {};
    const base = await serve((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen = JSON.parse(b); res.end('{"done":true}\n'); });
    });
    await ollamaStream(base, 'chat', { model: 'm', stream: false });
    expect(seen.stream).toBe(true);
  });
});
