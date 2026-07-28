// @vitest-environment node

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('security dependency overrides', () => {
  it('keeps the Sharp image operations used by Node tooling compatible', async () => {
    const require = createRequire(import.meta.url);
    const sharpPackage = JSON.parse(
      await readFile(
        path.join(path.dirname(require.resolve('sharp')), '..', 'package.json'),
        'utf8'
      )
    ) as { version: string };
    expect(versionAtLeast(sharpPackage.version, '0.35.0')).toBe(true);

    const source = await sharp(
      Buffer.from([
        255, 0, 0, 255,
        0, 255, 0, 255
      ]),
      { raw: { width: 2, height: 1, channels: 4 } }
    )
      .png()
      .toBuffer();

    const metadata = await sharp(source).metadata();
    expect(metadata).toMatchObject({ width: 2, height: 1, format: 'png' });

    const rotated = await sharp(source)
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(rotated.info).toMatchObject({ width: 2, height: 1, channels: 4 });

    const outputDirectory = await makeTemporaryDirectory('reckons-sharp-');
    const outputPath = path.join(outputDirectory, 'output.png');
    await sharp(source).toFile(outputPath);
    expect((await readFile(outputPath)).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it('preserves the AdmZip API used by onnxruntime-node installation', async () => {
    const onnxRequire = createRequire(
      path.join(process.cwd(), 'node_modules/onnxruntime-node/script/install-utils.js')
    );
    const AdmZip = onnxRequire('adm-zip') as new (path?: string) => {
      extractEntryTo(
        entry: unknown,
        targetPath: string,
        maintainEntryPath: boolean,
        overwrite: boolean
      ): boolean;
      getEntry(name: string): unknown;
    };
    const admZipPackage = onnxRequire('adm-zip/package.json') as { version: string };
    expect(versionAtLeast(admZipPackage.version, '0.6.0')).toBe(true);

    const workingDirectory = await makeTemporaryDirectory('reckons-adm-zip-');
    const archivePath = path.join(workingDirectory, 'runtime.nupkg');
    const payload = 'onnx-runtime-payload';
    await writeFile(
      archivePath,
      zipSync({
        'runtimes/linux/native/runtime.node': strToU8(payload)
      })
    );

    const reopenedArchive = new AdmZip(archivePath);
    const entry = reopenedArchive.getEntry('runtimes/linux/native/runtime.node');
    expect(entry).toBeTruthy();

    const extractionDirectory = path.join(workingDirectory, 'extracted');
    await mkdir(extractionDirectory);
    expect(reopenedArchive.extractEntryTo(entry, extractionDirectory, false, true)).toBe(true);
    expect(
      (await readFile(path.join(extractionDirectory, 'runtime.node'))).toString()
    ).toBe(payload);
  });

  it('keeps Minimatch 5 on the compatible patched brace-expansion line', () => {
    // GHSA-mh99-v99m-4gvg was backported to 2.x in 2.1.3. Forcing 5.x here
    // would break Minimatch 5, which requires brace-expansion as a function.
    const minimatchRequire = createRequire(
      path.join(process.cwd(), 'node_modules/filelist/node_modules/minimatch/minimatch.js')
    );
    const bracePackage = minimatchRequire('brace-expansion/package.json') as {
      version: string;
    };
    expect(versionAtLeast(bracePackage.version, '2.1.3')).toBe(true);

    const minimatch = minimatchRequire('minimatch') as (
      candidate: string,
      pattern: string
    ) => boolean;
    expect(minimatch('src/graph.ts', 'src/{graph,review}.ts')).toBe(true);

    const expand = minimatchRequire('brace-expansion') as (
      pattern: string,
      options?: { max?: number; maxLength?: number }
    ) => string[];
    const bounded = expand('{alpha,beta}'.repeat(20), { maxLength: 1_000 });
    expect(bounded.reduce((total, value) => total + value.length, 0)).toBeLessThanOrEqual(1_000);
  });

  it('keeps Workbox globbing on the patched modern brace-expansion line', () => {
    const modernMinimatchRequire = createRequire(
      path.join(
        process.cwd(),
        'node_modules/glob/node_modules/minimatch/dist/commonjs/index.js'
      )
    );
    const bracePackage = modernMinimatchRequire('brace-expansion/package.json') as {
      version: string;
    };
    expect(versionAtLeast(bracePackage.version, '5.0.8')).toBe(true);

    const { minimatch } = modernMinimatchRequire('minimatch') as {
      minimatch(candidate: string, pattern: string): boolean;
    };
    expect(minimatch('assets/icon.png', 'assets/*.{png,svg}')).toBe(true);
  });
});
