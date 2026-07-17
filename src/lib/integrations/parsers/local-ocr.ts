/**
 * Local OCR via tesseract.js (WASM) — offline text-from-image, no API key.
 *
 * The offline sibling of the Mistral cloud OCR (mistral-ocr.ts): when a user
 * drops an IMAGE on the ingest tab and hasn't set a Mistral key, we read the
 * text in-browser instead of erroring. Images only — PDFs need rasterization
 * first (still routed to Mistral, or a future pdf.js step).
 *
 * tesseract.js fetches its language data from cdn.jsdelivr.net, which the app's
 * CSP already allows (connect-src / script-src).
 */

/** OCR an image File/Blob to plain text. `onProgress` reports 0-100 while recognizing. */
export async function ocrImageLocal(
  source: File | Blob | string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', undefined, {
    logger: onProgress
      ? (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') onProgress(Math.round((m.progress ?? 0) * 100));
        }
      : undefined,
  });
  try {
    const { data } = await worker.recognize(source);
    return data.text.trim();
  } finally {
    await worker.terminate();
  }
}
