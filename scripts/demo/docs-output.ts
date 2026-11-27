/**
 * F275.22.1 — the web-sized output of `npm run demo:render -- --format=docs`.
 *
 * A documentation video ships in static/video/demos/ and so becomes permanent public git history and
 * part of every site deploy. Hence two rules, both pure so a test can run them without ffmpeg:
 *   - it is compressed for the web (H.264, AAC, faststart, at most 1280 px wide);
 *   - a result over 10 MB is REFUSED, never written to the docs folder, because trimming a video
 *     after it has been committed does not remove it from history.
 */

export const DOCS_MAX_BYTES = 10 * 1000 * 1000;
export const DOCS_MAX_WIDTH = 1280;

/** The reason a docs video is refused, or null when its size is fine. */
export function docsSizeProblem(bytes: number, name = 'the video'): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return `${name} is empty or unreadable`;
  if (bytes > DOCS_MAX_BYTES) {
    const mb = (bytes / 1e6).toFixed(1);
    return `${name} is ${mb} MB, over the ${DOCS_MAX_BYTES / 1e6} MB limit for a documentation video. `
      + 'It would be permanent in git history and slow every page that embeds it. Shorten the narration, '
      + 'record fewer steps, or raise --crf; nothing was written to static/video/demos/.';
  }
  return null;
}

/** ffmpeg arguments for the web-sized copy: scaled down (never up) to 1280 px wide, even dimensions. */
export function docsEncodeArgs(o: { input: string; out: string; crf?: number }): string[] {
  return [
    '-y', '-i', o.input,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn',
    '-vf', `scale='min(${DOCS_MAX_WIDTH},iw)':-2`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(o.crf ?? 30), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    o.out,
  ];
}

/** ffmpeg arguments for one poster frame (WebP) taken at `atMs`. */
export function posterArgs(o: { input: string; out: string; atMs: number }): string[] {
  return ['-y', '-ss', (o.atMs / 1000).toFixed(2), '-i', o.input, '-frames:v', '1',
    '-vf', `scale='min(${DOCS_MAX_WIDTH},iw)':-2`, o.out];
}
