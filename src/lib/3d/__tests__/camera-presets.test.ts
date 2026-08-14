import { describe, it, expect } from 'vitest';
import {
  parseCameraSpec,
  cameraPosition,
  revealsDepth,
  isCameraPreset,
  CAMERA_PRESETS,
} from '../camera-presets';

describe('parseCameraSpec', () => {
  it('returns null when absent, so the caller keeps its own default', () => {
    expect(parseCameraSpec(null)).toBeNull();
    expect(parseCameraSpec(undefined)).toBeNull();
    expect(parseCameraSpec('')).toBeNull();
    expect(parseCameraSpec('   ')).toBeNull();
  });

  it('resolves preset names, case-insensitively', () => {
    expect(parseCameraSpec('iso')).toEqual(CAMERA_PRESETS.iso);
    expect(parseCameraSpec('ISO')).toEqual(CAMERA_PRESETS.iso);
    expect(parseCameraSpec(' Top ')).toEqual(CAMERA_PRESETS.top);
  });

  it('parses an explicit azimuth,elevation[,distance] triple', () => {
    expect(parseCameraSpec('35,25,20')).toEqual({ azimuth: 35, elevation: 25, distance: 20 });
    expect(parseCameraSpec('90,0')).toEqual({ azimuth: 90, elevation: 0, distance: 18 });
  });

  it('returns null on garbage rather than silently defaulting', () => {
    // A typo that quietly moved the camera would produce a visual baseline captured from an
    // unintended angle — broken, but still passing.
    expect(parseCameraSpec('sideways')).toBeNull();
    expect(parseCameraSpec('35')).toBeNull();
    expect(parseCameraSpec('a,b')).toBeNull();
    expect(parseCameraSpec('1,2,3,4')).toBeNull();
    expect(parseCameraSpec('35,NaN')).toBeNull();
  });

  it('clamps elevation short of the pole so the scene never flips upside down', () => {
    expect(parseCameraSpec('0,180')!.elevation).toBeCloseTo(89.9);
    expect(parseCameraSpec('0,-180')!.elevation).toBeCloseTo(-89.9);
  });

  it('clamps distance to something renderable', () => {
    expect(parseCameraSpec('0,0,0')!.distance).toBe(1);
    expect(parseCameraSpec('0,0,99999')!.distance).toBe(500);
  });
});

describe('cameraPosition', () => {
  it('reproduces the historical hardcoded camera exactly for the front preset', () => {
    // The original was position={[0, 0, 18]}; every existing screenshot baseline assumes it.
    const [x, y, z] = cameraPosition(CAMERA_PRESETS.front);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(18);
  });

  it('lifts the camera on y for elevation', () => {
    const [, y] = cameraPosition({ azimuth: 0, elevation: 90, distance: 10 });
    expect(y).toBeCloseTo(10);
  });

  it('swings around y for azimuth', () => {
    const [x, , z] = cameraPosition({ azimuth: 90, elevation: 0, distance: 10 });
    expect(x).toBeCloseTo(10);
    expect(z).toBeCloseTo(0);
  });

  it('keeps the requested distance from the origin at any angle', () => {
    for (const spec of [CAMERA_PRESETS.iso, CAMERA_PRESETS.top, CAMERA_PRESETS.side]) {
      const [x, y, z] = cameraPosition(spec);
      expect(Math.hypot(x, y, z)).toBeCloseTo(spec.distance, 5);
    }
  });
});

describe('revealsDepth', () => {
  it('says the default front camera CANNOT see depth', () => {
    // This is the finding that motivated the module: every visual baseline to date was shot
    // from an angle where a z regression is invisible.
    expect(revealsDepth(CAMERA_PRESETS.front)).toBe(false);
  });

  it('says iso, top and side can', () => {
    expect(revealsDepth(CAMERA_PRESETS.iso)).toBe(true);
    expect(revealsDepth(CAMERA_PRESETS.top)).toBe(true);
    expect(revealsDepth(CAMERA_PRESETS.side)).toBe(true);
  });

  it('treats looking up the far side of the axis as equally blind', () => {
    expect(revealsDepth({ azimuth: 180, elevation: 0, distance: 18 })).toBe(false);
    expect(revealsDepth({ azimuth: 360, elevation: 0, distance: 18 })).toBe(false);
  });

  it('counts a small but real tilt as revealing', () => {
    expect(revealsDepth({ azimuth: 0, elevation: 20, distance: 18 })).toBe(true);
    expect(revealsDepth({ azimuth: 2, elevation: 2, distance: 18 })).toBe(false);
  });
});

describe('isCameraPreset', () => {
  it('accepts known names and rejects others', () => {
    expect(isCameraPreset('iso')).toBe(true);
    expect(isCameraPreset('nope')).toBe(false);
    expect(isCameraPreset('toString')).toBe(false); // prototype keys must not leak through
  });
});
