/** Local, read-only Linux probes. Details are private; callers must not log this report in CI. */
export type Status = 'pass' | 'fail' | 'unknown' | 'skipped';
export type Check = { id: string; status: Status; detail: string };
export type Command = { stdout: string; code: number | null };
export interface ProbeIO {
  run(command: string, args: string[], timeout?: number): Command;
  read(file: string): string | null;
  stat(file: string): { mtimeMs: number; size: number } | null;
  now: number;
  platform: string;
  desktop?: string;
}
export interface HostPolicy {
  allowedListeners: { protocol: 'tcp' | 'udp'; port: number; reason: string }[];
  criticalMounts: string[];
}
export const DEFAULT_POLICY: HostPolicy = { allowedListeners: [], criticalMounts: [] };

export function parsePolicy(text: string): HostPolicy {
  const p = JSON.parse(text);
  if (!p || typeof p !== 'object' || Array.isArray(p) ||
      Object.keys(p).some(k => !['allowedListeners', 'criticalMounts'].includes(k))) throw new Error('Invalid host policy');
  const allowedListeners = p.allowedListeners ?? [];
  const criticalMounts = p.criticalMounts ?? [];
  if (!Array.isArray(allowedListeners) || !Array.isArray(criticalMounts) ||
      allowedListeners.some(v => !v || !['tcp', 'udp'].includes(v.protocol) ||
        !Number.isInteger(v.port) || v.port < 1 || v.port > 65535 ||
        typeof v.reason !== 'string' || !v.reason.trim() || v.reason.length > 200) ||
      criticalMounts.some(v => typeof v !== 'string' || !v.startsWith('/') || /[\r\n\0]/.test(v))) {
    throw new Error('Invalid host policy');
  }
  return { allowedListeners, criticalMounts };
}

/** ss -H -lntu: preserve high ports and specific interface bindings, including IPv6. */
export function listeners(text: string): { protocol: string; port: number; address: string }[] | null {
  const result = [];
  for (const line of text.split('\n').filter(l => l.trim())) {
    const cols = line.trim().split(/\s+/);
    if (!['tcp', 'udp'].includes(cols[0]) || cols.length < 6) return null;
    const endpoint = cols[4].match(/^(.*):(\d+)$/);
    if (!endpoint) return null;
    const address = endpoint[1].replace(/^\[|\]$/g, '').split('%')[0];
    const port = Number(endpoint[2]);
    if (port < 1 || port > 65535) return null;
    if (/^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address)) continue;
    result.push({ protocol: cols[0], port, address });
  }
  return result;
}

export function assessDrives(text: string | null, mtime: number | undefined, now: number): Check {
  const id = 'drive-health';
  if (text === null || mtime === undefined) return { id, status: 'unknown', detail: 'No readable SMART collector snapshot.' };
  const age = now - mtime;
  if (age < -300_000 || age > 25 * 3_600_000) return { id, status: 'unknown', detail: 'SMART snapshot is stale or future-dated; current drive health is unknown.' };
  try {
    const rows: unknown = JSON.parse(text).drives;
    if (!Array.isArray(rows) || !rows.length) throw new Error();
    const bad: string[] = [];
    let incomplete = false;
    for (const row of rows) {
      if (!row || typeof row !== 'object') { incomplete = true; continue; }
      const d = row as Record<string, unknown>;
      const label = typeof d.dev === 'string' ? d.dev : 'unnamed device';
      const number = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) ? Number(v) : undefined;
      const warning = number(d.critical_warning);
      const spare = number(d.available_spare), threshold = number(d.spare_threshold), used = number(d.percentage_used);
      if (['critical_warning', 'available_spare', 'spare_threshold', 'percentage_used', 'media_errors'].some(k => d[k] !== undefined && d[k] !== '' && number(d[k]) === undefined)) incomplete = true;
      if (warning !== undefined && warning !== 0) bad.push(`${label}: SMART critical warning`);
      if (spare !== undefined && threshold !== undefined && spare <= threshold) bad.push(`${label}: spare capacity at/below threshold`);
      if (used !== undefined && used >= 90) bad.push(`${label}: rated endurance nearly exhausted`);
      if (typeof d.health === 'string' && /fail/i.test(d.health)) bad.push(`${label}: SMART failed`);
      if (number(d.media_errors) !== undefined && Number(d.media_errors) > 0) bad.push(`${label}: recorded media errors; compare with previous readings`);
      if (typeof d.health !== 'string' || !/^(PASSED|OK)$/i.test(d.health.trim())) incomplete = true;
    }
    if (bad.length) return { id, status: 'fail', detail: bad.join('; ') };
    return { id, status: incomplete ? 'unknown' : 'pass', detail: incomplete ? 'Some drive rows lack a recognized health verdict.' : `${rows.length} drives report passing SMART; this does not predict future failure.` };
  } catch { return { id, status: 'unknown', detail: 'Invalid or empty SMART snapshot.' }; }
}

