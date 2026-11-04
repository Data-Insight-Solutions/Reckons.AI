import { describe, expect, it } from 'vitest';
import { buildJobsSection } from '../turtle-chat';
import type { KBContext } from '$lib/types/turtle-chat';

const ctx = (localJobs?: KBContext['localJobs']): KBContext => ({
  statementCount: 0, sourceCount: 0, typesPresent: [], untypedEntityCount: 0, manualStatementCount: 0, sampleEntities: [], localJobs,
});

describe("Shelly's local jobs section (F166.1.2)", () => {
  it('without a runner, says what is needed instead of claiming generation is impossible', () => {
    const text = buildJobsSection(ctx());
    expect(text).toContain('no local generation runner is connected');
    expect(text).toContain('Do not say you are unable to make images in principle');
    expect(text).toContain('do not propose queue_jobs');
  });
  it('offers only the stages the runner reports, and names what is missing', () => {
    const text = buildJobsSection(ctx({ stages: [{ stage: 'image', available: true }, { stage: 'video', available: false, reason: 'video model missing' }, { stage: 'splat', available: true }] }));
    expect(text).toContain('can make: image, splat');
    expect(text).toContain('video (video model missing)');
    expect(text).toContain('"type":"queue_jobs"');
  });
  it('with a runner that can do nothing, proposes nothing', () => {
    const text = buildJobsSection(ctx({ stages: [{ stage: 'image', available: false, reason: 'x' }] }));
    expect(text).toContain('nothing can run');
    expect(text).not.toContain('"type":"queue_jobs"');
  });
});
