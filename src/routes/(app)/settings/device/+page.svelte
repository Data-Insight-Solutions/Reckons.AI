<script lang="ts">
  /**
   * Settings → This Device (F245). Matt, 2026-10-29: an agent watch page, a way to start agent watch
   * from the UI, and "installed plugins, device specs, and a variety of things" on one settings page.
   *
   * Two halves with different reach, said on the page where it matters:
   *   - from THIS BROWSER: specs, the extension, the app's integrations. Works anywhere, phone included.
   *   - from THE DEV SERVER (scripts/dev-server/device-bridge.ts): agent watch, host specs, Ollama
   *     models, MCP servers. Only while `npm run dev` runs on this machine; absent on a deployed site.
   */
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { ago, duration, dueText, headline, sortDue, watcherProblem, type Level, type WatchStatus } from '$lib/device/agent-watch-view';
  import { browserSpecs, bytes, waitForExtension, type BrowserSpecs } from '$lib/device/browser-specs';
  import { integrations } from '$lib/device/integrations';

  const BRIDGE = '/__reckons/device';

  type HostSpecs = { hostname: string; os: string; arch: string; cpu: string; cores: number; memoryBytes: number; freeMemoryBytes: number; uptimeSeconds: number; node: string; gpus: { index: number; name: string; memoryMiB: number; driver?: string }[] };
  type Installed = { ollama: { up: boolean; url: string; models: { name: string; sizeBytes: number; family?: string; parameters?: string; quantization?: string }[] }; mcp: { name: string; transport: string; via: string }[] | null; mcpFile: string | null };

  /** undefined = not checked yet; false = no bridge here (deployed site, preview build, other host). */
  let bridge = $state<boolean | undefined>(undefined);
  let watch = $state<WatchStatus | null>(null);
  let host = $state<HostSpecs | null>(null);
  let installed = $state<Installed | null>(null);
  let browser = $state<BrowserSpecs | null>(null);
  let extension = $state<string | undefined | null>(null);
  let withWorker = $state(true);
  let busy = $state(false);
  let actionError = $state('');
  let now = $state(new Date());
  let timer: ReturnType<typeof setTimeout> | undefined;

  const snap = $derived(watch?.snapshot ?? null);
  const heads = $derived(snap ? headline(snap, now) : []);
  const problem = $derived(watch ? watcherProblem(watch) : undefined);
  const due = $derived(sortDue(snap?.due));
  const configured = $derived(integrations(settings()));

  async function getJson<T>(path: string): Promise<T | null> {
    const r = await fetch(`${BRIDGE}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  }

  async function poll() {
    try {
      const w = await getJson<WatchStatus>('/agent-watch');
      bridge = w !== null;
      watch = w;
    } catch {
      bridge = false;
    }
    now = new Date();
    // Fast while the watcher runs, slow while it is stopped, and not at all in a hidden tab.
    if (bridge) timer = setTimeout(tick, watch?.running ? 2000 : 6000);
  }
  function tick() {
    if (document.hidden) timer = setTimeout(tick, 2000);
    else void poll();
  }

  async function act(action: 'start' | 'stop') {
    busy = true;
    actionError = '';
    try {
      const r = await fetch(`${BRIDGE}/agent-watch/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker: withWorker }) });
      if (!r.ok) actionError = `${action} refused: ${r.status} ${(await r.json().catch(() => ({}))).error ?? ''}`;
    } catch (e) {
      actionError = `${action} failed: ${String(e)}`;
    } finally {
      busy = false;
      clearTimeout(timer);
      setTimeout(() => void poll(), 400);
    }
  }

  async function loadOllamaFromBrowser(): Promise<Installed['ollama']> {
    const url = (settings().ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    try {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const t = (await r.json()) as { models?: { name: string; size: number; details?: { family?: string; parameter_size?: string; quantization_level?: string } }[] };
      return { up: true, url, models: (t.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size, family: m.details?.family, parameters: m.details?.parameter_size, quantization: m.details?.quantization_level })) };
    } catch {
      return { up: false, url, models: [] };
    }
  }

  onMount(async () => {
    void browserSpecs().then((b) => (browser = b));
    void waitForExtension().then((v) => (extension = v));
    await poll();
    if (bridge) {
      void getJson<HostSpecs>('/host').then((h) => (host = h));
      void getJson<Installed>('/installed').then((i) => (installed = i));
    } else {
      installed = { ollama: await loadOllamaFromBrowser(), mcp: null, mcpFile: null };
    }
  });
  onDestroy(() => clearTimeout(timer));

  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
  const mark = (lv: Level | string) => (lv === 'bad' ? '✗' : lv === 'warn' ? '!' : '✓');
  const until = (iso: string | undefined) => {
    if (!iso) return '';
    const s = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
    return s <= 0 ? 'unloading' : s < 90 ? `unloads in ${s}s` : `unloads in ${Math.round(s / 60)}m`;
  };
