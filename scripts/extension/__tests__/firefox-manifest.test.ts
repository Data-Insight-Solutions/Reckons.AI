import { describe, expect, it } from 'vitest';
import {
  createFirefoxManifest,
  FIREFOX_REQUIRED_DATA_COLLECTION,
} from '../firefox-manifest';

const source = {
  manifest_version: 3,
  name: 'Reckons.AI',
  version: '0.1.0',
  permissions: [
    'activeTab',
    'scripting',
    'storage',
    'tabs',
    'sidePanel',
    'tabCapture',
    'offscreen',
  ],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  action: {
    default_title: 'Reckons.AI',
    default_icon: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
    },
  },
  browser_specific_settings: {
    gecko: {
      id: 'reckons-ai@extension',
      strict_min_version: '113.0',
    },
  },
};

describe('createFirefoxManifest', () => {
  it('uses Firefox background and sidebar declarations', () => {
    const manifest = createFirefoxManifest(source);

    expect(manifest.background).toEqual({
      scripts: ['background.js'],
      type: 'module',
    });
    expect(manifest).not.toHaveProperty('side_panel');
    expect(manifest.sidebar_action).toEqual({
      default_title: 'Reckons.AI',
      default_panel: 'sidepanel.html',
      default_icon: source.action.default_icon,
    });
  });

  it('removes APIs that are unavailable in Firefox', () => {
    const manifest = createFirefoxManifest(source);

    expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'tabs']);
  });

  it('declares the required data collection contract for Firefox 142+', () => {
    const manifest = createFirefoxManifest(source);

    expect(manifest.browser_specific_settings.gecko).toEqual({
      id: 'reckons-ai@extension',
      strict_min_version: '142.0',
      data_collection_permissions: {
        required: [...FIREFOX_REQUIRED_DATA_COLLECTION],
      },
    });
    expect(manifest.browser_specific_settings).not.toHaveProperty('gecko_android');
  });

  it('does not mutate the canonical Chromium manifest', () => {
    const before = structuredClone(source);

    createFirefoxManifest(source);

    expect(source).toEqual(before);
  });

  it('rejects malformed source manifests', () => {
    expect(() => createFirefoxManifest({ name: 'Broken' })).toThrow(
      'Extension manifest must contain a permissions array.',
    );
  });
});
