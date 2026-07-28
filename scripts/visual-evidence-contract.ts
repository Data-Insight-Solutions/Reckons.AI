import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

export const EVIDENCE_ROOT = resolve('test-results', 'visual-evidence');
export const EVIDENCE_SCHEMA_VERSION = 1;
export const DEFAULT_VLM_MODEL = process.env.VLM_MODEL ?? 'qwen2.5vl:7b';

export type Orientation = 'portrait' | 'landscape';
export type Renderer = '3d' | '2d' | 'none';

export interface EvidenceCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RuntimeErrors {
  page: string[];
  console: string[];
}

export interface ScreenshotEvidence {
  id: string;
  label: string;
  path: string;
  sha256: string;
  bytes: number;
  capturedAt: string;
  url: string;
  viewport: { width: number; height: number };
  renderer: Renderer;
  audit: EvidenceCheck[];
  baseline?: {
    name: string;
    path: string;
    sha256: string;
    status: 'matched' | 'updated';
  };
}

export interface EvidenceManifest {
  schemaVersion: 1;
  run: {
    commitSha: string;
    dirty: boolean;
    startedAt: string;
    finishedAt: string | null;
    baseUrl: string;
    buildMode: 'production';
    project: string;
    browser: string;
    browserVersion: string;
    deviceProfile: string;
    device: {
      userAgent: string;
      deviceScaleFactor: number;
      touchPoints: number;
      coarsePointer: boolean;
      noHover: boolean;
    };
    orientation: Orientation;
    viewport: { width: number; height: number };
    tools: {
      node: string;
      playwright: string;
      ollama: string | null;
      vlmModel: string;
      vlmModelDigest: string | null;
    };
  };
  runtimeErrors: RuntimeErrors;
  screenshots: ScreenshotEvidence[];
}

export interface EvidenceRun {
  manifest: EvidenceManifest;
  outputDirectory: string;
  manifestPath: string;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function playwrightVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(resolve('node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
  ) as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function collectRuntimeErrors(page: Page): RuntimeErrors {
  const errors: RuntimeErrors = { page: [], console: [] };
  page.on('pageerror', (error) => {
    errors.page.push(`${error.message}\n${error.stack ?? ''}`.trim());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  return errors;
}

async function writeManifest(run: EvidenceRun): Promise<void> {
  assertEvidenceManifest(run.manifest);
  await writeFile(run.manifestPath, `${JSON.stringify(run.manifest, null, 2)}\n`);
}

export async function startEvidenceRun(
  page: Page,
  testInfo: TestInfo,
  runtimeErrors: RuntimeErrors,
): Promise<EvidenceRun> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Visual evidence requires an explicit viewport');
  const browser = page.context().browser();
  if (!browser) throw new Error('Visual evidence requires a browser-backed page');

  const project = safeSegment(testInfo.project.name);
  const outputDirectory = resolve(EVIDENCE_ROOT, project);
  const manifestPath = resolve(outputDirectory, '_run.json');
  await mkdir(outputDirectory, { recursive: true });

  const baseUrl = testInfo.project.use.baseURL;
  if (typeof baseUrl !== 'string') throw new Error('Visual evidence requires a string baseURL');
  const device = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    deviceScaleFactor: devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    noHover: matchMedia('(hover: none)').matches,
  }));
  const deviceProfile = testInfo.project.metadata.deviceProfile;
  if (typeof deviceProfile !== 'string') {
    throw new Error('Visual evidence project metadata must name its deviceProfile');
  }

  const manifest: EvidenceManifest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      commitSha: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain']).length > 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      baseUrl,
      buildMode: 'production',
      project: testInfo.project.name,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      deviceProfile,
      device,
      orientation: viewport.width >= viewport.height ? 'landscape' : 'portrait',
      viewport,
      tools: {
        node: process.version,
        playwright: await playwrightVersion(),
        ollama: null,
        vlmModel: DEFAULT_VLM_MODEL,
        vlmModelDigest: null,
      },
    },
    runtimeErrors,
    screenshots: [],
  };
  const run = { manifest, outputDirectory, manifestPath };
  await writeManifest(run);
  return run;
}

