#!/usr/bin/env npx tsx
/**
 * Is this machine healthy, and is it exposing anything it should not? SCRIPT TIER, no model.
 *
 * Matt, 2026-09-01: "Observium is sitting unutilized, was towards the direction of observation but
 * I never look at it. Can you check that on a regular basis, like the other systems?"
 *
 * THE FAILURE OBSERVIUM HAD WAS NOT MISSING DATA, IT WAS REQUIRING SOMEBODY TO GO AND LOOK. A
 * monitoring dashboard nobody opens is indistinguishable from no monitoring at all, and it costs a
 * running Apache, an exposed port and a shell account to be that. So this does not draw graphs. It
 * asks a fixed set of questions on an interval and pushes ONLY the answers that need a human into
 * the review queue that is already read every day. Silence here means checked and fine, which is a
 * claim a dashboard can never make — an empty dashboard and a dashboard nobody loaded look the same.
 *
 * DETERMINISTIC BY CONSTRUCTION. Every check is a rule with a yes/no answer — is this path mounted,
 * is this port bound beyond loopback, is this container running, is this disk over threshold. There
 * is no judgment to get wrong, so there is no triage cost and no hallucination surface. That is the
 * whole argument for keeping observability at script tier (F74.3): a local model asked "does this
 * look healthy" would produce prose to read, which is the Observium problem again in a new costume.
 *
 * IT REPORTS UNKNOWN RATHER THAN GUESSING, following integration-health (F168). Several checks here
 * need root — the firewall state most importantly — and passwordless sudo is deliberately not
 * assumed. An unreadable check is reported AS unreadable and named, never quietly skipped and never
 * assumed to be fine. A health check that invents a clean result to look complete cannot be believed
 * when it says something is wrong.
 *
 * NOTE ON SCOPE: this is the read-only half of F170 container-orchestration, which Matt capped at
 * maintenance level on 2026-09-01 — observe and report, never act. Nothing here writes, restarts,
 * stops or reconfigures anything, and it needs no privilege to do its job.
 *
 * Usage:
 *   npx tsx scripts/offline/host-health.ts
 *   npx tsx scripts/offline/host-health.ts --pending    queue what needs attention
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { queueFindings, type Finding } from './pending-queue.js';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');

/** Disk pressure. Warn early enough that there is time to act, not at the cliff. */
const DISK_WARN_PCT = 85;
const DISK_HIGH_PCT = 92;

/**
 * Ports allowed to bind beyond loopback. Everything else listening on 0.0.0.0 or [::] is
 * reported. Keep this list SHORT and justified — it is the whole value of the check.
 */
const ALLOWED_PUBLIC_PORTS = new Map<number, string>([
  [22, 'ssh (not currently running; allowed if deliberately enabled)'],
  [1883, 'MQTT broker — F115.2, LAN-only by design'],
  [9001, 'MQTT over WebSocket — F169, the app subscribes from the browser'],
  [5000, 'Frigate UI — LAN-only by design'],
  [8554, 'Frigate go2rtc RTSP restream — LAN-only by design'],
]);

/** Mounts that MUST be present when they appear in fstab. A missing one is the silent-failure case. */
const CRITICAL_MOUNTS = ['/mnt/nvme1'];

type Check = {
  name: string;
  ok: boolean | null; // null = could not be determined
  detail: string;
  priority?: 'low' | 'normal' | 'high';
};

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

/**
 * Like sh(), but keeps stdout when the command exits non-zero. debsums exits 2 whenever ANY file
 * is missing — 97 of them here, all from a broken CUDA install — which would otherwise discard a
 * perfectly good list of changed files.
 */
