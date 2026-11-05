/**
 * F58.9 on-demand entity splats: an entity splat with more Gaussians than the budget does not load at
 * startup. The count is read from the file header, so deciding costs a few bytes, not the file.
 */
import { isLocalSplatUrl } from './splat';

/**
 * Most Gaussians an entity splat may have and still load at startup. Measured 2026-10-21 on headless
 * SwiftShader: the Generated assets example drew 9.4 fps with its two small splats and 3.2 fps once a
 * 262,144-Gaussian splat was always on, which timed out three e2e specs on a 2-core CI runner.
 * A splat over this loads when its entity is opened or "Load 3D splat" is pressed. The 2D budget of
 * the page is unaffected by a splat that is not loaded.
 */
export const ENTITY_SPLAT_STARTUP_BUDGET = 131_072;

/** True when a splat of `count` Gaussians must wait to be asked for. An unknown count never defers. */
export function overStartupBudget(count: number | undefined, budget = ENTITY_SPLAT_STARTUP_BUDGET): boolean {
  return typeof count === 'number' && count > budget;
}

/** Gaussian count from the first bytes of a PLY (text header, `element vertex N`) or a gunzipped SPZ ('NGSP' header). */
export function splatCountFromHeader(head: Uint8Array): number | undefined {
  if (head.length >= 12 && head[0] === 0x4e && head[1] === 0x47 && head[2] === 0x53 && head[3] === 0x50) {
    return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(8, true);
  }
  if (head.length >= 3 && head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79) {
    const text = new TextDecoder().decode(head.subarray(0, Math.min(head.length, 4096)));
    const m = /^element vertex (\d+)\s*$/m.exec(text);
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
}

/** Read up to `n` bytes from a stream, then cancel it so the rest of a large file is not downloaded. */
async function firstBytes(stream: ReadableStream<Uint8Array>, n: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, n - got);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, got);
}

/**
 * The Gaussian count of the splat at `url` (a path, URL or imported `asset:splat/` reference), or
 * undefined when it cannot be read cheaply (SOG, a failed fetch): such a splat is not deferred.
 */
export async function readSplatGaussianCount(url: string): Promise<number | undefined> {
  try {
    let stream: ReadableStream<Uint8Array> | null;
    if (isLocalSplatUrl(url)) {
      const { readSplatFile } = await import('$lib/storage/splat-files');
      const file = await readSplatFile(url);
      stream = file ? (file.blob.stream() as ReadableStream<Uint8Array>) : null;
    } else if (/\.sog([?#].*)?$/i.test(url)) {
      return undefined;
    } else {
      const res = await fetch(url);
      stream = res.ok ? res.body : null;
    }
    if (!stream) return undefined;
    return splatCountFromHeader(await headerOfStream(stream));
  } catch {
    return undefined;
  }
}

async function headerOfStream(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();
  if (!(head[0] === 0x1f && head[1] === 0x8b)) { await reader.cancel().catch(() => {}); return head; }
  // gzip (SPZ): put the chunk read so far back in front of the rest, gunzip, and keep 16 bytes.
  const joined = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(head); },
    async pull(c) { const x = await reader.read(); if (x.done) c.close(); else c.enqueue(x.value); },
    cancel() { return reader.cancel().catch(() => {}); },
  });
  return firstBytes(joined.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), 16);
}
