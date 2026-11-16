/**
 * Type representing an application that can open files
 */
export type OpenInApp = {
  id: string;
  label: string;
  command: string;
  handles: string[];
};

/**
 * Known applications and their supported file extensions
 */
export const KNOWN_APPS: OpenInApp[] = [
  {
    id: 'inkscape',
    label: 'Inkscape',
    command: 'inkscape',
    handles: ['svg', 'pdf']
  },
  {
    id: 'gimp',
    label: 'GIMP',
    command: 'gimp',
    handles: ['png', 'jpg', 'jpeg', 'webp']
  },
  {
    id: 'blender',
    label: 'Blender',
    command: 'blender',
    handles: ['glb', 'gltf', 'obj', 'fbx']
  },
  {
    id: 'artcraft',
    label: 'ArtCraft',
    command: 'artcraft',
    handles: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'glb']
  }
];

/**
 * Find all applications that can handle a given file name
 * @param fileName - The name of the file to check
 * @param apps - Optional list of apps to check (defaults to KNOWN_APPS)
 * @returns Array of apps that can handle the file extension, or empty array if none
 */
export function appsFor(fileName: string, apps: OpenInApp[] = KNOWN_APPS): OpenInApp[] {
  const extension = fileName.split('.').pop()?.toLowerCase();

  if (!extension) {
    return [];
  }

  // Return only the first app that handles this extension (in KNOWN_APPS order)
  const matchingApps = apps.filter(app => app.handles.includes(extension));
  return matchingApps.length > 0 ? [matchingApps[0]] : [];
}

/**
 * Find the default application for a file based on user defaults and available apps
 * @param fileName - The name of the file to check
 * @param defaults - User-defined defaults mapping extension to app id
 * @param apps - Optional list of apps to consider (defaults to KNOWN_APPS)
 * @returns The default app if found and it handles the type, otherwise the first available app, or undefined
 */
export function defaultAppFor(
  fileName: string,
  defaults: Record<string, string>,
  apps: OpenInApp[] = KNOWN_APPS
): OpenInApp | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase();

  if (!extension) {
    return undefined;
  }

  // Check if user has a default for this extension and that app can handle it
  const defaultAppId = defaults[extension];
  if (defaultAppId) {
    const defaultApp = apps.find(app => app.id === defaultAppId);
    if (defaultApp && defaultApp.handles.includes(extension)) {
      return defaultApp;
    }
  }

  // Return the first app that can handle this extension
  const availableApps = appsFor(fileName, apps);
  return availableApps.length > 0 ? availableApps[0] : undefined;
}

/**
 * Generate command and arguments to open a file with a specific application
 * @param app - The application to use
 * @param absolutePath - The absolute path to the file
 * @returns Object with command and args for execution
 */
export function openInCommand(app: OpenInApp, absolutePath: string): { command: string; args: string[] } {
  return {
    command: app.command,
    args: [absolutePath]
  };
}