function shTolerant(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    const out = (err as { stdout?: string | Buffer }).stdout;
    if (out === undefined || out === null) return null;
    return typeof out === 'string' ? out : out.toString('utf8');
  }
}

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// --- disk ---------------------------------------------------------------------------------------
function checkDisk(): void {
  const out = sh('df', ['-P', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay']);
  if (out === null) {
    add({ name: 'disk', ok: null, detail: 'df could not be read' });
    return;
  }
  const rows = out.trim().split('\n').slice(1);
  const hot: string[] = [];
  for (const row of rows) {
    const cols = row.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const pct = Number.parseInt(cols[4], 10);
    const mount = cols[5];
    if (!Number.isFinite(pct)) continue;
    if (pct >= DISK_WARN_PCT) {
      const availKb = Number.parseInt(cols[3], 10);
      const availGb = Number.isFinite(availKb) ? (availKb / 1024 / 1024).toFixed(0) : '?';
      hot.push(`${mount} at ${pct}% (${availGb} GB free)`);
    }
  }
  if (hot.length === 0) {
    add({ name: 'disk', ok: true, detail: `all filesystems under ${DISK_WARN_PCT}%` });
    return;
  }
  const worst = Math.max(
    ...hot.map((h) => Number.parseInt(h.replace(/^.*at (\d+)%.*$/, '$1'), 10) || 0),
  );
  add({
    name: 'disk',
    ok: false,
    priority: worst >= DISK_HIGH_PCT ? 'high' : 'normal',
    detail: `over ${DISK_WARN_PCT}%: ${hot.join('; ')}`,
  });
}

// --- critical mounts ----------------------------------------------------------------------------
function checkMounts(): void {
  const fstab = existsSync('/etc/fstab') ? readFileSync('/etc/fstab', 'utf8') : '';
  const mounted = sh('findmnt', ['-rno', 'TARGET']) ?? '';
  const mountSet = new Set(mounted.trim().split('\n'));

  for (const target of CRITICAL_MOUNTS) {
    const declared = fstab
      .split('\n')
      .some((l) => !l.trimStart().startsWith('#') && l.split(/\s+/)[1] === target);
    if (!declared) {
      add({ name: `mount ${target}`, ok: true, detail: 'not in fstab — not expected yet' });
      continue;
    }
    if (mountSet.has(target)) {
      add({ name: `mount ${target}`, ok: true, detail: 'declared in fstab and mounted' });
    } else {
      add({
        name: `mount ${target}`,
        ok: false,
        priority: 'high',
        detail:
          `declared in /etc/fstab but NOT MOUNTED. Anything bind-mounting a path under it will ` +
          `write to the ROOT filesystem instead, silently, while appearing to work.`,
      });
    }
  }
}

// --- network exposure ---------------------------------------------------------------------------
function checkExposure(): void {
  const out = sh('ss', ['-tlnH']);
  if (out === null) {
    add({ name: 'exposure', ok: null, detail: 'ss could not be read' });
    return;
  }
  const unexpected = new Map<number, string>();
  for (const line of out.trim().split('\n')) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const m = local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const [, addr, portStr] = m;
    const port = Number.parseInt(portStr, 10);
    const isPublic = addr === '0.0.0.0' || addr === '*' || addr === '[::]' || addr === '::';
    if (!isPublic || ALLOWED_PUBLIC_PORTS.has(port)) continue;
    // Ephemeral high ports from desktop apps are noise, not posture.
    if (port >= 32768) continue;
    unexpected.set(port, addr);
  }
  if (unexpected.size === 0) {
    add({ name: 'exposure', ok: true, detail: 'no unexpected all-interface listeners' });
    return;
  }
  const list = [...unexpected.keys()].sort((a, b) => a - b).join(', ');
  add({
    name: 'exposure',
    ok: false,
    priority: 'high',
    detail:
      `listening on ALL interfaces without an entry in the allowlist: ${list}. ` +
      `Each is reachable by every device on the LAN, cameras and IoT included.`,
  });
}

// --- firewall (needs root; report unknown rather than assume) ------------------------------------
function checkFirewall(): void {
  // `ufw status` needs root, but /etc/ufw/ufw.conf is world-readable and carries ENABLED=yes|no.
  // Falling back to it turns this from a permanent UNKNOWN into a real answer. It reports whether
  // ufw is ENABLED, not what its rules are — and it cannot see that Docker bypasses ufw entirely.
  let out = sh('ufw', ['status']);
  if (out === null && existsSync('/etc/ufw/ufw.conf')) {
    try {
      const conf = readFileSync('/etc/ufw/ufw.conf', 'utf8');
      out = /^ENABLED=yes/im.test(conf) ? 'Status: active' : 'Status: inactive';
    } catch {
      /* fall through to unknown */
    }
  }
  if (out === null) {
    add({
      name: 'firewall',
      ok: null,
      detail: 'ufw state unreadable. Run: sudo ufw status verbose',
    });
    return;
  }
  const active = /Status:\s*active/i.test(out);
  add({
    name: 'firewall',
    ok: active,
    priority: 'high',
    detail: active
      ? 'ufw enabled (note: it does NOT filter Docker-published ports)'
      : 'ufw INACTIVE — nothing is filtering inbound traffic',
  });
}

// --- containers (F170 read-only tier) -------------------------------------------------------------
function checkContainers(): void {
  const out = sh('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}']);
  if (out === null) {
    add({ name: 'containers', ok: null, detail: 'docker could not be queried' });
    return;
  }
  const bad: string[] = [];
  let total = 0;
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [name, state, status] = line.split('\t');
    total += 1;
    if (state === 'running' && /unhealthy/i.test(status ?? '')) bad.push(`${name}: unhealthy`);
    else if (state === 'restarting') bad.push(`${name}: restart-looping`);
  }
  add(
    bad.length
      ? { name: 'containers', ok: false, priority: 'high', detail: bad.join('; ') }
      : { name: 'containers', ok: true, detail: `${total} containers, none unhealthy or looping` },
  );
}

