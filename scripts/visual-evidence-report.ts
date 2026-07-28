import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_VLM_MODEL,
  EVIDENCE_ROOT,
  readEvidenceManifest,
  sha256,
  updateManifestOllamaInfo,
  type EvidenceManifest,
  type ScreenshotEvidence,
} from './visual-evidence-contract';

const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL ??
  process.env.VITE_OLLAMA_BASE_URL ??
  'http://127.0.0.1:11434';

const CATEGORIES = ['layout', 'content', 'accessibility', 'rendering', 'other'] as const;
const SEVERITIES = ['info', 'warning', 'error'] as const;
const EXPECTED_PROJECTS = [
  'desktop-chrome',
  'pixel-7-landscape',
  'pixel-7-portrait',
] as const;

export interface VlmFinding {
  category: (typeof CATEGORIES)[number];
  severity: (typeof SEVERITIES)[number];
  message: string;
}

export interface ParsedVlmReview {
  summary: string;
  findings: VlmFinding[];
}

export interface BoundVlmReview extends ParsedVlmReview {
  project: string;
  screenshotId: string;
  screenshotSha256: string;
  model: string;
  modelDigest: string;
  ollamaVersion: string;
  reviewedAt: string;
}

export function parseVlmReview(raw: string): ParsedVlmReview {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`VLM response was not JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('VLM response must be an object');
  }
  const review = value as Record<string, unknown>;
  if (typeof review.summary !== 'string' || review.summary.trim().length === 0) {
    throw new Error('VLM response summary must be a nonempty string');
  }
  if (!Array.isArray(review.findings)) throw new Error('VLM response findings must be an array');
  const findings = review.findings.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`VLM finding ${index} must be an object`);
    }
    const finding = candidate as Record<string, unknown>;
    if (!CATEGORIES.includes(finding.category as VlmFinding['category'])) {
      throw new Error(`VLM finding ${index} has an invalid category`);
    }
    if (!SEVERITIES.includes(finding.severity as VlmFinding['severity'])) {
      throw new Error(`VLM finding ${index} has an invalid severity`);
    }
    if (typeof finding.message !== 'string' || finding.message.trim().length === 0) {
      throw new Error(`VLM finding ${index} message must be a nonempty string`);
    }
    return {
      category: finding.category as VlmFinding['category'],
      severity: finding.severity as VlmFinding['severity'],
      message: finding.message.trim(),
    };
  });
  return { summary: review.summary.trim(), findings };
}

async function ollamaRuntime(): Promise<{ version: string; modelDigest: string }> {
  const [versionResponse, tagsResponse] = await Promise.all([
    fetch(`${OLLAMA_URL}/api/version`),
    fetch(`${OLLAMA_URL}/api/tags`),
  ]);
  if (!versionResponse.ok) {
    throw new Error(`Ollama version request failed: ${versionResponse.status}`);
  }
  if (!tagsResponse.ok) throw new Error(`Ollama tags request failed: ${tagsResponse.status}`);
  const versionJson = (await versionResponse.json()) as { version?: unknown };
  if (typeof versionJson.version !== 'string' || versionJson.version.length === 0) {
    throw new Error('Ollama version response did not include a version');
  }
  const tagsJson = (await tagsResponse.json()) as {
    models?: Array<{ name?: unknown; model?: unknown; digest?: unknown }>;
  };
  const model = tagsJson.models?.find(
    (candidate) =>
      candidate.name === DEFAULT_VLM_MODEL || candidate.model === DEFAULT_VLM_MODEL,
  );
  if (!model || typeof model.digest !== 'string' || !/^[a-f0-9]{64}$/.test(model.digest)) {
    throw new Error(`Ollama did not report an immutable digest for ${DEFAULT_VLM_MODEL}`);
  }
  return { version: versionJson.version, modelDigest: model.digest };
}

async function reviewScreenshot(
  project: string,
  screenshot: ScreenshotEvidence,
  version: string,
  modelDigest: string,
): Promise<BoundVlmReview> {
  const absolutePath = resolve(EVIDENCE_ROOT, screenshot.path);
  const imageBuffer = await readFile(absolutePath);
  if (sha256(imageBuffer) !== screenshot.sha256 || imageBuffer.length !== screenshot.bytes) {
    throw new Error(`${project}/${screenshot.id} changed before VLM review`);
  }
  const prompt = [
    'You are an advisory UI evidence reviewer. Inspect only the attached screenshot.',
    `Evidence id: ${screenshot.id}`,
    `Viewport: ${screenshot.viewport.width}x${screenshot.viewport.height}`,
    `Renderer: ${screenshot.renderer}`,
    'Look for visible clipping, overlap, unreadable contrast, missing content, broken rendering,',
    'and controls that appear unusably small. Do not infer hidden behavior.',
    'Return ONLY JSON matching this exact shape:',
    '{"summary":"one concise sentence","findings":[{"category":"layout|content|accessibility|rendering|other","severity":"info|warning|error","message":"specific visible observation"}]}',
    'Use an empty findings array when no issue is visible.',
  ].join('\n');
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DEFAULT_VLM_MODEL,
      prompt,
      images: [imageBuffer.toString('base64')],
      stream: false,
      options: { num_ctx: 8192, temperature: 0 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama VLM request failed for ${project}/${screenshot.id}: ${response.status}`);
  }
  const json = (await response.json()) as { response?: unknown };
  if (typeof json.response !== 'string') {
    throw new Error(`Ollama VLM returned no response for ${project}/${screenshot.id}`);
  }
  const parsed = parseVlmReview(json.response);
  return {
    ...parsed,
    project,
    screenshotId: screenshot.id,
    screenshotSha256: screenshot.sha256,
    model: DEFAULT_VLM_MODEL,
    modelDigest,
    ollamaVersion: version,
    reviewedAt: new Date().toISOString(),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderHtml(
  manifests: EvidenceManifest[],
  reviews: BoundVlmReview[],
  version: string,
  modelDigest: string,
): string {
  const cards = manifests.flatMap((manifest) =>
    manifest.screenshots.map((screenshot) => {
      const review = reviews.find(
        (candidate) =>
          candidate.project === manifest.run.project &&
          candidate.screenshotId === screenshot.id &&
          candidate.screenshotSha256 === screenshot.sha256,
      );
      const checks = screenshot.audit
        .map((check) => `<li class="pass">✓ ${escapeHtml(check.name)} — ${escapeHtml(check.detail)}</li>`)
        .join('');
      const findings = (review?.findings ?? [])
        .map(
          (finding) =>
            `<li class="${finding.severity}">${escapeHtml(finding.severity.toUpperCase())}: ` +
            `${escapeHtml(finding.message)}</li>`,
        )
        .join('');
      return `
        <article>
          <h2>${escapeHtml(manifest.run.project)} · ${escapeHtml(screenshot.label)}</h2>
          <p class="meta">${screenshot.viewport.width}×${screenshot.viewport.height} ·
            ${escapeHtml(manifest.run.orientation)} · renderer ${escapeHtml(screenshot.renderer)}</p>
          <img src="${escapeHtml(screenshot.path)}" alt="${escapeHtml(screenshot.label)}">
          <h3>Deterministic checks</h3>
          <ul>${checks}</ul>
          <h3>Advisory Ollama review</h3>
          <p>${escapeHtml(review?.summary ?? 'No review result')}</p>
          <ul>${findings || '<li class="pass">No advisory findings</li>'}</ul>
          <p class="hash">SHA-256 ${escapeHtml(screenshot.sha256)}</p>
        </article>`;
    }),
  ).join('');
  const first = manifests[0];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reckons.AI visual evidence</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #11131a; color: #edf0f7; }
    body { max-width: 1500px; margin: 0 auto; padding: 32px; }
    header { border-bottom: 1px solid #343846; margin-bottom: 28px; }
    .meta,.hash { color: #aeb5c5; font: 13px ui-monospace, monospace; overflow-wrap: anywhere; }
    main { display: grid; grid-template-columns: repeat(auto-fit,minmax(330px,1fr)); gap: 24px; }
    article { background: #1a1e28; border: 1px solid #343846; border-radius: 12px; padding: 18px; }
    img { width: 100%; max-height: 700px; object-fit: contain; object-position: top; background: #090a0e; border-radius: 8px; }
    h2 { font-size: 18px; } h3 { font-size: 14px; margin-bottom: 6px; }
    ul { padding-left: 20px; } .pass { color: #84e1a6; } .warning { color: #ffd166; } .error { color: #ff7b86; }
  </style>
</head>
<body>
  <header>
    <h1>Visual evidence review</h1>
    <p class="meta">Commit ${escapeHtml(first.run.commitSha)} · dirty ${first.run.dirty} ·
      production · Playwright ${escapeHtml(first.run.tools.playwright)} ·
      Ollama ${escapeHtml(version)} · ${escapeHtml(DEFAULT_VLM_MODEL)}</p>
    <p class="meta">Model digest ${escapeHtml(modelDigest)}</p>
    <p>Deterministic assertions and baselines are authoritative. Model findings are advisory.</p>
  </header>
  <main>${cards}</main>
</body>
</html>`;
}

async function main(): Promise<void> {
  const entries = await readdir(EVIDENCE_ROOT, { withFileTypes: true });
  const manifestPaths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(EVIDENCE_ROOT, entry.name, '_run.json'));
  if (manifestPaths.length === 0) throw new Error('No visual evidence manifests found');

  const manifests = await Promise.all(manifestPaths.map(readEvidenceManifest));
  const projects = manifests.map((manifest) => manifest.run.project).sort();
  if (JSON.stringify(projects) !== JSON.stringify([...EXPECTED_PROJECTS].sort())) {
    throw new Error(
      `Visual evidence projects were incomplete: expected ${EXPECTED_PROJECTS.join(', ')}, ` +
      `received ${projects.join(', ')}`,
    );
  }
  for (const manifest of manifests) {
    if (!manifest.run.finishedAt) throw new Error(`${manifest.run.project} evidence run did not finish`);
    if (manifest.runtimeErrors.page.length || manifest.runtimeErrors.console.length) {
      throw new Error(`${manifest.run.project} manifest contains runtime errors`);
    }
    if (manifest.screenshots.length === 0) {
      throw new Error(`${manifest.run.project} manifest contains no screenshots`);
    }
    for (const screenshot of manifest.screenshots) {
      const image = await readFile(resolve(EVIDENCE_ROOT, screenshot.path));
      if (sha256(image) !== screenshot.sha256 || image.length !== screenshot.bytes) {
        throw new Error(`${manifest.run.project}/${screenshot.id} screenshot hash or size mismatch`);
      }
      if (screenshot.audit.some((check) => !check.pass)) {
        throw new Error(`${manifest.run.project}/${screenshot.id} contains a failed deterministic audit`);
      }
      if (screenshot.baseline) {
        const baseline = await readFile(resolve(screenshot.baseline.path));
        if (sha256(baseline) !== screenshot.baseline.sha256) {
          throw new Error(`${manifest.run.project}/${screenshot.id} baseline hash mismatch`);
        }
      }
    }
  }

  const { version, modelDigest } = await ollamaRuntime();
  await Promise.all(
    manifests.map((manifest, index) =>
      updateManifestOllamaInfo(manifestPaths[index], manifest, version, modelDigest),
    ),
  );

  const reviews: BoundVlmReview[] = [];
  for (const manifest of manifests) {
    for (const screenshot of manifest.screenshots) {
      reviews.push(
        await reviewScreenshot(manifest.run.project, screenshot, version, modelDigest),
      );
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    authority: {
      deterministic: 'blocking',
      vlm: 'advisory',
    },
    ollama: { url: OLLAMA_URL, version, model: DEFAULT_VLM_MODEL, modelDigest },
    manifests,
    reviews,
  };
  await writeFile(resolve(EVIDENCE_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(EVIDENCE_ROOT, 'report.html'),
    renderHtml(manifests, reviews, version, modelDigest),
  );
  console.log(`Visual evidence report: ${resolve(EVIDENCE_ROOT, 'report.html')}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
