/**
 * On-demand local generation for the agent watcher (F166.1.3). Matt, 2026-11-12: not always on, and
 * the services are separate: "job request, if no service installed prompt install, if no service
 * running, start it", and "the generation services should not be bundled".
 *
 * WHAT A SERVICE IS HERE: image, video and splat each have their own tools and model files, so each
 * is installed or not on its own. None keeps a process running: a job runs the one stage's tool in
 * its own process and that process exits. What the watcher starts and stops on demand is the
 * per-folder RUNNER that turns requests into queue jobs (it needs the shared queue worker that
 * agent:watch already runs). A request for a picture therefore only ever touches the image tool.
 * Pure decisions and the per-folder controller live here with every side effect injected, so they
 * are tested with fakes; scripts/agent/gen-watch.ts wires the real ones.
 */
import { SERVICE_PURPOSES, describeService, type ServiceDescriptor, type ServicePurpose } from '../../src/lib/generation/services.js';
export const SERVICE_STAGES = SERVICE_PURPOSES;
export type ServiceStage = ServicePurpose;
export const DEFAULT_IDLE_SECONDS = 600;

export type PendingRequest = { id: string; stage: ServiceStage };
export type Decision = { start: boolean; stop: boolean; needInstall: ServiceStage[] };

/** The whole on-demand rule, with no I/O. */
export function decide(i: { pending: PendingRequest[]; installed: ServiceStage[]; runnerOn: boolean; idleMs: number; idleLimitMs: number }): Decision {
  const needInstall = [...new Set(i.pending.filter(p => !i.installed.includes(p.stage)).map(p => p.stage))];
  const startable = i.pending.some(p => i.installed.includes(p.stage));
  return {
    needInstall,
    start: !i.runnerOn && startable,
    stop: i.runnerOn && i.pending.length === 0 && i.idleMs >= i.idleLimitMs,
  };
}

/**
 * The folders the watcher serves. The browser cannot read the path of the folder a person picks, so
 * the simplest thing that works is a documented default plus a list the person edits once:
 * ~/Documents/reckons-assets (the folder the setup guide uses), RECKONS_GEN_FOLDERS (colon-separated)
 * and ~/.config/reckons/generation-folders.json ({ "folders": [...], "idleSeconds": 600 }).
 * Only folders that exist are served; the watcher never creates a folder.
 */
export function watchedFolders(i: { home: string; env: Record<string, string | undefined>; config?: unknown; exists: (p: string) => boolean }): { folders: string[]; idleSeconds: number } {
  const cfg = (i.config && typeof i.config === 'object' ? i.config : {}) as { folders?: unknown; idleSeconds?: unknown };
  const listed = Array.isArray(cfg.folders) ? cfg.folders.filter((f): f is string => typeof f === 'string') : [];
  const fromEnv = (i.env.RECKONS_GEN_FOLDERS ?? '').split(':').filter(Boolean);
  const all = [`${i.home}/Documents/reckons-assets`, ...listed, ...fromEnv].filter(p => p.startsWith('/') && !p.includes('\0'));
  const idle = typeof cfg.idleSeconds === 'number' && cfg.idleSeconds >= 30 ? cfg.idleSeconds : DEFAULT_IDLE_SECONDS;
  return { folders: [...new Set(all)].filter(i.exists), idleSeconds: idle };
}

export type RunnerLike = { tick(): boolean; close(): void };
export type Deps = {
  now: () => number;
  availability: (stage: ServiceStage) => { available: boolean; reason?: string };
  makeRunner: (folder: string) => RunnerLike;
  pending: (folder: string) => PendingRequest[];
  fail: (folder: string, id: string, message: string) => void;
  workspaceId: (folder: string) => string;
  write: (folder: string, value: unknown) => void;
};

export class GenWatch {
  private runner?: RunnerLike;
  private busyAt: number;
  private external = false;
  private retryAt = 0;
  constructor(readonly folder: string, private readonly deps: Deps, private readonly idleLimitMs: number) { this.busyAt = deps.now(); }

  get runnerOn() { return !!this.runner; }

  tick(): Decision {
    const d = this.deps, now = d.now();
    const avail = SERVICE_STAGES.map(stage => ({ stage, ...d.availability(stage) }));
    const installed = avail.filter(a => a.available).map(a => a.stage);
    const pending = d.pending(this.folder);
    if (pending.length) this.busyAt = now;
    const decision = decide({ pending, installed, runnerOn: this.runnerOn, idleMs: now - this.busyAt, idleLimitMs: this.idleLimitMs });
    // A request for a missing service is answered at once with what to install, never left waiting.
    for (const p of pending.filter(p => decision.needInstall.includes(p.stage))) {
      d.fail(this.folder, p.id, `Needs install: ${describeService(p.stage, { available: false, active: false, idleSeconds: 0 }).name} is not installed on this computer. ${avail.find(a => a.stage === p.stage)?.reason ?? ''}`.trim());
    }
    if (decision.start && now >= this.retryAt) {
      try { this.runner = d.makeRunner(this.folder); this.external = false; }
      catch { this.external = true; this.retryAt = now + 10_000; } // another runner (gen:serve) already serves this folder
    }
    if (decision.stop) { this.runner?.close(); this.runner = undefined; }
    this.runner?.tick();
    const active = new Set(pending.map(p => p.stage));
    const services: ServiceDescriptor[] = avail.map(a => describeService(a.stage, { available: a.available, reason: a.reason, active: active.has(a.stage), idleSeconds: this.idleLimitMs / 1000 }));
    // Same shape as the runner's capabilities.json, so the browser can read either one.
    d.write(this.folder, {
      version: 1, workspaceId: d.workspaceId(this.folder), heartbeat: now, pid: process.pid,
      stages: avail.map(a => ({ stage: a.stage, available: a.available, ...(a.reason ? { reason: a.reason } : {}) })),
      services, runner: this.runnerOn ? 'on' : this.external ? 'external' : 'stopped', idleSeconds: this.idleLimitMs / 1000,
    });
    return decision;
  }

  close() { this.runner?.close(); this.runner = undefined; }
}