export async function recordEvidenceScreenshot(
  run: EvidenceRun,
  page: Page,
  input: {
    id: string;
    label: string;
    buffer: Buffer;
    audit: EvidenceCheck[];
    baseline?: { name: string; path: string; sha256: string };
  },
): Promise<ScreenshotEvidence> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Visual evidence requires an explicit viewport');
  if (input.audit.some((check) => !check.pass)) {
    const failed = input.audit.filter((check) => !check.pass);
    throw new Error(`Cannot record evidence with failed audits: ${JSON.stringify(failed)}`);
  }

  const fileName = `${safeSegment(input.id)}.png`;
  const absolutePath = resolve(run.outputDirectory, fileName);
  await writeFile(absolutePath, input.buffer);
  const rendererLocator = page.locator('[data-graph-renderer]').first();
  const rendererValue =
    (await rendererLocator.count()) > 0
      ? await rendererLocator.getAttribute('data-graph-renderer')
      : null;
  const renderer: Renderer =
    rendererValue === '3d' || rendererValue === '2d' ? rendererValue : 'none';
  const evidence: ScreenshotEvidence = {
    id: input.id,
    label: input.label,
    path: relative(EVIDENCE_ROOT, absolutePath),
    sha256: sha256(input.buffer),
    bytes: input.buffer.length,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    viewport,
    renderer,
    audit: input.audit,
    baseline: input.baseline
      ? {
          ...input.baseline,
          path: relative(resolve('.'), input.baseline.path),
          status: process.env.VISUAL_BASELINE_UPDATE === '1' ? 'updated' : 'matched',
        }
      : undefined,
  };
  run.manifest.screenshots.push(evidence);
  await writeManifest(run);
  return evidence;
}

