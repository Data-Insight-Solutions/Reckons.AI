import { describe, expect, it, vi } from 'vitest';
import {
  openComparisonSurface,
  supportsLiveCapture,
  type ExtensionCapabilities,
} from '../capabilities';

describe('supportsLiveCapture', () => {
  it('requires every API used by the live audio pipeline', () => {
    const api: ExtensionCapabilities = {
      runtime: { getContexts: vi.fn() },
      offscreen: { createDocument: vi.fn(), closeDocument: vi.fn() },
      tabCapture: { getMediaStreamId: vi.fn() },
    };

    expect(supportsLiveCapture(api)).toBe(true);
    delete api.offscreen;
    expect(supportsLiveCapture(api)).toBe(false);
  });
});

describe('openComparisonSurface', () => {
  it('prefers the Chromium side panel', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const sidebarOpen = vi.fn().mockResolvedValue(undefined);

    await expect(openComparisonSurface({
      sidePanel: { open },
      sidebarAction: { open: sidebarOpen },
    }, 42)).resolves.toBe('side-panel');
    expect(open).toHaveBeenCalledWith({ tabId: 42 });
    expect(sidebarOpen).not.toHaveBeenCalled();
  });

  it('uses the native Firefox sidebar when available', async () => {
    const open = vi.fn().mockResolvedValue(undefined);

    await expect(openComparisonSurface({
      sidebarAction: { open },
    }, 42)).resolves.toBe('sidebar');
    expect(open).toHaveBeenCalledOnce();
  });

  it('falls through when a browser panel rejects the open request', async () => {
    const sidePanelOpen = vi.fn().mockRejectedValue(new Error('not allowed'));
    const sidebarOpen = vi.fn().mockResolvedValue(undefined);

    await expect(openComparisonSurface({
      sidePanel: { open: sidePanelOpen },
      sidebarAction: { open: sidebarOpen },
    }, 42)).resolves.toBe('sidebar');
    expect(sidebarOpen).toHaveBeenCalledOnce();
  });

  it('falls back to a regular tab when browser panels are unavailable', async () => {
    const create = vi.fn();

    await expect(openComparisonSurface({
      runtime: { getURL: (path) => `moz-extension://test/${path}` },
      tabs: { create },
    })).resolves.toBe('tab');
    expect(create).toHaveBeenCalledWith({
      url: 'moz-extension://test/sidepanel.html',
      active: true,
    });
  });

  it('falls back to a regular tab when the Firefox sidebar rejects', async () => {
    const create = vi.fn();

    await expect(openComparisonSurface({
      runtime: { getURL: (path) => `moz-extension://test/${path}` },
      sidebarAction: { open: vi.fn().mockRejectedValue(new Error('not allowed')) },
      tabs: { create },
    })).resolves.toBe('tab');
    expect(create).toHaveBeenCalledOnce();
  });
});
