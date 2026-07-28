import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFirefoxManifest } from './firefox-manifest';

export function buildFirefoxArtifact(
  firefoxDir = resolve('dist/extension-firefox'),
): void {
  const sourceManifestPath = resolve(firefoxDir, 'manifest.json');

  let sourceManifestText: string;
  try {
    sourceManifestText = readFileSync(sourceManifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Firefox extension build is missing: ${sourceManifestPath}`);
    }
    throw error;
  }

  const sourceManifest = JSON.parse(sourceManifestText);
  const firefoxManifest = createFirefoxManifest(sourceManifest);

  writeFileSync(
    sourceManifestPath,
    `${JSON.stringify(firefoxManifest, null, 2)}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  buildFirefoxArtifact();
}
