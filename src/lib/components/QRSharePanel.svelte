<script lang="ts">
  import { onDestroy } from 'svelte';
  import QRCode from 'qrcode';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import type { MobileSession } from '$lib/storage/db';
  import { v4 as uuid } from 'uuid';

  // ── Config ────────────────────────────────────────────────────────────────
  const REVEAL_SECONDS = 30;
  const DURATION_OPTIONS = [
    { label: '1 day',   days: 1  },
    { label: '3 days',  days: 3  },
    { label: '7 days',  days: 7  },
    { label: '14 days', days: 14 },
    { label: '30 days', days: 30 },
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let phase = $state<'warning' | 'revealed'>('warning');
  let revealTab = $state<'qr' | 'link'>('qr');
  let durationDays = $state(7);
  let serverHost = $state('');
  let serverPort = $state('5173');
  let detecting = $state(false);
  let generating = $state(false);
  let testing = $state(false);
  let testResult = $state<'ok' | 'fail' | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let generatedUrl = $state<string | null>(null);
  let linkCopied = $state(false);
  let countdown = $state(REVEAL_SECONDS);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let error = $state<string | null>(null);
  let justRevoked = $state<string | null>(null); // id of recently revoked session

  // ── Derived ───────────────────────────────────────────────────────────────
  const sessions = $derived(
    (settings().mobileSessions ?? [])
      .filter(s => s.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)
  );

  // SVG circle: r=44, circumference = 2π×44 ≈ 276.46
  const CIRC = 2 * Math.PI * 44;
  const dashOffset = $derived(CIRC * (1 - countdown / REVEAL_SECONDS));
  const ringColor = $derived(
    countdown <= 5  ? '#d4726d' :   // danger red
    countdown <= 10 ? '#f59e0b' :   // amber
    '#1a9b8e'                        // teal
  );
  const urgent = $derived(countdown <= 10);

  const accessUrl = $derived(
    serverHost.trim()
      ? `http://${serverHost.trim()}:${serverPort.trim()}`
      : ''
  );

  // ── Local IP detection via WebRTC ─────────────────────────────────────────
  // Uses a STUN server to ensure the browser gathers host candidates.
  // Without iceServers, many browsers skip local candidate gathering entirely.
  async function detectLocalIP() {
    detecting = true;
    error = null;
    testResult = null;
    try {
      const ip = await new Promise<string | null>((resolve) => {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        pc.createDataChannel('');
        pc.createOffer().then(o => pc.setLocalDescription(o));
        const candidates: string[] = [];
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            pc.close();
            // Prefer private LAN ranges: 192.168.x, 10.x, 172.16-31.x
            const lan = candidates.find(ip =>
              /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
            );
            resolve(lan ?? candidates[0] ?? null);
            return;
          }
          const m = e.candidate.candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
          if (m && !m[1].startsWith('127.') && !candidates.includes(m[1])) {
            candidates.push(m[1]);
          }
        };
        setTimeout(() => { pc.close(); resolve(candidates[0] ?? null); }, 4000);
      });
      if (ip) serverHost = ip;
      else error = 'Could not detect IP — run: ip addr show | grep "inet " in a terminal and enter it manually.';
    } finally {
      detecting = false;
    }
  }

  // ── Connection test ────────────────────────────────────────────────────────
  // Browsers block no-cors fetch to private IPs (CORS-RFC1918 / PNA).
  // Instead load a tiny image: onload = reachable, onerror = not reachable.
  function testConnection() {
    if (!accessUrl) return;
    testing = true;
    testResult = null;
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = img.onerror = null;
      testing = false;
      testResult = 'fail';
    }, 4000);
    img.onload = () => {
      clearTimeout(timer);
      testing = false;
      testResult = 'ok';
    };
    img.onerror = () => {
      // onerror fires even on CORS rejection — means the server responded
      clearTimeout(timer);
      testing = false;
      testResult = 'ok';
    };
    // favicon.png or any asset served by Vite; a 404 still means server is up
    img.src = `${accessUrl}/favicon.png?_=${Date.now()}`;
  }

  // ── Generate + reveal QR ──────────────────────────────────────────────────
  async function revealQR() {
    if (!accessUrl) { error = 'Enter the server address first.'; return; }
    generating = true;
    error = null;

    try {
      const token = uuid();
      const now = Date.now();
      const expiresAt = now + durationDays * 86_400_000;

      const url = `${accessUrl}/mobile?token=${token}&expires=${expiresAt}`;
      generatedUrl = url;

      qrDataUrl = await QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: '#e8f0f5', light: '#0d1520' },
        errorCorrectionLevel: 'M',
      });

      // Persist session
      const session: MobileSession = { id: uuid(), token, createdAt: now, expiresAt };
      const existing = settings().mobileSessions ?? [];
      await updateSettings({ mobileSessions: [...existing, session] });

      phase = 'revealed';
      countdown = REVEAL_SECONDS;
      startCountdown();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      generating = false;
    }
  }

  function startCountdown() {
    stopCountdown();
    countdownTimer = setInterval(() => {
      countdown--;
      if (countdown <= 0) hideQR();
    }, 1000);
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function hideQR() {
    stopCountdown();
    phase = 'warning';
    qrDataUrl = null;
    generatedUrl = null;
    linkCopied = false;
    revealTab = 'qr';
    countdown = REVEAL_SECONDS;
  }

  async function copyMagicLink() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      linkCopied = true;
      setTimeout(() => { linkCopied = false; }, 2500);
    } catch {
      // Fallback: select the text input
      const el = document.getElementById('magic-link-input') as HTMLInputElement | null;
      el?.select();
    }
  }

  async function shareMagicLink() {
    if (!generatedUrl || !navigator.share) return;
    try {
      await navigator.share({
        title: 'Reckons.AI access link',
        url: generatedUrl,
      });
    } catch { /* user cancelled */ }
  }

  async function revokeSession(id: string) {
    const updated = (settings().mobileSessions ?? []).filter(s => s.id !== id);
    await updateSettings({ mobileSessions: updated });
    justRevoked = id;
    setTimeout(() => { justRevoked = null; }, 1500);
  }

  async function revokeAll() {
    await updateSettings({ mobileSessions: [] });
  }

  function formatExpiry(ts: number): string {
    const d = new Date(ts);
    const diff = ts - Date.now();
    const days = Math.ceil(diff / 86_400_000);
    return days === 1 ? 'expires tomorrow' : `expires in ${days} days`;
  }

  onDestroy(stopCountdown);
