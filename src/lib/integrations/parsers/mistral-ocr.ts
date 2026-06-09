/**
 * Mistral OCR — converts PDFs and images to clean markdown text.
 *
 * Uses the `mistral-ocr-latest` model via a single POST. The file is
 * base64-encoded and sent as a data-URI so no intermediate file upload
 * step is required. Works entirely client-side; the API key is never
 * stored server-side.
 *
 * Supported input types:
 *   - application/pdf
 *   - image/png, image/jpeg, image/webp, image/gif
 */

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  // Use Uint8Array → binary string approach; works in all modern browsers
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Process in chunks to avoid call-stack overflow on large files
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function parsePdfWithMistralOCR(file: File, apiKey: string): Promise<string> {
  const base64 = await fileToBase64(file);
  const mime = file.type || 'application/pdf';
  const dataUri = `data:${mime};base64,${base64}`;

  const isImage = file.type.startsWith('image/');
  const document = isImage
    ? { type: 'image_url', image_url: dataUri }
    : { type: 'document_url', document_url: dataUri };

  const res = await fetch(MISTRAL_OCR_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mistral OCR ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.pages ?? [])
    .map((p: { markdown: string }) => p.markdown)
    .join('\n\n');
}