// --- updates ---------------------------------------------------------------------------------------
function checkUpdates(): void {
  const out = sh('apt', ['list', '--upgradable']);
  if (out === null) {
    add({ name: 'security-updates', ok: null, detail: 'apt could not be queried' });
    return;
  }
  const security = out.split('\n').filter((l) => /-security[,/ ]/.test(l)).length;
  add(
    security > 0
      ? {
          name: 'security-updates',
          ok: false,
          priority: 'high',
          detail: `${security} security update(s) pending`,
        }
      : { name: 'security-updates', ok: true, detail: 'no security updates pending' },
  );
}

// --- failed units -----------------------------------------------------------------------------------
function checkFailedUnits(): void {
  const out = sh('systemctl', ['--failed', '--no-legend', '--plain']);
  if (out === null) {
    add({ name: 'systemd', ok: null, detail: 'systemctl could not be queried' });
    return;
  }
  const failed = out.trim().split('\n').filter(Boolean);
  add(
    failed.length
      ? {
          name: 'systemd',
          ok: false,
          priority: 'normal',
          detail: `${failed.length} failed unit(s): ${failed.map((l) => l.split(/\s+/)[0]).join(', ')}`,
        }
      : { name: 'systemd', ok: true, detail: 'no failed units' },
  );
}

// --- rootkit scanners ---------------------------------------------------------------------------
/**
 * Matt, 2026-09-01: "determine if chkrootkit is a useful security tool to keep, and also check it
 * automatically." The second half is the part that matters. chkrootkit and rkhunter both run daily
 * here and both mail root, and /var/mail/root had grown to 9.8 MB unread — so the scanners were
 * working and the REPORTING was the broken part. Parse their logs instead of mailing into a void,
 * and stay silent unless something is actually flagged.
 */
