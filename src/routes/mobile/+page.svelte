<script lang="ts">
  /**
   * /mobile — lightweight landing for QR-linked devices.
   *
   * Reads ?token=<uuid>&expires=<timestamp> from the URL.
   * Validates against stored mobileSessions in the shared IndexedDB
   * (same origin = same DB whether accessed from desktop or mobile browser).
   *
   * On success: redirects to /reckoning (voice-friendly STP workflow).
   * On failure: shows a clear rejection message.
   */

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { settings, loadSettings } from '$lib/stores/settings.svelte';
  import { validateMobileToken } from '$lib/utils/mobile-auth';

  type State = 'checking' | 'valid' | 'invalid' | 'expired';

  let state = $state<State>('checking');
  let reason = $state('');
  let countdown = $state(3);

  onMount(async () => {
    await loadSettings();

    const params = new URL(window.location.href).searchParams;
    const result = validateMobileToken(
      params.get('token'),
      params.get('expires'),
      settings().mobileSessions ?? []
    );

    if (result.state !== 'valid') {
      state = result.state;
      reason = result.reason;
      return;
    }

    state = 'valid';

    // Count down then redirect to the Reckoning (voice-first workflow)
    const t = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(t);
        goto('/reckoning?mode=voice');
      }
    }, 1000);
  });
</script>

<svelte:head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
</svelte:head>

<div class="mobile-gate">
  <p class="wordmark">Reckons.AI</p>

  {#if state === 'checking'}
    <div class="status">
      <span class="spinner"></span>
      <p>Verifying access…</p>
    </div>

  {:else if state === 'valid'}
    <div class="status valid">
      <span class="check">✓</span>
      <p>Access granted.</p>
      <p class="sub">Opening in {countdown}s…</p>
      <a href="/reckoning?mode=voice" class="btn-enter">Open now →</a>
    </div>

  {:else if state === 'expired'}
    <div class="status invalid">
      <span class="x">⏱</span>
      <p>QR code expired.</p>
      <p class="sub">{reason}</p>
    </div>

  {:else}
    <div class="status invalid">
      <span class="x">✕</span>
      <p>Access denied.</p>
      <p class="sub">{reason}</p>
    </div>
  {/if}
</div>

<style>
  .mobile-gate {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    padding: 2rem;
    text-align: center;
  }

  .wordmark {
    font-family: var(--font-display);
    font-size: 2.2rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.03em;
    margin: 0;
  }

  .status {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }

  .status p { margin: 0; font-size: 1rem; color: var(--ink-2); }
  .sub { font-size: 0.82rem; color: var(--muted); max-width: 280px; line-height: 1.5; }

  .spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .check {
    font-size: 2rem;
    color: var(--ok);
  }
  .x {
    font-size: 2rem;
    color: var(--danger);
  }

  .btn-enter {
    margin-top: 0.4rem;
    background: var(--accent);
    color: #fff;
    padding: 0.65rem 1.4rem;
    border-radius: var(--rad);
    text-decoration: none;
    font-size: 0.95rem;
    transition: opacity 0.15s;
  }
  .btn-enter:hover { opacity: 0.85; }
</style>
