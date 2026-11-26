/**
 * Generation services as plugin-shaped records (Matt, 2026-11-12: everything is a plugin; one library
 * with filters). One module, no I/O: the agent watcher writes these into watcher.json, the connect
 * popup and Settings, Device read them, and the plugin library (kb:plugin-library, F296) can list
 * them without rework. A service is installed on its own; none keeps a process running, so
 * 'running' means a request for it is being worked and 'idle' means installed and waiting.
 */
export type ServiceStatus = 'not-installed' | 'installed' | 'running' | 'idle';
export type ServicePurpose = 'image' | 'video' | 'splat';

export interface ServiceDescriptor {
  id: string;
  name: string;
  kind: 'local-service';
  purposes: ServicePurpose[];
  /** What it needs on this computer, in plain words. Sizes live in the setup guide's table. */
  requirements: string[];
  /** Install step for THIS service. Today every service points at the same all-in-one script (separate installs: F58.9.21). */
  install: { label: string; docs: string; command?: string; perServiceInstaller: boolean };
  status: ServiceStatus;
  /** Why it is not installed, when it is not. */
  reason?: string;
  /** User-changeable settings. Idle stop is the watcher's, shared by all services. */
  settings: { key: string; label: string; value: string | number }[];
}

const SETUP = '/docs/features/generation-setup';
const BASE: Record<ServicePurpose, Pick<ServiceDescriptor, 'id' | 'name' | 'requirements'>> = {
  image: { id: 'generation-image', name: 'image generation', requirements: ['stable-diffusion.cpp', 'Z-Image Turbo model files', 'a GPU with enough memory'] },
  video: { id: 'generation-video', name: 'video generation', requirements: ['stable-diffusion.cpp', 'Wan 2.2 model files', 'a GPU with enough memory', 'ffmpeg'] },
  splat: { id: 'generation-splat', name: 'splat generation', requirements: ['TripoSplat and its Python environment', 'its model files', 'an NVIDIA GPU with CUDA (not available on macOS)'] },
};
export const SERVICE_PURPOSES = Object.keys(BASE) as ServicePurpose[];

export function describeService(purpose: ServicePurpose, i: { available: boolean; reason?: string; active: boolean; idleSeconds: number }): ServiceDescriptor {
  const b = BASE[purpose];
  return {
    ...b, kind: 'local-service', purposes: [purpose],
    install: { label: `Install ${b.name}`, docs: SETUP, command: 'bash scripts/content/gen-setup.sh', perServiceInstaller: false },
    status: !i.available ? 'not-installed' : i.active ? 'running' : 'idle',
    ...(i.reason ? { reason: i.reason } : {}),
    settings: [{ key: 'idleSeconds', label: 'Stop the runner after this many idle seconds', value: i.idleSeconds }],
  };
}

/** One plain line per service for the popup. */
export const serviceLine = (s: ServiceDescriptor) => `${s.name}: ${s.status === 'not-installed' ? 'not installed' : 'installed, will start when needed'}`;
