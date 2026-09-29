// @vitest-environment node
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { writeGeneratedSite } from '../lib/site-output';

const directories: string[] = [];
function temporary() { const dir = mkdtempSync(path.join(tmpdir(), 'reckons-publish-')); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const graph = '<urn:example:home> a <urn:kbase:type/WebPage>; <urn:reckons:page/status> "published"; <urn:reckons:page/slug> "home"; <http://www.w3.org/2000/01/rdf-schema#label> "Example" .';

describe('publish output containment', () => {
  it('stages a site and replaces only a previously owned output', () => {
    const cwd = temporary();
    const output = writeGeneratedSite('output', { 'index.html': 'first', 'old/index.html': 'old' }, { cwd });
    writeGeneratedSite('output', { 'index.html': 'second', 'new/index.html': 'new' }, { cwd });
    expect(readFileSync(path.join(output, 'index.html'), 'utf8')).toBe('second');
    expect(existsSync(path.join(output, 'old'))).toBe(false);
    expect(readdirSync(cwd)).toEqual(['output']);
  });

  it.each(['.', '..', '/', '../outside', 'a/../output', './output', 'a\\b'])('rejects dangerous output %s', (output) => {
    const cwd = temporary();
    writeFileSync(path.join(cwd, 'keep.txt'), 'keep');
    expect(() => writeGeneratedSite(output, { 'index.html': 'new' }, { cwd })).toThrow();
    expect(readFileSync(path.join(cwd, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses an unowned directory and extra files inside an owned directory', () => {
    const cwd = temporary();
    mkdirSync(path.join(cwd, 'source'));
    writeFileSync(path.join(cwd, 'source/keep.txt'), 'keep');
    expect(() => writeGeneratedSite('source', { 'index.html': 'new' }, { cwd })).toThrow('not owned');
    const output = writeGeneratedSite('output', { 'index.html': 'old' }, { cwd });
    writeFileSync(path.join(output, 'personal.txt'), 'keep');
    expect(() => writeGeneratedSite('output', { 'index.html': 'new' }, { cwd })).toThrow('Unowned');
    expect(readFileSync(path.join(output, 'index.html'), 'utf8')).toBe('old');
    expect(readFileSync(path.join(output, 'personal.txt'), 'utf8')).toBe('keep');
  });

  it('rejects symlinked parents, outputs, files and dangling links', () => {
    const cwd = temporary(); const outside = temporary();
    symlinkSync(outside, path.join(cwd, 'link'), 'dir');
    symlinkSync(path.join(outside, 'missing'), path.join(cwd, 'dangling'), 'dir');
    for (const output of ['link', 'link/output', 'dangling']) {
      expect(() => writeGeneratedSite(output, { 'index.html': 'new' }, { cwd })).toThrow();
    }
    const output = writeGeneratedSite('output', { 'index.html': 'old' }, { cwd });
    rmSync(path.join(output, 'index.html'));
    const protectedFile = path.join(outside, 'keep.txt'); writeFileSync(protectedFile, 'keep');
    symlinkSync(protectedFile, path.join(output, 'index.html'));
    expect(() => writeGeneratedSite('output', { 'index.html': 'new' }, { cwd })).toThrow('Symlink');
    expect(readFileSync(protectedFile, 'utf8')).toBe('keep');
  });

  it('validates every filename and preserves the original when staging cannot proceed', () => {
    const cwd = temporary();
    const output = writeGeneratedSite('output', { 'index.html': 'old' }, { cwd });
    for (const file of ['../escape', '/absolute', 'a\\b', 'a/../../escape']) {
      expect(() => writeGeneratedSite('output', { [file]: 'new' }, { cwd })).toThrow();
    }
    expect(() => writeGeneratedSite('output', { 'a': 'file', 'a/b': 'conflict' }, { cwd })).toThrow();
    expect(() => writeGeneratedSite('output', { 'index.html': 'new' }, { cwd, inputFile: path.join(output, 'index.html') })).toThrow('Input graph');
    expect(readFileSync(path.join(output, 'index.html'), 'utf8')).toBe('old');
  });

  it('runs the deploy CLI with literal arguments, without executing shell-shaped output text', () => {
    const cwd = temporary();
    const bin = path.join(cwd, 'bin'); mkdirSync(bin);
    const argvFile = path.join(cwd, 'argv.json');
    writeFileSync(path.join(bin, 'wrangler'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARGV_RECORD, JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
    const input = path.join(cwd, 'graph.ttl'); writeFileSync(input, graph);
    const output = 'site $(touch SHELL_EXECUTED)';
    execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/publish-site.ts'), input,
      `--out=${output}`, '--project=fixture', '--deploy'], {
      cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARGV_RECORD: argvFile }, stdio: 'pipe', timeout: 15000,
    });
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['pages', 'deploy', path.join(cwd, output), '--project-name=fixture']);
    expect(existsSync(path.join(cwd, 'SHELL_EXECUTED'))).toBe(false);
    expect(readFileSync(path.join(cwd, output, 'index.html'), 'utf8')).toContain('Content-Security-Policy');
  });
});