</script>

<div class="qr-panel">

  <!-- ── Warning + config ─────────────────────────────────────────────────── -->
  {#if phase === 'warning'}
    <div class="warning-banner">
      <span class="warn-icon">⚠</span>
      <div>
        <strong>Mobile access grants read-write access to your graph.</strong>
        <p>The QR code will be visible for {REVEAL_SECONDS} seconds then auto-hide. Only scan on a device you own. Tokens are valid until revoked or expired.</p>
      </div>
    </div>

    <!-- Setup requirement notice -->
    <div class="setup-notice">
      <span class="setup-icon mono">$</span>
      <div>
        <p class="setup-line">The dev server must be started with <code>npm run dev -- --host</code></p>
        <p class="setup-line muted">Without <code>--host</code> it only listens on localhost and the phone cannot reach it regardless of firewall settings.</p>
      </div>
    </div>

    <div class="config-grid">
      <!-- Server address -->
      <div class="config-field">
        <label class="lbl mono">server address</label>
        <div class="host-row">
          <input
            type="text"
            bind:value={serverHost}
            oninput={() => testResult = null}
            placeholder="192.168.1.x"
            class="host-input"
          />
          <span class="port-sep mono">:</span>
          <input
            type="text"
            bind:value={serverPort}
            oninput={() => testResult = null}
            class="port-input"
            maxlength="5"
          />
          <button class="btn-detect" onclick={detectLocalIP} disabled={detecting}>
            {detecting ? '…' : 'detect'}
          </button>
        </div>
        {#if accessUrl}
          <div class="url-test-row">
            <p class="access-url mono">{accessUrl}/mobile</p>
            <button
              class="btn-test"
              class:test-ok={testResult === 'ok'}
              class:test-fail={testResult === 'fail'}
              onclick={testConnection}
              disabled={testing}
              title="Test whether this address is reachable from this machine"
            >
              {#if testing}
                testing…
              {:else if testResult === 'ok'}
                ✓ reachable
              {:else if testResult === 'fail'}
                ✗ not reachable
              {:else}
                test
              {/if}
            </button>
          </div>
          {#if testResult === 'fail'}
            <p class="test-hint mono">Server not reachable. Check that Vite is running with <code>--host</code> and the IP is correct.</p>
          {/if}
        {/if}
      </div>

      <!-- Duration -->
      <div class="config-field">
        <label class="lbl mono">token duration</label>
        <div class="duration-pills">
          {#each DURATION_OPTIONS as opt}
            <button
              class="dur-pill"
              class:active={durationDays === opt.days}
              onclick={() => durationDays = opt.days}
            >{opt.label}</button>
          {/each}
        </div>
        {#if durationDays === 30}
          <p class="dur-note mono">30-day max. Revoke from settings if the device is lost.</p>
        {/if}
      </div>
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <button
      class="btn-reveal"
      onclick={revealQR}
      disabled={generating || !serverHost.trim()}
    >
      {generating ? 'Generating…' : 'Reveal QR code'}
    </button>

  <!-- ── Revealed QR / Magic link ─────────────────────────────────────────── -->
  {:else}
    <!-- Mode tabs -->
    <div class="reveal-tabs">
      <button class="reveal-tab" class:active={revealTab === 'qr'} onclick={() => revealTab = 'qr'}>
        QR code
      </button>
      <button class="reveal-tab" class:active={revealTab === 'link'} onclick={() => revealTab = 'link'}>
        Magic link
      </button>
    </div>

    {#if revealTab === 'qr'}
      <div class="reveal-area">
        <!-- Circular countdown + QR -->
        <div class="qr-wrapper" class:urgent>
          <svg class="countdown-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="44" class="ring-track" />
            <circle
              cx="50" cy="50" r="44"
              class="ring-arc"
              stroke={ringColor}
              stroke-dasharray={CIRC}
              stroke-dashoffset={dashOffset}
              transform="rotate(-90 50 50)"
            />
          </svg>

          {#if qrDataUrl}
            <img src={qrDataUrl} alt="Mobile access QR code" class="qr-img" />
          {/if}

          <div class="countdown-badge" class:urgent>
            <span class="countdown-num" style="color: {ringColor}">{countdown}</span>
          </div>
        </div>

        <div class="reveal-meta">
          <p class="reveal-hint">Scan with the device's camera app.</p>
          <p class="reveal-hint mono">{accessUrl}/mobile</p>
          <p class="reveal-hint">
            Token valid for <strong>{durationDays} day{durationDays !== 1 ? 's' : ''}</strong>
            · QR hides in {countdown}s
          </p>
          <button class="btn-hide" onclick={hideQR}>Hide now</button>
        </div>
      </div>

    {:else}
      <!-- Magic link: copy/share the URL directly -->
      <div class="magic-link-area">
        <p class="reveal-hint">Send this link to your device via iMessage, email, or any app.</p>
        <p class="reveal-hint">
          Token valid for <strong>{durationDays} day{durationDays !== 1 ? 's' : ''}</strong>.
        </p>

        <div class="link-row">
          <input
            id="magic-link-input"
            type="text"
            class="link-input mono"
            value={generatedUrl ?? ''}
            readonly
            onclick={(e) => (e.target as HTMLInputElement).select()}
          />
        </div>

        <div class="link-actions">
          <button class="btn-copy" class:copied={linkCopied} onclick={copyMagicLink}>
            {linkCopied ? '✓ Copied' : 'Copy link'}
          </button>
          {#if typeof navigator !== 'undefined' && 'share' in navigator}
            <button class="btn-share" onclick={shareMagicLink}>Share…</button>
          {/if}
        </div>

        <button class="btn-hide" onclick={hideQR}>Done</button>
      </div>
    {/if}
  {/if}

  <!-- ── Active sessions ──────────────────────────────────────────────────── -->
  {#if sessions.length > 0}
    <div class="sessions">
      <div class="sessions-header">
        <span class="lbl mono">active sessions ({sessions.length})</span>
        <button class="btn-revoke-all" onclick={revokeAll}>revoke all</button>
      </div>
      {#each sessions as s}
        <div class="session-row" class:fading={justRevoked === s.id}>
          <div class="session-info">
            <span class="session-name mono">{s.deviceName ?? 'unnamed device'}</span>
            <span class="session-expiry mono">{formatExpiry(s.expiresAt)}</span>
          </div>
          <button class="btn-revoke" onclick={() => revokeSession(s.id)}>revoke</button>
        </div>
      {/each}
    </div>
  {:else if phase === 'warning'}
    <p class="no-sessions mono">no active sessions</p>
  {/if}

</div>

<style>
  .qr-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ── Warning banner ─────────────────────────────────────────────────────── */
  .warning-banner {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    background: #d4726d18;
    border: 1px solid #d4726d55;
    border-radius: var(--rad-sm);
    padding: 0.8rem 1rem;
  }

  .warn-icon {
    font-size: 1.1rem;
    color: #d4726d;
    flex-shrink: 0;
    margin-top: 0.05rem;
  }

  .warning-banner strong {
    font-size: 0.85rem;
    color: var(--ink-2);
    display: block;
    margin-bottom: 0.25rem;
  }

  .warning-banner p {
    font-size: 0.78rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.45;
  }

  /* ── Setup notice ───────────────────────────────────────────────────────── */
  .setup-notice {
    display: flex;
    gap: 0.65rem;
    align-items: flex-start;
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
    border-radius: var(--rad-sm);
    padding: 0.7rem 0.9rem;
  }
  .setup-icon {
    font-size: 0.78rem;
    color: var(--accent);
    flex-shrink: 0;
    margin-top: 0.05rem;
    opacity: 0.7;
  }
  .setup-line {
    font-size: 0.78rem;
    color: var(--ink-2);
    margin: 0 0 0.2rem;
    line-height: 1.4;
  }
  .setup-line.muted { color: var(--muted); margin: 0; }
  .setup-line code {
    font-family: var(--font-mono);
    background: var(--surface-2);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.76rem;
  }

  /* ── Config ─────────────────────────────────────────────────────────────── */
  .config-grid {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .config-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .lbl {
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .host-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .host-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    padding: 0.45rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
  }

  .port-sep {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .port-input {
    width: 5ch;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    padding: 0.45rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    text-align: center;
  }

  .host-input:focus,
  .port-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .btn-detect {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.4rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .btn-detect:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn-detect:disabled { opacity: 0.5; cursor: default; }

  .url-test-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .access-url {
    font-size: 0.7rem;
    color: var(--accent);
    margin: 0;
    word-break: break-all;
    flex: 1;
  }
  .btn-test {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .btn-test:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .btn-test:disabled { opacity: 0.5; cursor: default; }
  .btn-test.test-ok  { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .btn-test.test-fail { border-color: var(--danger, #d4726d); color: var(--danger, #d4726d); background: #d4726d11; }
  .test-hint {
    font-size: 0.68rem;
    color: var(--danger, #d4726d);
    margin: 0.2rem 0 0;
    line-height: 1.4;
  }
  .test-hint code {
    font-family: var(--font-mono);
    background: var(--surface-2);
    padding: 0.1rem 0.25rem;
    border-radius: 3px;
  }

  .duration-pills {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .dur-pill {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s;
  }
  .dur-pill.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
  .dur-pill:hover:not(.active) { background: var(--surface-3); color: var(--ink-2); }

  .dur-note {
    font-size: 0.68rem;
    color: var(--muted);
    margin: 0;
  }

  .error {
    font-size: 0.78rem;
    color: var(--danger);
    margin: 0;
  }

  .btn-reveal {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.6rem 1.2rem;
    font-size: 0.88rem;
    cursor: pointer;
    width: fit-content;
    transition: opacity 0.15s, transform 0.15s;
  }
  .btn-reveal:hover:not(:disabled) { opacity: 0.85; transform: translateY(-1px); }
  .btn-reveal:disabled { opacity: 0.45; cursor: default; }

  /* ── Reveal mode tabs ───────────────────────────────────────────────────── */
  .reveal-tabs {
    display: flex;
    gap: 0.35rem;
    border-bottom: 1px solid var(--line);
    padding-bottom: 0.6rem;
  }
  .reveal-tab {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 0.3rem 0.75rem;
    border-radius: var(--rad-sm);
    border: 1px solid transparent;
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s;
  }
  .reveal-tab:hover { color: var(--ink); background: var(--surface-2); }
  .reveal-tab.active {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  /* ── Magic link ─────────────────────────────────────────────────────────── */
  .magic-link-area {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .link-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .link-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--accent);
    padding: 0.55rem 0.75rem;
    font-size: 0.75rem;
    cursor: text;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-input:focus { outline: none; border-color: var(--accent); }
  .link-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .btn-copy {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.5rem 1rem;
    cursor: pointer;
    transition: opacity 0.15s, background 0.15s;
    min-width: 100px;
  }
  .btn-copy:hover { opacity: 0.85; }
  .btn-copy.copied { background: var(--ok); }
  .btn-share {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--surface-2);
    color: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.9rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-share:hover { border-color: var(--accent); color: var(--accent); }

  /* ── Revealed QR ────────────────────────────────────────────────────────── */
  .reveal-area {
    display: flex;
    gap: 2rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .qr-wrapper {
    position: relative;
    width: 196px;
    height: 196px;
    flex-shrink: 0;
  }

  .qr-wrapper.urgent {
    animation: pulse-urgent 0.8s ease-in-out infinite;
  }

  @keyframes pulse-urgent {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.015); }
  }

  .countdown-ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .ring-track {
    fill: none;
    stroke: var(--line);
    stroke-width: 3;
  }

  .ring-arc {
    fill: none;
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.95s linear, stroke 0.3s ease;
  }

  .qr-img {
    position: absolute;
    inset: 10px;
    width: calc(100% - 20px);
    height: calc(100% - 20px);
    border-radius: var(--rad-sm);
    display: block;
  }

  .countdown-badge {
    position: absolute;
    bottom: -10px;
    right: -10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.2rem 0.55rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .countdown-badge.urgent {
    border-color: #f59e0b;
    background: #f59e0b18;
  }

  .countdown-num {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1;
    transition: color 0.3s ease;
  }

  .reveal-meta {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .reveal-hint {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.4;
  }

  .reveal-hint strong { color: var(--ink-2); }

  .btn-hide {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    width: fit-content;
    margin-top: 0.4rem;
    transition: all 0.15s;
  }
  .btn-hide:hover { border-color: var(--danger); color: var(--danger); }

  /* ── Sessions ────────────────────────────────────────────────────────────── */
  .sessions {
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    overflow: hidden;
  }

  .sessions-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
  }

  .btn-revoke-all {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    background: none;
    border: 1px solid var(--line);
    color: var(--muted);
    border-radius: var(--rad-sm);
    padding: 0.15rem 0.45rem;
    cursor: pointer;
  }
  .btn-revoke-all:hover { border-color: var(--danger); color: var(--danger); }

  .session-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    transition: opacity 0.4s ease, background 0.15s;
    gap: 0.75rem;
  }

  .session-row:last-child { border-bottom: none; }
  .session-row.fading { opacity: 0.2; }
  .session-row:hover { background: var(--surface-2); }

  .session-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .session-name {
    font-size: 0.78rem;
    color: var(--ink-2);
  }

  .session-expiry {
    font-size: 0.68rem;
    color: var(--muted);
  }

  .btn-revoke {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    background: none;
    border: 1px solid var(--line);
    color: var(--muted);
    border-radius: var(--rad-sm);
    padding: 0.15rem 0.45rem;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .btn-revoke:hover { border-color: var(--danger); color: var(--danger); background: #d4726d11; }

  .no-sessions {
    font-size: 0.72rem;
    color: var(--muted-2);
    margin: 0;
  }
</style>
