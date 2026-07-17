import { describe, it, expect } from 'vitest';
import {
  isIosWebkit,
  isMemoryConstrained,
  shouldAvoidInBrowserModel,
  CONSTRAINED_MODEL_MB_CAP,
  TINY_WASM_MODEL,
  type NavigatorLike,
} from '../device-capability';

const iphone: NavigatorLike = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605', platform: 'iPhone', maxTouchPoints: 5 };
const ipadOS: NavigatorLike = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605', platform: 'MacIntel', maxTouchPoints: 5 };
const firefoxIos: NavigatorLike = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 FxiOS/120', platform: 'iPhone', maxTouchPoints: 5 };
const desktopMac: NavigatorLike = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605', platform: 'MacIntel', maxTouchPoints: 0 };
const desktopChrome: NavigatorLike = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', platform: 'Win32', maxTouchPoints: 0, deviceMemory: 16 };
const androidLowMem: NavigatorLike = { userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/120', platform: 'Linux armv8l', maxTouchPoints: 5, deviceMemory: 3 };
const androidHiMem: NavigatorLike = { userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/120', platform: 'Linux armv8l', maxTouchPoints: 5, deviceMemory: 8 };

describe('isIosWebkit', () => {
  it('detects iPhone', () => expect(isIosWebkit(iphone)).toBe(true));
  it('detects iPadOS 13+ posing as MacIntel with touch', () => expect(isIosWebkit(ipadOS)).toBe(true));
  it('detects Firefox on iOS (still WebKit)', () => expect(isIosWebkit(firefoxIos)).toBe(true));
  it('does NOT flag a real desktop Mac (no touch)', () => expect(isIosWebkit(desktopMac)).toBe(false));
  it('does NOT flag desktop Chrome', () => expect(isIosWebkit(desktopChrome)).toBe(false));
});

describe('isMemoryConstrained', () => {
  it('iOS is always constrained', () => expect(isMemoryConstrained(iphone)).toBe(true));
  it('low-RAM Android is constrained', () => expect(isMemoryConstrained(androidLowMem)).toBe(true));
  it('high-RAM Android is not', () => expect(isMemoryConstrained(androidHiMem)).toBe(false));
  it('desktop is not', () => expect(isMemoryConstrained(desktopChrome)).toBe(false));
});

describe('shouldAvoidInBrowserModel', () => {
  it('avoids the ~500MB default on iOS', () => expect(shouldAvoidInBrowserModel(500, iphone)).toBe(true));
  it('permits the tiny ~182MB model on iOS (under the cap)', () => expect(shouldAvoidInBrowserModel(182, iphone)).toBe(false));
  it('permits even the big model on a roomy desktop', () => expect(shouldAvoidInBrowserModel(500, desktopChrome)).toBe(false));
  it('the cap sits between the tiny model and the default', () => {
    expect(182).toBeLessThan(CONSTRAINED_MODEL_MB_CAP);
    expect(500).toBeGreaterThan(CONSTRAINED_MODEL_MB_CAP);
  });
  it('names a concrete tiny model', () => expect(TINY_WASM_MODEL).toMatch(/SmolLM2-135M/));
});