export function collectHostChecks(io: ProbeIO, policy: HostPolicy = DEFAULT_POLICY, deep = false): Check[] {
  if (io.platform !== 'linux') return [{ id: 'platform', status: 'skipped', detail: 'Only the Linux adapter is implemented.' }];
  const checks: Check[] = [];
  const add = (id: string, status: Status, detail: string) => checks.push({ id, status, detail });
  const run = (cmd: string, args: string[], timeout?: number): string | null => {
    const r = io.run(cmd, args, timeout);
    return r.code === 0 ? r.stdout : null;
  };

  const df = run('df', ['-P', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay']);
  const diskRows = df?.trim().split('\n').slice(1).map(l => l.trim().split(/\s+/));
  if (!diskRows?.length || diskRows.some(c => !/^\d+%$/.test(c[4] ?? ''))) add('disk', 'unknown', 'Disk usage could not be parsed.');
  else {
    const full = diskRows.filter(c => parseInt(c[4]) >= 85);
    add('disk', full.length ? 'fail' : 'pass', full.length ? full.map(c => `${c.slice(5).join(' ')}: ${c[4]} used`).join('; ') : 'Reported filesystems are below 85% usage.');
  }
  if (!policy.criticalMounts.length) add('mounts', 'skipped', 'No required mounts configured in private policy.');
  else {
    const mounts = run('findmnt', ['-rno', 'TARGET']);
    const missing = policy.criticalMounts.filter(m => !mounts?.split('\n').includes(m));
    add('mounts', mounts === null ? 'unknown' : missing.length ? 'fail' : 'pass', mounts === null ? 'Mount table unavailable.' : missing.length ? `Required mounts absent: ${missing.join(', ')}` : 'All configured mounts are present.');
  }

  const ss = run('ss', ['-H', '-lntu']);
  const exposed = ss === null ? null : listeners(ss);
  const unexpected = exposed?.filter(l => !policy.allowedListeners.some(a => a.protocol === l.protocol && a.port === l.port));
  add('listeners', exposed === null ? 'unknown' : unexpected?.length ? 'fail' : 'pass', exposed === null ? 'Listener inventory unavailable or malformed.' : unexpected?.length ? `${unexpected.map(l => `${l.protocol} ${l.address}:${l.port}`).join(', ')} bound beyond loopback without local approval. External reachability was not tested.` : 'No unapproved bindings beyond loopback in the socket inventory.');

  const ufw = run('ufw', ['status', 'verbose']);
  const enabled = io.read('/etc/ufw/ufw.conf')?.match(/^ENABLED=(yes|no)\s*$/im)?.[1];
  if (ufw === null || !/Status:\s*(active|inactive)\b/i.test(ufw)) add('firewall', 'unknown', `Effective UFW policy unavailable. Boot configuration: ${enabled ?? 'unknown'}. Configuration does not prove enforcement; other firewalls were not inspected.`);
  else add('firewall', /Status:\s*inactive/i.test(ufw) ? 'fail' : 'pass', /Status:\s*inactive/i.test(ufw) ? 'UFW is inactive; other filtering mechanisms were not inspected.' : 'UFW reports active. Docker published ports need separate review; this is not a reachability test.');

  // Pin the local socket: a user's Docker context or DOCKER_HOST must not trigger a remote audit.
  const docker = run('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-a', '--format', '{{json .}}']);
  if (docker === null) {
    add('containers', 'unknown', 'Local Docker daemon unavailable; no remote context was queried.');
    add('docker-ports', 'unknown', 'Local Docker published ports could not be checked.');
  } else {
    try {
      const rows = docker.split('\n').filter(Boolean).map(l => JSON.parse(l));
      if (rows.some(r => typeof r.State !== 'string' || typeof r.Status !== 'string' || typeof r.Ports !== 'string')) throw new Error();
      const unhealthy = rows.filter(r => r.State === 'restarting' || /unhealthy/i.test(r.Status));
      add('containers', unhealthy.length ? 'fail' : 'pass', unhealthy.length ? `${unhealthy.length} unhealthy or restarting container(s).` : `${rows.length} containers inspected; absence of an unhealthy status does not prove application health.`);
      const ports = rows.flatMap(r => [...r.Ports.matchAll(/([^\s,]+):(\d+)->\d+\/(tcp|udp)/g)].filter(m => !['127.0.0.1', '::1', '[::1]'].includes(m[1])).map(m => `${m[1]}:${m[2]}/${m[3]}`));
      add('docker-ports', ports.length ? 'fail' : 'pass', ports.length ? `Docker publishes ${[...new Set(ports)].join(', ')} beyond loopback. UFW may not filter this traffic; verify intended exposure separately.` : 'No non-loopback published ports reported by the local Docker daemon.');
    } catch { add('containers', 'unknown', 'Docker inventory malformed.'); add('docker-ports', 'unknown', 'Docker port inventory malformed.'); }
  }

  const updates = run('apt', ['list', '--upgradable']);
  const updateStamp = io.stat('/var/lib/apt/periodic/update-success-stamp');
  const security = updates?.split('\n').filter(l => /-security[,/ ]/.test(l)).length ?? 0;
  const fresh = updateStamp && io.now - updateStamp.mtimeMs >= -300_000 && io.now - updateStamp.mtimeMs < 48 * 3_600_000;
  add('security-updates', updates === null ? 'unknown' : security ? 'fail' : fresh ? 'pass' : 'unknown', updates === null ? 'APT unavailable.' : security ? `${security} security updates listed in the local package cache; no update or upgrade was run.` : fresh ? 'No security updates listed in a recently refreshed cache.' : 'No updates listed, but package-cache freshness cannot be established.');
  add('reboot', io.stat('/var/run/reboot-required') ? 'fail' : 'pass', io.stat('/var/run/reboot-required') ? 'The OS requests a reboot to activate installed updates.' : 'No reboot-required marker; this alone does not prove every running service is patched.');
  const units = run('systemctl', ['--failed', '--no-legend', '--plain', '--no-pager']);
  add('systemd', units === null ? 'unknown' : units.trim() ? 'fail' : 'pass', units === null ? 'Service manager unavailable.' : units.trim() ? 'Failed units: ' + units.trim() : 'No failed units reported.');

  const logs = ['/var/log/chkrootkit/log.today', '/var/log/rkhunter.log'].map(p => ({ p, st: io.stat(p), text: io.read(p) })).filter(r => r.st && r.text !== null).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs);
  if (!logs.length) add('rootkit-scan', 'unknown', 'No readable rootkit-scanner log.');
  else {
    const latest = logs[0], age = io.now - latest.st!.mtimeMs;
    const flagged = latest.text!.split('\n').some(l => /INFECTED|Rootkit '.*' found/i.test(l) && !/not infected|not found/i.test(l));
    add('rootkit-scan', flagged ? 'fail' : age < -300_000 || age > 3 * 86_400_000 ? 'unknown' : 'pass', flagged ? 'Scanner log flags a finding requiring investigation; this does not confirm compromise.' : age < -300_000 || age > 3 * 86_400_000 ? 'Scanner evidence is stale or future-dated; current scan state is unknown.' : 'Recent scanner log has no recognized infection signatures; this is not a malware-free attestation.');
  }
  const mail = io.stat('/var/mail/root');
  add('root-mail', mail === null ? 'unknown' : mail.size > 1_048_576 ? 'fail' : 'pass', mail === null ? 'No accessible root mailbox metadata.' : mail.size > 1_048_576 ? 'Root mailbox exceeds 1 MiB; verify monitoring delivery. Size does not establish whether mail was read.' : 'Root mailbox is below the size threshold.');
  if (!deep) add('pkg-integrity', 'skipped', 'Package integrity was not scanned; opt in with --deep.');
  else {
    const integrity = io.run('debsums', ['--changed'], 60_000);
    const changed = integrity.stdout.split('\n').filter(l => l.trim() && l !== '/usr/share/misc/pci.ids');
    add('pkg-integrity', changed.length ? 'fail' : integrity.code === 0 ? 'pass' : 'unknown', changed.length ? `Package files differ: ${changed.slice(0, 10).join(', ')}. Investigate authorized changes before attributing compromise.` : integrity.code === 0 ? 'No package differences reported by debsums.' : 'debsums failed or reported missing files; integrity is not established.');
  }
  checks.push(assessDrives(io.read('/var/log/disk-health.json'), io.stat('/var/log/disk-health.json')?.mtimeMs, io.now));

  const boot = run('mokutil', ['--sb-state']);
  add('secure-boot', boot === null || !/SecureBoot (enabled|disabled)/i.test(boot) ? 'unknown' : /SecureBoot enabled/i.test(boot) ? 'pass' : 'fail', boot === null ? 'Secure Boot state unavailable.' : /SecureBoot enabled/i.test(boot) ? 'UEFI Secure Boot reports enabled.' : /SecureBoot disabled/i.test(boot) ? 'UEFI Secure Boot reports disabled.' : 'Unrecognized firmware status.');
  const block = run('lsblk', ['--json', '--paths', '--output', 'NAME,TYPE,FSTYPE,MOUNTPOINTS']);
  try {
    const roots: unknown = block === null ? null : JSON.parse(block).blockdevices;
    if (!Array.isArray(roots) || !roots.length) throw new Error();
    const mounts: { mount: string; encrypted: boolean; type: string; fs: string }[] = [];
    const walk = (rows: any[], encrypted = false) => {
      for (const row of rows) {
        const crypt = encrypted || row.type === 'crypt' || row.fstype === 'crypto_LUKS';
        for (const mount of row.mountpoints ?? []) if (mount === '/' || mount === '/home') mounts.push({ mount, encrypted: crypt, type: row.type, fs: row.fstype });
        if (row.children) walk(row.children, crypt);
      }
    };
    walk(roots);
    if (!mounts.some(m => m.mount === '/')) throw new Error();
    const plain = mounts.filter(m => !m.encrypted);
    add('disk-encryption', plain.length ? 'unknown' : 'pass', plain.length ? 'No block-encryption ancestor visible for ' + plain.map(m => m.mount).join(', ') + '. File-level or hardware encryption was not assessed; confirm protection against physical access.' : 'Root/home block devices have an encryption ancestor; key protection was not assessed.');
  } catch { add('disk-encryption', 'unknown', 'Root/home block-encryption topology unavailable.'); }
  if (!/gnome/i.test(io.desktop ?? '')) {
    add('screen-lock', 'skipped', 'No declared GNOME desktop session; other session-lock mechanisms are not assessed.');
    return checks;
  }
  const idle = run('gsettings', ['get', 'org.gnome.desktop.session', 'idle-delay']);
  const lock = run('gsettings', ['get', 'org.gnome.desktop.screensaver', 'lock-enabled']);
  const seconds = idle?.trim().match(/^(?:uint32 )?(\d+)$/)?.[1];
  add('screen-lock', seconds === undefined || !['true', 'false'].includes(lock?.trim() ?? '') ? 'unknown' : lock?.trim() === 'false' || Number(seconds) === 0 ? 'fail' : 'pass', seconds === undefined || lock === null ? 'GNOME session settings unavailable; other desktop environments are not assessed.' : lock.trim() === 'false' || Number(seconds) === 0 ? 'GNOME automatic idle locking is disabled or has no idle timeout.' : 'GNOME idle locking is configured; actual lock activation was not tested.');
  return checks;
}

/** No names, paths, addresses, ports, versions, or check details cross this boundary. */
export function safeSummary(checks: Check[]) {
  return { schema: 'reckons.host-health-summary/v1', counts: Object.fromEntries((['pass', 'fail', 'unknown', 'skipped'] as const).map(s => [s, checks.filter(c => c.status === s).length])) };
}
