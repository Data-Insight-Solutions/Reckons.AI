/**
 * WHERE THE DEVICE SPACE LIVES (F269) and its identity. Kept apart from the builders so both the
 * measurement file and the job-records file (queue-to-space.ts --device) can name the same place
 * without importing each other.
 *
 * The folder is outside any Git checkout: ${XDG_STATE_HOME:-~/.local/state}/reckons/device/.
 *   this-device.ttl   measured capabilities (written by measure-device.ts, mode 0600)
 *   job-records.ttl   derived job records (written by queue-to-space.ts --device, mode 0600)
 *   device-id         the stable id, generated once and kept (mode 0600)
 * ONE WRITER PER FILE: the two scripts never write each other's file.
 *
 * The stable id is a random UUID, not derived from the hostname or the user name, so a leap or an
 * export that carries it reveals neither. WEAKNESS, said out loud: it is local state; deleting the
 * device-id file makes a new device identity, and a copied state folder makes two devices share one.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const deviceSpaceDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons', 'device');
export const deviceMeasuredPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(deviceSpaceDir(env), 'this-device.ttl');
export const deviceJobRecordsPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(deviceSpaceDir(env), 'job-records.ttl');

/** The device's stable id: read it, or generate one and keep it. A malformed file is replaced, never trusted. */
export function deviceStableId(env: NodeJS.ProcessEnv = process.env): string {
  const file = path.join(deviceSpaceDir(env), 'device-id');
  try {
    const v = readFileSync(file, 'utf8').trim().toLowerCase();
    if (UUID_RE.test(v)) return v;
  } catch { /* none yet */ }
  const id = randomUUID();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return id;
}

export const hasDeviceSpace = (env: NodeJS.ProcessEnv = process.env): boolean => existsSync(deviceMeasuredPath(env));
