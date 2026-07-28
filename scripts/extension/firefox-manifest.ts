type ExtensionManifest = Record<string, any>;

const CHROME_ONLY_PERMISSIONS = new Set(['sidePanel', 'tabCapture', 'offscreen']);

export const FIREFOX_REQUIRED_DATA_COLLECTION = [
  'authenticationInfo',
  'browsingActivity',
  'websiteContent',
] as const;

/**
 * Derive the AMO artifact manifest from the canonical Chromium manifest.
 * Keeping this transformation deterministic prevents the browser packages'
 * versions and shared permissions from drifting apart.
 */
export function createFirefoxManifest(source: ExtensionManifest): ExtensionManifest {
  if (!Array.isArray(source.permissions)) {
    throw new Error('Extension manifest must contain a permissions array.');
  }

  const manifest = structuredClone(source);
  const gecko = manifest.browser_specific_settings?.gecko ?? {};

  manifest.permissions = manifest.permissions.filter(
    (permission: string) => !CHROME_ONLY_PERMISSIONS.has(permission),
  );
  manifest.background = {
    scripts: ['background.js'],
    type: 'module',
  };
  delete manifest.side_panel;

  manifest.sidebar_action = {
    default_title: manifest.action?.default_title ?? manifest.name,
    default_panel: 'sidepanel.html',
    default_icon: structuredClone(manifest.action?.default_icon ?? manifest.icons ?? {}),
  };
  manifest.browser_specific_settings = {
    ...manifest.browser_specific_settings,
    gecko: {
      ...gecko,
      strict_min_version: '142.0',
      data_collection_permissions: {
        required: [...FIREFOX_REQUIRED_DATA_COLLECTION],
      },
    },
  };

  return manifest;
}