function checkRootkitScan(): void {
  // chkrootkit is being retired as redundant with rkhunter + debsums; read whichever log exists.
  const candidates = ['/var/log/chkrootkit/log.today', '/var/log/rkhunter.log'];
  const log = candidates.find((c) => existsSync(c));
  if (!log) {
    add({ name: 'rootkit-scan', ok: null, detail: 'no chkrootkit or rkhunter log found' });
    return;
  }
  let body: string;
  try {
    body = readFileSync(log, 'utf8');
  } catch {
    add({ name: 'rootkit-scan', ok: null, detail: `${log} needs root to read` });
    return;
  }
  const infected = body
    .split('\n')
    // NARROW ON PURPOSE. Broadening this to chkrootkit's WARNING lines was tried on 2026-09-01 and
    // produced four findings, all false: packaged dotfiles (/usr/lib/debug/.build-id, OpenJDK
    // .jinfo, kernel vdso build-ids), a BPFDoor "hit" whose only evidence was a process blocked in
    // unix_seqpacket_recvmsg (a Unix socket read — BPFDoor is a network backdoor), DHCP clients
    // holding packet sockets, and a wtmp gap from June 2024. A check that emits four false
    // positives on a clean machine trains its reader to ignore it, which is worse than no check.
    .filter((l) => /INFECTED|Rootkit '.*' found/i.test(l))
    .filter((l) => !/not infected|not found/i.test(l));
  const ageDays = (Date.now() - statMtime(log)) / 86_400_000;
  if (infected.length) {
    add({
      name: 'rootkit-scan',
      ok: false,
      priority: 'high',
      detail: `${log} flagged ${infected.length} item(s): ${infected.slice(0, 3).join(' | ')}`,
    });
  } else if (ageDays > 3) {
    add({
      name: 'rootkit-scan',
      ok: false,
      priority: 'normal',
      detail:
        `${log} last written ${ageDays.toFixed(0)} days ago — no integrity scan is actually ` +
        `running. Check /etc/default/rkhunter CRON_DAILY_RUN, which ships empty and never runs.`,
    });
  } else {
    add({ name: 'rootkit-scan', ok: true, detail: `clean (${log}), ${ageDays.toFixed(1)}d ago` });
  }
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * THE META-CHECK, and the one that would have caught Observium too. Cron mails root; if nobody
 * reads root's mail, every scheduled job on this box is reporting into a void and looks healthy
 * precisely because it is silent. A growing mailbox is the signature of that failure.
 */
function checkUnreadRootMail(): void {
  const box = '/var/mail/root';
  if (!existsSync(box)) {
    add({ name: 'root-mail', ok: true, detail: 'no root mailbox — nothing reporting into a void' });
    return;
  }
  let bytes = 0;
  try {
    bytes = statSync(box).size;
  } catch {
    add({ name: 'root-mail', ok: null, detail: `${box} not readable without root` });
    return;
  }
  const mb = bytes / 1_048_576;
  add(
    mb > 1
      ? {
          name: 'root-mail',
          ok: false,
          priority: 'normal',
          detail:
            `${mb.toFixed(1)} MB of unread mail in ${box}. Cron jobs — chkrootkit and rkhunter ` +
            `among them — are reporting where nobody reads. Empty it, or stop mailing.`,
        }
      : { name: 'root-mail', ok: true, detail: `${mb.toFixed(1)} MB — not accumulating` },
  );
}

/**
 * PACKAGE INTEGRITY — the deterministic check, and the one worth more than either rootkit scanner.
 * debsums compares installed files against the distro's own checksums, so a modified system binary
 * is a fact, not a heuristic. Opt-in via --deep because a full sweep takes minutes.
 *
 * TWO TRAPS, BOTH HIT ON 2026-09-01. (1) --changed writes changed files to STDOUT while
 * MISSING-file warnings go to STDERR, so merging them with 2>&1 buries the real signal under
 * absent files — that flood was 97 lines, every one of them from a broken CUDA 13.1 install and
 * none of them a security event. Do not merge the streams. (2) /usr/share/misc/pci.ids is
 * legitimately rewritten by update-pciids, so it is excluded rather than reported forever.
 */
const BENIGN_CHANGED = new Set(['/usr/share/misc/pci.ids']);

function checkPackageIntegrity(): void {
  if (!argv.includes('--deep')) {
    add({ name: 'pkg-integrity', ok: true, detail: 'skipped (pass --deep; takes a few minutes)' });
    return;
  }
  const out = shTolerant('debsums', ['--changed']); // stderr discarded; exit code ignored
  if (out === null) {
    add({ name: 'pkg-integrity', ok: null, detail: 'debsums not installed or not runnable' });
    return;
  }
  const changed = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !BENIGN_CHANGED.has(f));
  add(
    changed.length
      ? {
          name: 'pkg-integrity',
          ok: false,
          priority: 'high',
          detail: `${changed.length} packaged file(s) MODIFIED: ${changed.slice(0, 5).join(', ')}`,
        }
      : { name: 'pkg-integrity', ok: true, detail: 'no packaged file has been modified' },
  );
}

/**
 * DRIVE HEALTH — the check whose absence cost a 1 TB NVMe.
 *
 * On 2026-09-01 a Samsung 970 EVO Plus was found dead in this machine: critical_warning 0x9,
 * available_spare 0% against a 10% threshold, 174,071 media errors — and percentage_used at 0%,
 * so it was a manufacturing defect rather than wear. It had been dead long enough that Matt had
 * forgotten the drive existed. smartmontools was not installed, kernel.dmesg_restrict is 1, and
 * nothing on the box was reading drive health. Six drives, zero monitoring.
 *
 * available_spare is the field that predicts death, NOT percentage_used. A drive can burn its
 * entire spare pool while its rated write endurance is untouched, which is exactly what happened
 * here — so a wear-based check would have stayed green right up to the moment it went read-only.
 *
 * Reads /var/log/disk-health.json, written hourly by a root systemd timer (install-disk-health.sh)
 * because SMART needs privilege and this job deliberately has none.
 */
