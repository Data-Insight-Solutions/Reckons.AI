import { describe, expect, it } from 'vitest';
import { openShellyOn, setShellyChatOpen, shellyChatOpen, shellyOpenTab, shellyTabParam } from '../shelly-bridge.svelte';

/**
 * shelly=learn|chat|explore (F309 view parameter; Matt, 2026-11-25: "We need to auto open Shelly"). A link or a
 * story step names the tab by the word on it; "learn" is the tab called tutorial in code.
 */
describe('the shelly= view parameter', () => {
  it('names a tab by the word on it, and nothing else', () => {
    expect(shellyTabParam('learn')).toBe('tutorial');
    expect(shellyTabParam('chat')).toBe('chat');
    expect(shellyTabParam('explore')).toBe('explore');
    for (const v of [null, '', 'tutorial', 'Learn', '1', 'open']) expect(shellyTabParam(v), String(v)).toBeNull();
  });

  it('opens Shelly on that tab, and closing her forgets it', () => {
    openShellyOn('tutorial');
    expect(shellyChatOpen()).toBe(true);
    expect(shellyOpenTab()).toBe('tutorial');
    setShellyChatOpen(false);
    expect(shellyChatOpen()).toBe(false);
    expect(shellyOpenTab()).toBeNull();
  });
});