</script>

<header class="head">
  <p class="kicker mono">settings</p>
  <h1>system configuration</h1>
  <div class="settings-nav">
    <a href="/settings" class="nav-link">backends</a>
    <a href="/settings/publishing" class="nav-link">publishing</a>
    <a href="/settings/integrations" class="nav-link">integrations</a>
    <a href="/settings/turtle" class="nav-link">turtle</a>
    <a href="/settings/entity-types" class="nav-link">entity types</a>
    <a href="/settings/device" class="nav-link active">this device</a>
    <a href="/analyze" class="nav-link">analyze history ↗</a>
  </div>
  <nav class="section-toc">
    <a href="#d-agents">agents</a>
    <a href="#d-specs">specs</a>
    <a href="#d-installed">installed</a>
  </nav>
</header>

<section id="d-agents" class="card">
  <div class="card-head">
    <h3>agent watch</h3>
    {#if bridge && watch}
      <div class="controls">
        {#if watch.running}
          <span class="state mono"><span class="dot live"></span>running · {ago(watch.startedAt, now).replace(' ago', '')} · {watch.worker ? 'with queue worker' : 'watch only'}</span>
          <button onclick={() => act('stop')} disabled={busy}>stop</button>
        {:else}
          <label class="check mono"><input type="checkbox" bind:checked={withWorker} /> also run the queue worker</label>
          <button class="primary" onclick={() => act('start')} disabled={busy}>start agent watch</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if bridge === undefined}
    <p class="hint">checking for the dev server…</p>
  {:else if bridge === false}
    <p class="hint">
      Agent watch reads the local models, GPUs and job queue on the computer that runs them, which a web page
      cannot reach by itself. Run <code>npm run dev</code> on that computer and open this page from it
      (<code>localhost</code>), or use <code>npm run agent:watch</code> in a terminal there.
    </p>
  {:else if watch && !watch.running && !watch.snapshot}
    <p class="hint">
      Not running. Starting it is the same as <code>{watch.command}</code> in a terminal: it refreshes every 2 seconds
      {withWorker ? 'and runs the queue worker, which works through queued local jobs while a session is active' : 'and only watches; queued jobs wait'}.
      It keeps running when you leave this page, until you stop it or stop the dev server.
    </p>
  {/if}
  {#if actionError}<p class="error">{actionError}</p>{/if}
  {#if problem}<p class="hint warn-text">{problem}</p>{/if}

  {#if snap}
    {#if !watch?.running}<p class="hint">stopped — last snapshot {ago(snap.at, now)}</p>{/if}
    <div class="headline" class:stale={!watch?.running}>
      {#each heads as h (h.key)}
        <div class="tile lv-{h.level}" title={h.detail ?? ''}>
          <span class="tile-label mono">{h.label}</span>
          <span class="tile-value"><span class="tile-mark" aria-hidden="true">{mark(h.level)}</span>{h.value}</span>
          {#if h.detail}<span class="tile-detail">{h.detail}</span>{/if}
        </div>
      {/each}
    </div>

    {#if snap.jobs?.circuits.length}
      <div class="alert">
        {#each snap.jobs.circuits as c (c.name)}
          <p><strong>circuit open: {c.name}</strong> — {c.count} identical failures: <code>{c.signature}</code>. Reset with <code>npx tsx scripts/agent/job-watch.ts --reset {c.name}</code>.</p>
        {/each}
      </div>
    {/if}

    <details open>
      <summary>models &amp; GPUs</summary>
      {#if !snap.ollama.up}
        <p class="error">Ollama is down — nothing answers at {snap.ollamaUrl}</p>
      {:else}
        <p class="sub mono">Ollama v{snap.ollama.version ?? '?'} at {snap.ollamaUrl.replace(/^https?:\/\//, '')}</p>
        {#if snap.ollama.loaded.length === 0}<p class="hint">no model loaded</p>{/if}
        <ul class="rows">
          {#each snap.ollama.loaded as m (m.name)}
            <li><strong>{m.name}</strong> <span class="muted">{gb(m.vramBytes)} VRAM{m.contextLength ? ` · ctx ${m.contextLength}` : ''} · {until(m.expiresAt)}</span></li>
          {/each}
        </ul>
      {/if}
      {#each snap.gpus as g (g.index)}
        {@const vram = (g.usedMiB / g.totalMiB) * 100}
        <div class="gpu">
          <span class="mono">GPU {g.index}</span> <span>{g.name}</span>
          <div class="bar" title="utilization {g.util}%"><span class="fill" style="width: {g.util}%"></span></div><span class="mono num">{g.util}%</span>
          <div class="bar" title="VRAM {Math.round(vram)}%"><span class="fill vram" style="width: {vram}%"></span></div><span class="mono num">{(g.usedMiB / 1024).toFixed(1)}/{(g.totalMiB / 1024).toFixed(0)} GB</span>
        </div>
      {/each}
    </details>

    <details open>
      <summary>jobs <span class="count">{snap.jobs?.running.length ?? 0} running · failures in the last hour {snap.jobs?.failuresLastHour ?? '?'}</span></summary>
      <ul class="rows">
        {#each snap.jobs?.running ?? [] as r (r.pid)}
          <li><span class="sym run">▶</span> <strong>{r.name}</strong> <span class="muted">{duration(now.getTime() - new Date(r.started).getTime())}{snap.jobs?.medians?.[r.name] ? ` (median ${duration(snap.jobs.medians[r.name])})` : ''} · attempt {r.attempt}/{r.maxAttempts} · pid {r.pid}</span></li>
        {/each}
        {#each (snap.jobs?.finished ?? []).slice().reverse() as f, i (i)}
          <li><span class="sym" class:ok={f.status === 'passed'} class:bad={f.status === 'failed'}>{f.status === 'passed' ? '✓' : f.status === 'refused' ? '⊘' : '✗'}</span> <strong>{f.name ?? '?'}</strong> <span class="muted">{f.status} · {ago(f.startedAt, now)}</span>{#if f.headline}<div class="reason">{f.headline}</div>{/if}</li>
        {/each}
        {#if !snap.jobs?.running.length && !snap.jobs?.finished.length}<li class="muted">no runs recorded</li>{/if}
      </ul>
    </details>

    <details>
      <summary>queue &amp; schedules <span class="count">{due.filter((d) => d.due).length} due of {due.length}{snap.queue?.held?.length ? ` · ${snap.queue.held.length} held` : ''}</span></summary>
      {#if snap.queue?.held?.length}
        <p class="sub">held</p>
        <ul class="rows">{#each snap.queue.held as h (h)}<li class="warn-text">{h}</li>{/each}</ul>
      {/if}
      <ul class="rows due">
        {#each due as d (d.job.name)}
          <li class:muted={!d.due}><span class="lv-text-{d.due ? d.level : 'ok'}">{dueText(d)}</span> {d.job.label ?? d.job.name}{d.job.every ? ` · every ${d.job.every}` : ''}</li>
        {/each}
      </ul>
    </details>

    <details>
      <summary>panel runs <span class="count">{snap.runs.length} today</span></summary>
      {#if snap.runs.length === 0}<p class="hint">none today</p>{/if}
      {#each snap.runs.slice().reverse() as r (r.run)}
        <div class="run">
          <p>
            <span class="sym" class:run={!r.finished} class:ok={r.finished && !r.failed && !r.abandoned} class:bad={r.failed || r.abandoned}>{!r.finished ? '▶' : r.failed || r.abandoned ? '✗' : '✓'}</span>
            <strong>{r.task}</strong>
            <span class="muted">{r.done}/{r.total} votes · {r.models.map((m) => m.split(':')[0]).join('+')}
              {#if r.abandoned} · abandoned (process gone){/if}
              {#if r.counts} · unanimous {r.counts.unanimous ?? 0} · majority {r.counts.majority ?? 0} · split {r.counts.split ?? 0}{/if}
              {#if !r.finished && r.disagreements} · {r.disagreements} disagreeing{/if}
              · {ago(r.startedAt, now)}</span>
          </p>
          <ul class="rows votes">
            {#each r.recent.slice(-6) as v, i (i)}
              <li><span class="muted mono">{v.model.split(':')[0]}</span> {v.item.slice(-56)} → {#if v.error}<span class="bad">error: {v.error.slice(0, 80)}</span>{:else}<strong>{v.value ?? '?'}</strong>{/if}{#if v.reason}<div class="reason">{v.reason}</div>{/if}</li>
            {/each}
          </ul>
        </div>
      {/each}
    </details>

    <details>
      <summary>requests <span class="count">every caller, from the Ollama server log</span></summary>
      {#if snap.requests === null}
        <p class="hint">The Ollama server log is not readable here (<code>journalctl -u ollama</code>), so only panel runs are visible.</p>
      {:else if !snap.requests.last}
        <p class="hint warn-text">none today — no local model has been asked anything</p>
      {:else}
        <p>today {snap.requests.today} · last hour {snap.requests.lastHour} · {duration(snap.requests.busySeconds * 1000)} of model time · p50 {(snap.requests.p50Seconds ?? 0).toFixed(1)}s</p>
        <p class="muted mono small">{snap.requests.byPath.map(([p, n]) => `${p} ×${n}`).join(' · ')}</p>
      {/if}
    </details>
    <p class="legend mono">✓ ok · ! watch · ✗ act now — limits in scripts/agent/defaults/device-defaults.ttl, per machine in ~/.config/reckons/device.ttl</p>
  {/if}
</section>

<section id="d-specs" class="card">
  <h3>device specs</h3>
  {#if host}
    <p class="sub">this computer, from the dev server</p>
    <dl class="specs">
      <dt>host</dt><dd>{host.hostname}</dd>
      <dt>system</dt><dd>{host.os} · {host.arch}</dd>
      <dt>cpu</dt><dd>{host.cpu} · {host.cores} threads</dd>
      <dt>memory</dt><dd>{bytes(host.memoryBytes)} · {bytes(host.freeMemoryBytes)} free</dd>
      <dt>gpu</dt><dd>{#if host.gpus.length}{host.gpus.map((g) => `${g.name} (${(g.memoryMiB / 1024).toFixed(0)} GB)`).join(' · ')}{:else}<span class="muted">no NVIDIA GPU visible (nvidia-smi)</span>{/if}</dd>
      <dt>up</dt><dd>{duration(host.uptimeSeconds * 1000)} · node {host.node}</dd>
    </dl>
  {/if}
  {#if browser}
    <p class="sub">this browser{host ? '' : ' (browsers round or hide some of these on purpose)'}</p>
    <dl class="specs">
      <dt>platform</dt><dd>{browser.platform ?? 'not reported'}</dd>
      <dt>cores</dt><dd>{browser.cores ?? 'not reported'}</dd>
      <dt>memory</dt><dd>{browser.memoryGb ? `about ${browser.memoryGb} GB (browsers round this down on purpose)` : 'not reported'}</dd>
      <dt>gpu</dt><dd>{browser.gpu ?? 'not reported'} · WebGPU {browser.webgpu ? 'available' : 'not available'}</dd>
      <dt>screen</dt><dd>{browser.screen} @{browser.pixelRatio}x{browser.touch ? ' · touch' : ''}</dd>
      <dt>storage</dt><dd>{#if browser.storage}{bytes(browser.storage.usage)} used of {bytes(browser.storage.quota)}{browser.storage.persisted ? ' · persistent' : ' · may be evicted under pressure'}{:else}not reported{/if}</dd>
      <dt>network</dt><dd>{browser.online ? 'online' : 'offline'}</dd>
    </dl>
  {/if}
</section>

<section id="d-installed" class="card">
  <h3>installed</h3>

  <p class="sub">local models {#if installed?.ollama.up}<span class="muted">· Ollama at {installed.ollama.url.replace(/^https?:\/\//, '')}</span>{/if}</p>
  {#if !installed}
    <p class="hint">checking…</p>
  {:else if !installed.ollama.up}
    <p class="hint">Ollama not reachable at {installed.ollama.url}{bridge ? '' : ' from this browser (it may be running but not allow this origin)'}.</p>
  {:else}
    <ul class="rows">
      {#each installed.ollama.models as m (m.name)}
        <li><strong>{m.name}</strong> <span class="muted">{bytes(m.sizeBytes)}{m.parameters ? ` · ${m.parameters}` : ''}{m.quantization ? ` · ${m.quantization}` : ''}{m.family ? ` · ${m.family}` : ''}</span></li>
      {/each}
      {#if installed.ollama.models.length === 0}<li class="muted">none pulled</li>{/if}
    </ul>
  {/if}

  <p class="sub">MCP servers {#if installed?.mcpFile}<span class="muted">· {installed.mcpFile}</span>{/if}</p>
  {#if !bridge}
    <p class="hint">listed from the repository's <code>.mcp.json</code>, so only when this page comes from the dev server</p>
  {:else if installed?.mcp === null}
    <p class="hint">no readable <code>.mcp.json</code> in this checkout</p>
  {:else if installed}
    <ul class="rows">{#each installed.mcp ?? [] as s (s.name)}<li><strong>{s.name}</strong> <span class="muted">{s.transport} · {s.via}</span></li>{/each}</ul>
  {/if}

  <p class="sub">browser extension</p>
  {#if extension === null}
    <p class="hint">checking…</p>
  {:else if extension}
    <p><span class="sym ok">✓</span> Reckons.AI extension v{extension}</p>
  {:else}
    <p class="hint">Not detected. Either it is not installed in this browser, or its app URL (extension options) is set to a different address than this page.</p>
  {/if}

  <p class="sub">app integrations <span class="muted">· in this browser's settings; configured is not the same as working</span></p>
  <ul class="rows integrations">
    {#each configured as i (i.id)}
      <li class:muted={!i.configured}>
        <span class="sym" class:ok={i.configured}>{i.configured ? '✓' : '·'}</span>
        <a href={i.href}>{i.name}</a> <span class="muted">{i.configured ? i.detail : 'not set up'}</span>
      </li>
    {/each}
  </ul>
</section>

<style>
  .head { margin-bottom: 1.25rem; }
  .kicker { color: var(--accent); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.2em; margin: 0 0 0.5rem; }
  .settings-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; border-bottom: 1px solid var(--line); padding-bottom: 0.75rem; }
  .nav-link {
    padding: 0.35rem 0.75rem; border-radius: var(--rad-sm); font-family: var(--font-mono);
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted);
    border: 1px solid transparent; transition: all 0.15s; text-decoration: none;
  }
  .nav-link:hover { color: var(--ink-2); border-color: var(--muted-2); }
  .nav-link.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .section-toc { display: flex; gap: 0.75rem; margin-top: 0.6rem; font-family: var(--font-mono); font-size: 0.72rem; }
  .section-toc a { color: var(--muted); text-decoration: none; }
  .section-toc a:hover { color: var(--accent); }

  .card + .card { margin-top: 1rem; }
  .card h3 { font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.05em; margin: 0; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
  .controls { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .controls button {
    padding: 0.35rem 0.8rem; font-size: 0.78rem; background: var(--surface-2); color: var(--ink);
    border: 1px solid var(--line); border-radius: var(--rad-sm); cursor: pointer;
  }
  .controls button:hover { border-color: var(--accent); color: var(--accent); }
  .controls button.primary { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .controls button:disabled { opacity: 0.5; cursor: default; }
  .check { display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; color: var(--muted); }
  .state { font-size: 0.72rem; color: var(--ink-2); display: flex; align-items: center; gap: 0.4rem; }
  .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--muted-2); }
  .dot.live { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }

  .hint, .sub { color: var(--muted); font-size: 0.78rem; line-height: 1.5; margin: 0.4rem 0; }
  .sub { font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.68rem; margin-top: 0.9rem; color: var(--ink-2); }
  .sub .muted { text-transform: none; letter-spacing: 0; }
  .error { color: var(--danger); font-size: 0.8rem; }
  .warn-text { color: var(--warn, #e0a33a); }
  .muted { color: var(--muted); }
  .small { font-size: 0.72rem; }
  code { font-family: var(--font-mono); font-size: 0.85em; background: var(--surface-2); padding: 0.05rem 0.3rem; border-radius: 4px; }

  /* The pinned row: what the terminal lost off the top once it scrolled. */
  .headline {
    position: sticky; top: 0; z-index: 5;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.4rem;
    padding: 0.5rem 0; margin: 0 0 0.5rem; background: var(--surface);
  }
  .headline.stale { opacity: 0.6; }
  .tile { display: flex; flex-direction: column; gap: 0.1rem; padding: 0.45rem 0.6rem; border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--rad-sm); min-width: 0; }
  .tile-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .tile-value { font-size: 0.9rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-mark { font-size: 0.7rem; margin-right: 0.3rem; }
  .tile-detail { font-size: 0.7rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lv-ok { border-left-color: var(--ok); }
  .lv-ok .tile-mark { color: var(--ok); }
  .lv-warn { border-left-color: var(--warn, #e0a33a); }
  .lv-warn .tile-mark, .lv-warn .tile-value { color: var(--warn, #e0a33a); }
  .lv-bad { border-left-color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .lv-bad .tile-mark, .lv-bad .tile-value { color: var(--danger); }
  .lv-text-warn { color: var(--warn, #e0a33a); }
  .lv-text-bad { color: var(--danger); }
  .lv-text-ok { color: var(--muted); }

  .alert { border: 1px solid var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border-radius: var(--rad-sm); padding: 0.2rem 0.7rem; margin-bottom: 0.5rem; font-size: 0.8rem; }

  details { border-top: 1px solid var(--line); padding: 0.45rem 0; }
  summary { cursor: pointer; font-family: var(--font-mono); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); }
  summary .count { text-transform: none; letter-spacing: 0; color: var(--muted); margin-left: 0.4rem; }
  .rows { list-style: none; padding: 0; margin: 0.35rem 0; display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; }
  .rows li { overflow-wrap: anywhere; }
  .votes { margin-left: 1.2rem; font-size: 0.75rem; }
  .reason { color: var(--muted); font-size: 0.72rem; margin: 0.1rem 0 0 1.2rem; line-height: 1.4; }
  .run p { margin: 0.4rem 0 0.1rem; font-size: 0.8rem; }
  .sym { display: inline-block; width: 1rem; text-align: center; color: var(--muted); }
  .sym.ok, .ok { color: var(--ok); }
  .sym.bad, .bad { color: var(--danger); }
  .sym.run { color: var(--warn, #e0a33a); }

  .gpu { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto auto; gap: 0.2rem 0.6rem; align-items: center; font-size: 0.78rem; margin: 0.5rem 0; }
  .gpu > span:first-child { color: var(--muted); }
  .gpu .bar { height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; grid-column: 1 / 2; min-width: 120px; }
  .gpu .num { color: var(--muted); font-size: 0.72rem; }
  .fill { display: block; height: 100%; background: var(--accent); }
  .fill.vram { background: var(--data); }

  .specs { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.9rem; margin: 0.3rem 0; font-size: 0.8rem; }
  .specs dt { color: var(--muted); font-family: var(--font-mono); font-size: 0.72rem; }
  .specs dd { margin: 0; overflow-wrap: anywhere; }
  .integrations a { color: var(--ink); }
  .integrations li.muted a { color: var(--muted); }
  .legend { font-size: 0.65rem; color: var(--muted-2); margin: 0.6rem 0 0; }
</style>
