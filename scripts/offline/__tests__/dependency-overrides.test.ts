// @vitest-environment node

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  it('keeps patched Undici request handling compatible without network access', async () => {
    const require = createRequire(import.meta.url);
    expect(versionAtLeast(require('undici/package.json').version, '7.29.1')).toBe(true);
    const { MockAgent, fetch } = require('undici');
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    dispatcher.get('https://example.test').intercept({ path: '/health' }).reply(200, 'healthy');
    try {
      const response = await fetch('https://example.test/health', { dispatcher });
      expect(await response.text()).toBe('healthy');
    } finally { await dispatcher.close(); }
  });
  it('refuses ZIP extraction through existing directory and file symlinks', async () => {
    const require = createRequire(import.meta.url);
    const AdmZip = require('adm-zip');
    const directory = await makeTemporaryDirectory('reckons-zip-symlink-');
    const destination = path.join(directory, 'destination');
    const outside = path.join(directory, 'outside');
    await mkdir(destination);
    await mkdir(outside);
    const protectedPath = path.join(outside, 'runtime.node');
    await writeFile(protectedPath, 'original');
    await symlink(outside, path.join(destination, 'native'), 'dir');
    await symlink(protectedPath, path.join(destination, 'runtime.node'), 'file');
    for (const name of ['native/runtime.node', 'runtime.node']) {
      const archive = new AdmZip(Buffer.from(zipSync({ [name]: strToU8('replacement') })));
      expect(() => archive.extractEntryTo(name, destination, true, true)).toThrow();
      expect(await readFile(protectedPath, 'utf8')).toBe('original');
    }
  });

  it('reads a stored ZIP entry without allocating its bogus declared size', () => {
    const require = createRequire(import.meta.url);
    const AdmZip = require('adm-zip');
    const bytes = Buffer.from(zipSync({ 'small.txt': strToU8('small') }, { level: 0 }));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0x7fffffff, 22); // local uncompressed size
    bytes.writeUInt32LE(0x7fffffff, central + 24);
    const allocate = Buffer.alloc;
    // Fail safely even if a future downgrade reintroduces the eager allocation.
    const spy = vi.spyOn(Buffer, 'alloc').mockImplementation((size, ...args) => {
      if (size > 1_000_000) throw new Error('test prevented oversized allocation');
      return allocate(size, ...args);
    });
    try {
      expect(new AdmZip(bytes).getEntry('small.txt').getData().toString()).toBe('small');
      expect(spy.mock.calls.every(([size]) => size < 1_000_000)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

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
    expect(versionAtLeast(admZipPackage.version, '0.6.1')).toBe(true);

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

  it('keeps filelist working on the patched Minimatch 11 line', () => {
    const filelistRequire = createRequire(
      path.join(process.cwd(), 'node_modules/filelist/index.js')
    );
    const minimatchPackage = filelistRequire('minimatch/package.json') as {
      version: string;
    };
    expect(versionAtLeast(minimatchPackage.version, '11.0.1')).toBe(true);

    const minimatch = filelistRequire('minimatch') as {
      match: unknown;
      minimatch(candidate: string, pattern: string): boolean;
    };
    expect(typeof minimatch.match).toBe('function');
    expect(minimatch.minimatch('src/graph.ts', 'src/{graph,review}.ts')).toBe(true);

    const { FileList } = filelistRequire('filelist') as {
      FileList: new () => { include(pattern: string): void; toArray(): string[] };
    };
    const fileList = new FileList();
    fileList.include('package*.json');
    expect(fileList.toArray()).toContain('package.json');
  });

  it('keeps workbox-build on the patched glob line', () => {
    const workboxRequire = createRequire(
      path.join(process.cwd(), 'node_modules/workbox-build/package.json')
    );
    const globPackage = workboxRequire('glob/package.json') as { version: string };
    expect(versionAtLeast(globPackage.version, '14.0.2')).toBe(true);
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
    expect(versionAtLeast(bracePackage.version, '5.0.9')).toBe(true);

    const { minimatch } = modernMinimatchRequire('minimatch') as {
      minimatch(candidate: string, pattern: string): boolean;
    };
    expect(minimatch('assets/icon.png', 'assets/*.{png,svg}')).toBe(true);
  });
});
