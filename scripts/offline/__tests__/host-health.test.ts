// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessDrives, collectHostChecks, listeners, parsePolicy, safeSummary, type ProbeIO } from '../lib/host-probes';
import { privateAuditDirectory, writePrivateAudit } from '../lib/private-audit';

const temps: string[] = [];
const temp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'host-audit-test-')); temps.push(d); return d; };
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const now = Date.UTC(2026, 0, 1);
function io(commands: Record<string, string> = {}, files: Record<string, string> = {}): ProbeIO {
  return { now, platform: 'linux', run: c => ({ stdout: commands[c] ?? '', code: c in commands ? 0 : null }), read: f => files[f] ?? null, stat: f => f in files ? { mtimeMs: now, size: files[f].length } : null };
}
const check = (fixture: ProbeIO, id: string, deep = false) => collectHostChecks(fixture, undefined, deep).find(c => c.id === id)!;

describe('honest host evidence', () => {
  it('retains high ports, UDP, and specific LAN bindings but excludes IPv4/IPv6 loopback', () => {
    const rows = listeners([
      'tcp LISTEN 0 10 0.0.0.0:49152 0.0.0.0:*',
      'tcp LISTEN 0 10 192.0.2.10:8443 0.0.0.0:*',
      'udp UNCONN 0 0 [::]:5353 [::]:*',
      'tcp LISTEN 0 10 127.0.0.1:4000 0.0.0.0:*',
      'tcp LISTEN 0 10 [::1]:4000 [::]:*',
      'tcp LISTEN 0 10 [::ffff:127.0.0.1]:4000 [::]:*',
    ].join('\n'));
    expect(rows?.map(r => r.port)).toEqual([49152, 8443, 5353]);
    expect(listeners('unexpected socket format')).toBeNull();
  });
  it('does not invent active firewall enforcement from boot config', () => {
    expect(check(io({}, { '/etc/ufw/ufw.conf': 'ENABLED=yes' }), 'firewall').status).toBe('unknown');
    expect(check(io({ ufw: 'Status: active' }), 'firewall').status).toBe('pass');
    expect(check(io({ ufw: 'Status: inactive' }), 'firewall').detail).toContain('other filtering');
  });
  it('reports Docker publications independently of UFW and pins the local socket', () => {
    const f = io({ docker: JSON.stringify({ Names: 'synthetic', State: 'running', Status: 'Up', Ports: '0.0.0.0:8443->80/tcp, [::]:8443->80/tcp' }), ufw: 'Status: active' });
    const calls: string[][] = [];
    const run = f.run; f.run = (c, args) => { if (c === 'docker') calls.push(args); return run(c, args); };
    expect(check(f, 'docker-ports').status).toBe('fail');
    expect(calls[0].slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
    expect(check(io({ docker: '{broken' }), 'docker-ports').status).toBe('unknown');
  });
  it('does not call a stale empty package cache patched', () => {
    expect(check(io({ apt: 'Listing...\n' }), 'security-updates').status).toBe('unknown');
    expect(check(io({ apt: 'sample/noble-security 1.2 amd64 [upgradable]' }), 'security-updates').status).toBe('fail');
  });
  it('keeps skipped integrity work and a failed scanner distinct from passing', () => {
    expect(check(io(), 'pkg-integrity').status).toBe('skipped');
    const f = io(); f.run = () => ({ stdout: '', code: 2 });
    expect(check(f, 'pkg-integrity', true).status).toBe('unknown');
    expect(check(io(), 'disk').status).toBe('unknown');
  });
  it('requires meaningful and fresh drive evidence, accepts zero-valued hex warnings', () => {
    for (const snapshot of ['{}', '{"drives":[]}', '{"drives":[{}]}', 'broken']) expect(assessDrives(snapshot, now, now).status).toBe('unknown');
    const good = JSON.stringify({ drives: [{ dev: 'synthetic-drive', health: 'PASSED', critical_warning: '0x00' }] });
    expect(assessDrives(good, now, now).status).toBe('pass');
    expect(assessDrives(good, now - 26 * 3_600_000, now).status).toBe('unknown');
    expect(assessDrives(good, now + 3_600_000, now).status).toBe('unknown');
    expect(assessDrives(JSON.stringify({ drives: [{ health: 'PASSED', media_errors: '2' }] }), now, now).status).toBe('fail');
    expect(assessDrives('{"drives":[{"health":"FAILED!"}]}', now, now).status).toBe('fail');
    expect(assessDrives('{"drives":[{"health":"PASSED","critical_warning":"broken"}]}', now, now).status).toBe('unknown');
  });
  it('makes unsupported platforms explicit and validates local policy', () => {
    expect(collectHostChecks({ ...io(), platform: 'darwin' })[0].status).toBe('skipped');
    expect(() => parsePolicy('{"allowedListeners":[{"protocol":"tcp","port":443}]}')).toThrow();
    expect(() => parsePolicy('{"criticalMounts":["relative"]}')).toThrow();
    expect(parsePolicy('{"allowedListeners":[{"protocol":"tcp","port":443,"reason":"Local test service"}]}').allowedListeners).toHaveLength(1);
  });
  it('checks a declared GNOME session and avoids inferring settings for other desktops', () => {
    const f = io(); f.desktop = 'GNOME';
    f.run = (_cmd, args) => ({ code: 0, stdout: args.includes('idle-delay') ? 'uint32 0' : 'true' });
    expect(check(f, 'screen-lock').status).toBe('fail');
    expect(check(io(), 'screen-lock').status).toBe('skipped');
  });
});

describe('device privacy boundary', () => {
  it('projects counts without disclosing arbitrary evidence', () => {
    const summary = safeSummary([{ id: 'private-device-name', status: 'fail', detail: 'SENTINEL_HOST_SECRET 192.0.2.10 /private/path' }]);
    expect(JSON.stringify(summary)).not.toMatch(/SENTINEL|192\.0\.2|private-device|private\/path/);
    expect(summary.counts.fail).toBe(1);
  });
  it('stores reports in mode 0600 under a mode 0700 directory', () => {
    const dir = privateAuditDirectory(temp());
    writePrivateAudit(dir, 'host-health.json', 'first');
    writePrivateAudit(dir, 'host-health.json', 'second');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'host-health.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, 'host-health.json'), 'utf8')).toBe('second');
  });
  it('refuses repository outputs, linked worktrees, symlinked ancestors, and symlinked targets', () => {
    const root = temp(); mkdirSync(path.join(root, '.git'));
    expect(() => privateAuditDirectory(root)).toThrow(/checkout/);
    const linked = temp(); writeFileSync(path.join(linked, '.git'), 'gitdir: /synthetic');
    expect(() => privateAuditDirectory(linked)).toThrow(/checkout/);
    const state = temp(), link = path.join(temp(), 'state'); symlinkSync(state, link);
    expect(() => privateAuditDirectory(link)).toThrow(/symlink/);
    const dir = privateAuditDirectory(state), target = path.join(temp(), 'keep'); writeFileSync(target, 'unchanged');
    symlinkSync(target, path.join(dir, 'host-health.json'));
    expect(() => writePrivateAudit(dir, 'host-health.json', 'overwrite')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });
  it('CLI keeps probe evidence and pending proposals out of stdout and the repository queue', () => {
    const root = process.cwd(), state = temp(), config = temp(), bin = temp();
    writeFileSync(path.join(bin, 'ss'), '#!/bin/sh\nprintf "tcp LISTEN 0 10 192.0.2.77:45678 0.0.0.0:*\\n"\n', { mode: 0o700 });
    const queue = path.join(root, 'reckons-workspace/knowledge.pending.jsonl');
    let before: string | null; try { before = readFileSync(queue, 'utf8'); } catch { before = null; }
    const stdout = execFileSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/offline/host-health.ts', '--pending', '--json'], { cwd: root, env: { ...process.env, PATH: bin, XDG_STATE_HOME: state, XDG_CONFIG_HOME: config }, encoding: 'utf8' });
    expect(stdout).not.toContain('192.0.2.77'); expect(stdout).not.toContain('45678');
    expect(JSON.parse(stdout).counts.fail).toBeGreaterThan(0);
    const report = readFileSync(path.join(state, 'reckons/security-audit/host-health.json'), 'utf8');
    const pending = readFileSync(path.join(state, 'reckons/security-audit/host-health.pending.jsonl'), 'utf8');
    expect(report).toContain('192.0.2.77'); expect(pending).toContain('192.0.2.77');
    let after: string | null; try { after = readFileSync(queue, 'utf8'); } catch { after = null; }
    expect(after).toBe(before);
  });
});