type DriveRow = {
  dev?: string; model?: string; health?: string; critical_warning?: string;
  available_spare?: string; spare_threshold?: string; percentage_used?: string; media_errors?: string;
};

function checkDriveHealth(): void {
  const src = '/var/log/disk-health.json';
  if (!existsSync(src)) {
    add({
      name: 'drive-health',
      ok: false,
      priority: 'high',
      detail:
        'NO DRIVE HEALTH MONITORING. SMART needs root and nothing collects it — which is how a ' +
        'dead NVMe went unnoticed for years. Install: sudo bash install-disk-health.sh',
    });
    return;
  }
  let rows: DriveRow[] = [];
  let ageH = 0;
  try {
    rows = (JSON.parse(readFileSync(src, 'utf8')).drives ?? []) as DriveRow[];
    ageH = (Date.now() - statMtime(src)) / 3_600_000;
  } catch {
    add({ name: 'drive-health', ok: null, detail: `${src} is unreadable or malformed` });
    return;
  }
  if (ageH > 25) {
    add({
      name: 'drive-health',
      ok: false,
      priority: 'normal',
      detail: `${src} is ${ageH.toFixed(0)}h old — the disk-health.timer has stopped`,
    });
    return;
  }
  const bad: string[] = [];
  for (const d of rows) {
    const num = (v?: string) => (v && v.trim() !== '' ? Number(v) : NaN);
    const cw = d.critical_warning?.trim();
    if (cw && cw !== '0' && cw !== '0x0') bad.push(`${d.dev}: critical_warning ${cw}`);
    const spare = num(d.available_spare);
    const thr = num(d.spare_threshold);
    if (Number.isFinite(spare) && Number.isFinite(thr) && spare <= thr) {
      bad.push(`${d.dev}: available_spare ${spare}% at/below threshold ${thr}%`);
    }
    if (d.health && /fail/i.test(d.health)) bad.push(`${d.dev}: SMART health ${d.health}`);
    const used = num(d.percentage_used);
    if (Number.isFinite(used) && used >= 90) bad.push(`${d.dev}: ${used}% of write endurance used`);
  }
  add(
    bad.length
      ? { name: 'drive-health', ok: false, priority: 'high', detail: bad.join('; ') }
      : { name: 'drive-health', ok: true, detail: `${rows.length} drives healthy` },
  );
}

// --- run ----------------------------------------------------------------------------------------
checkDisk();
checkMounts();
checkExposure();
checkFirewall();
checkContainers();
checkUpdates();
checkFailedUnits();
checkRootkitScan();
checkUnreadRootMail();
checkPackageIntegrity();
checkDriveHealth();

const failing = checks.filter((c) => c.ok === false);
const unknown = checks.filter((c) => c.ok === null);

console.log('Host health — script tier, no model\n');
for (const c of checks) {
  const mark = c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : '??  ';
  console.log(`  [${mark}] ${c.name.padEnd(18)} ${c.detail}`);
}
console.log(
  `\n${failing.length} needing attention, ${unknown.length} undeterminable, ` +
    `${checks.length - failing.length - unknown.length} fine.`,
);

if (PENDING_OUT && (failing.length || unknown.length)) {
  const findings: Finding[] = [
    ...failing.map((c) => ({
      subject: 'host-health',
      predicate: 'needs-attention',
      question: `Host check '${c.name}' is failing: ${c.detail}`,
      type: 'observation' as const,
      priority: c.priority ?? 'normal',
    })),
    ...unknown.map((c) => ({
      subject: 'host-health',
      predicate: 'undeterminable',
      question: `Host check '${c.name}' could not be determined: ${c.detail}`,
      type: 'question' as const,
      priority: 'low' as const,
    })),
  ];
  const res = queueFindings(findings, { agent: 'host-health', recomputes: true });
  console.log(`\nQueued ${findings.length} finding(s) for review.`, res ? '' : '');
}

process.exit(0);