export async function finishEvidenceRun(run: EvidenceRun): Promise<void> {
  run.manifest.run.finishedAt = new Date().toISOString();
  await writeManifest(run);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string`);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

export function assertEvidenceManifest(value: unknown): asserts value is EvidenceManifest {
  assertRecord(value, 'manifest');
  if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`manifest.schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  }
  assertRecord(value.run, 'manifest.run');
  for (const field of [
    'commitSha',
    'startedAt',
    'baseUrl',
    'buildMode',
    'project',
    'browser',
    'browserVersion',
    'deviceProfile',
    'orientation',
  ]) {
    assertString(value.run[field], `manifest.run.${field}`);
  }
  if (value.run.buildMode !== 'production') {
    throw new Error('manifest.run.buildMode must be production');
  }
  if (value.run.orientation !== 'portrait' && value.run.orientation !== 'landscape') {
    throw new Error('manifest.run.orientation must be portrait or landscape');
  }
  if (typeof value.run.dirty !== 'boolean') throw new Error('manifest.run.dirty must be boolean');
  if (value.run.finishedAt !== null) {
    assertString(value.run.finishedAt, 'manifest.run.finishedAt');
  }
  assertRecord(value.run.viewport, 'manifest.run.viewport');
  assertFiniteNumber(value.run.viewport.width, 'manifest.run.viewport.width');
  assertFiniteNumber(value.run.viewport.height, 'manifest.run.viewport.height');
  assertRecord(value.run.device, 'manifest.run.device');
  assertString(value.run.device.userAgent, 'manifest.run.device.userAgent');
  assertFiniteNumber(
    value.run.device.deviceScaleFactor,
    'manifest.run.device.deviceScaleFactor',
  );
  assertFiniteNumber(value.run.device.touchPoints, 'manifest.run.device.touchPoints');
  if (
    typeof value.run.device.coarsePointer !== 'boolean' ||
    typeof value.run.device.noHover !== 'boolean'
  ) {
    throw new Error('manifest.run.device pointer capabilities must be boolean');
  }
  assertRecord(value.run.tools, 'manifest.run.tools');
  assertString(value.run.tools.node, 'manifest.run.tools.node');
  assertString(value.run.tools.playwright, 'manifest.run.tools.playwright');
  assertString(value.run.tools.vlmModel, 'manifest.run.tools.vlmModel');
  if (value.run.tools.ollama !== null) {
    assertString(value.run.tools.ollama, 'manifest.run.tools.ollama');
  }
  if (value.run.tools.vlmModelDigest !== null) {
    assertString(value.run.tools.vlmModelDigest, 'manifest.run.tools.vlmModelDigest');
    if (!/^[a-f0-9]{64}$/.test(value.run.tools.vlmModelDigest)) {
      throw new Error('manifest.run.tools.vlmModelDigest must be a SHA-256 digest');
    }
  }

  assertRecord(value.runtimeErrors, 'manifest.runtimeErrors');
  if (
    !Array.isArray(value.runtimeErrors.page) ||
    !value.runtimeErrors.page.every((item) => typeof item === 'string') ||
    !Array.isArray(value.runtimeErrors.console) ||
    !value.runtimeErrors.console.every((item) => typeof item === 'string')
  ) {
    throw new Error('manifest.runtimeErrors must contain string arrays');
  }
  if (!Array.isArray(value.screenshots)) throw new Error('manifest.screenshots must be an array');
  for (const [index, screenshot] of value.screenshots.entries()) {
    assertRecord(screenshot, `manifest.screenshots[${index}]`);
    for (const field of ['id', 'label', 'path', 'sha256', 'capturedAt', 'url', 'renderer']) {
      assertString(screenshot[field], `manifest.screenshots[${index}].${field}`);
    }
    if (
      (screenshot.path as string).startsWith('/') ||
      (screenshot.path as string).split(/[\\/]/).includes('..')
    ) {
      throw new Error(`manifest.screenshots[${index}].path must stay within the evidence root`);
    }
    if (!['3d', '2d', 'none'].includes(screenshot.renderer as string)) {
      throw new Error(`manifest.screenshots[${index}].renderer is invalid`);
    }
    if (!/^[a-f0-9]{64}$/.test(screenshot.sha256 as string)) {
      throw new Error(`manifest.screenshots[${index}].sha256 must be a SHA-256 digest`);
    }
    assertFiniteNumber(screenshot.bytes, `manifest.screenshots[${index}].bytes`);
    assertRecord(screenshot.viewport, `manifest.screenshots[${index}].viewport`);
    assertFiniteNumber(
      screenshot.viewport.width,
      `manifest.screenshots[${index}].viewport.width`,
    );
    assertFiniteNumber(
      screenshot.viewport.height,
      `manifest.screenshots[${index}].viewport.height`,
    );
    if (!Array.isArray(screenshot.audit)) {
      throw new Error(`manifest.screenshots[${index}].audit must be an array`);
    }
    for (const [auditIndex, audit] of screenshot.audit.entries()) {
      assertRecord(audit, `manifest.screenshots[${index}].audit[${auditIndex}]`);
      assertString(audit.name, `manifest.screenshots[${index}].audit[${auditIndex}].name`);
      assertString(audit.detail, `manifest.screenshots[${index}].audit[${auditIndex}].detail`);
      if (typeof audit.pass !== 'boolean') {
        throw new Error(
          `manifest.screenshots[${index}].audit[${auditIndex}].pass must be boolean`,
        );
      }
    }
    if (screenshot.baseline !== undefined) {
      assertRecord(screenshot.baseline, `manifest.screenshots[${index}].baseline`);
      for (const field of ['name', 'path', 'sha256', 'status']) {
        assertString(
          screenshot.baseline[field],
          `manifest.screenshots[${index}].baseline.${field}`,
        );
      }
      if (
        (screenshot.baseline.path as string).startsWith('/') ||
        (screenshot.baseline.path as string).split(/[\\/]/).includes('..')
      ) {
        throw new Error(
          `manifest.screenshots[${index}].baseline.path must stay within the repository`,
        );
      }
      if (!/^[a-f0-9]{64}$/.test(screenshot.baseline.sha256 as string)) {
        throw new Error(
          `manifest.screenshots[${index}].baseline.sha256 must be a SHA-256 digest`,
        );
      }
      if (!['matched', 'updated'].includes(screenshot.baseline.status as string)) {
        throw new Error(`manifest.screenshots[${index}].baseline.status is invalid`);
      }
    }
  }
}

export async function readEvidenceManifest(path: string): Promise<EvidenceManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  assertEvidenceManifest(parsed);
  return parsed;
}

export async function updateManifestOllamaInfo(
  manifestPath: string,
  manifest: EvidenceManifest,
  version: string,
  modelDigest: string,
): Promise<void> {
  manifest.run.tools.ollama = version;
  manifest.run.tools.vlmModelDigest = modelDigest;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
