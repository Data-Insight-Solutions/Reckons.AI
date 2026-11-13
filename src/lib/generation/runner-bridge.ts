/**
 * Talks to the dev-server device bridge (scripts/dev-server/device-bridge.ts) so the connect popup can
 * start the local runner from the page. The bridge exists only when the app runs from the local dev
 * server; on the hosted site a page cannot start a program, and probe() says so (available: false).
 */
const BRIDGE = '/__reckons/device/agent-watch';
export type BridgeState = { available: boolean; running: boolean; workspace?: string };
export const WORKSPACE_PATH_KEY = 'reckons:gen-workspace-path';

export async function probeBridge(fetcher: typeof fetch = fetch): Promise<BridgeState> {
  try {
    const r = await fetcher(BRIDGE, { cache: 'no-store' });
    if (!r.ok) return { available: false, running: false };
    const j = await r.json() as { running?: boolean; worker?: boolean; workspace?: string };
    return { available: true, running: !!j.running && j.worker !== false, workspace: j.workspace };
  } catch { return { available: false, running: false }; }
}

/** Start the runner with the given generation folder. Returns '' on success, or a plain-words problem. */
export async function startRunner(workspace: string, restart = false, fetcher: typeof fetch = fetch): Promise<string> {
  const post = (action: string, body: unknown) => fetcher(`${BRIDGE}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    if (restart) { await post('stop', {}); await new Promise(r => setTimeout(r, 1200)); }
    const r = await post('start', { worker: true, workspace });
    if (r.ok) return '';
    const e = (await r.json().catch(() => ({}))) as { error?: string };
    return r.status === 400 ? 'That folder was not found on this computer. Type its full path, for example /home/you/reckons-assets.' : `The runner could not be started (${e.error ?? r.status}).`;
  } catch { return 'The runner could not be started from this page.'; }
}
