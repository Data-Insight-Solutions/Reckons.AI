// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { generationStatements } from '../attach';
import { parseRequest, type GenerationJob, type GenerationReceipt, type GenerationRequest } from '../protocol';

const request: GenerationRequest = {
  version: 1, id: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', spaceId: 'demo', stage: 'image',
  prompt: 'An illustration of a harbor', seed: 7, forEntity: 'urn:t:hub',
};
const receipt: GenerationReceipt = {
  stage: 'image', tool: { name: 'fixture', version: '1', license: 'MIT' },
  models: [{ file: 'fixture', sha256: 'a'.repeat(64), license: 'MIT' }],
  input: { prompt: request.prompt }, settings: { seed: 7 }, ranAt: '2026-11-18T12:00:00Z',
  durationS: 1, output: { file: 'image.webp', sha256: 'a'.repeat(64), bytes: 3 }, check: { pass: true },
};
const job = (r: GenerationRequest): GenerationJob => ({ request: r, state: 'completed', receipt });

describe('hub assets (F278)', () => {
  it('keeps forEntity through parseRequest and rejects an empty one', () => {
    expect(parseRequest(request).forEntity).toBe('urn:t:hub');
    expect(() => parseRequest({ ...request, forEntity: '' })).toThrow();
  });
  it('offers a generated image to its hub as pending rows only, with a receipt-backed entity', () => {
    const rows = generationStatements(job(request), 'data:image/webp;base64,AAAA');
    const forHub = rows.filter((r) => r.s.kind === 'iri' && r.s.value === 'urn:t:hub');
    expect(forHub.map((r) => r.p.value)).toEqual(['urn:kbase:predicate/photo', 'urn:kbase:predicate/generated-asset']);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.some((r) => r.p.value === 'urn:kbase:predicate/generated-with')).toBe(true);
  });
  it('adds nothing for a hub when the job was not made for one', () => {
    const { forEntity: _drop, ...free } = request;
    const rows = generationStatements(job(free as GenerationRequest), 'data:image/webp;base64,AAAA');
    expect(rows.some((r) => r.s.kind === 'iri' && r.s.value === 'urn:t:hub')).toBe(false);
  });
});
