/** F166.1: a file queue of bounded generation requests, never executable commands. */
export const GENERATION_DIR = '.reckons-generation';
export const GENERATION_STAGES = ['image', 'video', 'splat'] as const;
export type GenerationStage = typeof GENERATION_STAGES[number];
export const OUTPUT_FILES = { image: 'image.webp', video: 'video.webm', splat: 'splat.ply' } as const;
export const STAGE_LABELS = { image: 'Image', video: 'Video', splat: 'Gaussian splat' } as const;

export interface GenerationRequest {
  version: 1;
  id: string;
  spaceId: string;
  stage: GenerationStage;
  prompt: string;
  seed: number;
  /** A completed image job in this same workspace and space. */
  parentId?: string;
}
export interface GenerationReceipt {
  stage: GenerationStage;
  tool: { name: string; version: string; license: string };
  models: { file: string; sha256: string; license: string }[];
  input: { prompt?: string; imageSha256?: string };
  output: { file: string; sha256: string; bytes: number };
  check: { pass: boolean };
  settings: Record<string, string | number>;
  ranAt: string;
  durationS: number;
}
export interface GenerationJob {
  request: GenerationRequest;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  receipt?: GenerationReceipt;
}
export interface GenerationCapabilities {
  version: 1;
  workspaceId: string;
  heartbeat: number;
  stages: { stage: GenerationStage; available: boolean; reason?: string }[];
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
export function validJobId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseRequest(value: unknown): GenerationRequest {
  if (!record(value) || value.version !== 1 || !validJobId(value.id)
    || typeof value.spaceId !== 'string' || !value.spaceId || value.spaceId.length > 200
    || !GENERATION_STAGES.includes(value.stage as GenerationStage)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 2000
    || !Number.isInteger(value.seed) || Number(value.seed) < 0 || Number(value.seed) > 2147483647
    || (value.stage !== 'image' && !validJobId(value.parentId))
    || (value.stage === 'image' && value.parentId !== undefined)) {
    throw new Error('Invalid generation request');
  }
  // Drop unknown fields: the queue cannot supply a command, path, model, or extra CLI arguments.
  return {
    version: 1, id: value.id, spaceId: value.spaceId, stage: value.stage as GenerationStage,
    prompt: value.prompt, seed: value.seed as number,
    ...(value.parentId ? { parentId: value.parentId as string } : {}),
  };
}

export function sameRequest(a: GenerationRequest, b: GenerationRequest): boolean {
  return JSON.stringify(parseRequest(a)) === JSON.stringify(parseRequest(b));
}

export function parseJob(value: unknown, request: GenerationRequest): GenerationJob {
  if (!record(value) || !sameRequest(parseRequest(value.request), request)
    || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.state))) {
    throw new Error('Generation result does not match this request');
  }
  if (value.state === 'completed') validateReceipt(value.receipt, request);
  return value as unknown as GenerationJob;
}

export function validateReceipt(value: unknown, request: GenerationRequest): asserts value is GenerationReceipt {
  if (!record(value) || value.stage !== request.stage || !record(value.check) || value.check.pass !== true
    || !record(value.output) || value.output.file !== OUTPUT_FILES[request.stage]
    || typeof value.output.sha256 !== 'string' || !HASH.test(value.output.sha256)
    || !Number.isSafeInteger(value.output.bytes) || Number(value.output.bytes) <= 0 || Number(value.output.bytes) > 100 * 1024 * 1024
    || !record(value.tool) || typeof value.tool.name !== 'string' || typeof value.tool.version !== 'string'
    || typeof value.tool.license !== 'string' || !Array.isArray(value.models) || !value.models.length
    || !value.models.every((m) => record(m) && typeof m.file === 'string' && typeof m.license === 'string'
      && typeof m.sha256 === 'string' && HASH.test(m.sha256))
    || !record(value.input) || (request.stage !== 'splat' && value.input.prompt !== request.prompt)
    || (request.parentId && (typeof value.input.imageSha256 !== 'string' || !HASH.test(value.input.imageSha256)))
    || !record(value.settings) || value.settings.seed !== request.seed
    || typeof value.ranAt !== 'string' || !Number.isFinite(Date.parse(value.ranAt))
    || typeof value.durationS !== 'number' || !Number.isFinite(value.durationS) || value.durationS < 0) {
    throw new Error('Generation receipt is missing, failed, or inconsistent');
  }
}

export function parseCapabilities(value: unknown, now = Date.now()): GenerationCapabilities {
  if (!record(value) || value.version !== 1 || !validJobId(value.workspaceId) || typeof value.heartbeat !== 'number'
    || Math.abs(now - value.heartbeat) > 30_000 || !Array.isArray(value.stages)
    || value.stages.length !== GENERATION_STAGES.length
    || !GENERATION_STAGES.every(stage => value.stages instanceof Array
      && value.stages.filter(s => record(s) && s.stage === stage && typeof s.available === 'boolean'
        && (s.reason === undefined || typeof s.reason === 'string')).length === 1)) {
    throw new Error('The local generation runner is offline. Start it for this workspace, then reconnect.');
  }
  return value as unknown as GenerationCapabilities;
}

export async function verifyOutput(bytes: ArrayBuffer, receipt: GenerationReceipt): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== receipt.output.bytes || hash !== receipt.output.sha256) {
    throw new Error('Generated file does not match its receipt');
  }
}

export const generationEntity = (id: string) => `urn:kbase:concept/generated-${id}`;
