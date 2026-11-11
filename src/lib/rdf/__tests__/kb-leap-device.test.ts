import { describe, it, expect } from 'vitest';
import {
  classifyLeap,
  deviceLeapTarget,
  parseDeviceLeap,
  resolveDeviceLeap,
  DEVICE_SPACE_RESERVED,
} from '../kb-leap';

// Synthetic identifiers only — no real job names, no device ids, no home-directory paths.
const JOB_ID = 'job-abc';
const DEVICE_SPACE_ID = 'kbase_device';
const FAKE_DEVICE_ID = 'device-xyz-987';
// Anywhere in the string: a device-leap target must not embed a stable id (UUID) either.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('F269.2 device leap helpers (kb-leap)', () => {
  it('deviceLeapTarget builds an app path that carries the reserved name and the job, and no device id or stable id', () => {
    const target = deviceLeapTarget(JOB_ID);
    expect(target.startsWith('/')).toBe(true);
    // classifyLeap must still read it as an in-app leap (kb:job-definition-leap).
    expect(classifyLeap(target)).toBe('app');
    expect(target).toContain(DEVICE_SPACE_RESERVED);
    expect(target).toContain(JOB_ID);
    // THE LEAP NAMES NO DEVICE: no embedded stable id, and not a particular device's id.
    expect(UUID_RE.test(target)).toBe(false);
    expect(target).not.toContain(FAKE_DEVICE_ID);
  });

  it('parseDeviceLeap reads the job id back from the target', () => {
    expect(parseDeviceLeap(deviceLeapTarget(JOB_ID))).toEqual({ jobId: JOB_ID });
  });

  it('resolveDeviceLeap with a device space opens that space selecting the job', () => {
    expect(resolveDeviceLeap(deviceLeapTarget(JOB_ID), DEVICE_SPACE_ID)).toEqual({
      kind: 'open',
      spaceId: DEVICE_SPACE_ID,
      select: JOB_ID,
    });
  });

  it('resolveDeviceLeap with no device space says so plainly and goes nowhere', () => {
    expect(resolveDeviceLeap(deviceLeapTarget(JOB_ID), null)).toEqual({ kind: 'no-device-space' });
  });

  it('an ordinary leap target parses as null, so a device leap stays distinct from the rest', () => {
    // a space's stable id — a kb leap, not an in-app path
    expect(parseDeviceLeap('a1b2c3d4-e5f6-4a0a-b00a-000000000010')).toBeNull();
    // an external URL
    expect(parseDeviceLeap('https://example.org/reckons')).toBeNull();
    // an app path that names a real space, not the reserved device name
    expect(parseDeviceLeap('/?kb=roadmap&f=proposed')).toBeNull();
    // an app path that names the reserved space but selects no job
    expect(parseDeviceLeap('/?kb=this-device')).toBeNull();
  });
});
