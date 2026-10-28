<script lang="ts">
  /**
   * The first thing a review LINK shows when the workspace is not ready to answer it.
   * Decision logic lives in $lib/review/link-landing.ts; this only renders it. Never shows a
   * proposal count: while the folder is unread, the count is unknown, not zero.
   */
  import type { LandingKind } from '$lib/review/link-landing';

  interface Props {
    kind: LandingKind;
    folder: string | null;
    origin: string;
    filter: string;
    busy?: boolean;
    onreconnect: () => void;
    onlink: () => void;
  }
  let { kind, folder, origin, filter, busy = false, onreconnect, onlink }: Props = $props();
</script>

{#if kind === 'checking'}
  <p class="rll-note mono" role="status">Checking this browser for a linked workspace folder…</p>
{:else if kind === 'reconnect'}
  <section class="rll-card" aria-live="polite">
    <p class="rll-why">
      This link points at proposals waiting in your workspace folder{filter ? `, filtered to ${filter}` : ''}. The
      browser asks for permission once per session, and that cannot happen without a click.
    </p>
    <button class="rll-primary" type="button" disabled={busy} onclick={onreconnect}>
      Reconnect {folder ?? 'your workspace folder'} to load the proposals this link points at
    </button>
  </section>
{:else if kind === 'loading'}
  <p class="rll-note mono" role="status">loading from {folder ?? 'the workspace folder'}…</p>
{:else if kind === 'unlinked'}
  <section class="rll-card" aria-live="polite">
    <p class="rll-why">
      This browser address, <span class="mono">{origin}</span>, has no workspace folder linked. Each
      address keeps its own settings, so a folder linked at another address does not carry over here.
    </p>
    <button class="rll-primary" type="button" disabled={busy} onclick={onlink}>
      Link a workspace folder at {origin}
    </button>
  </section>
{/if}

<style>
  .rll-card {
    display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start;
    margin: 0.75rem 0; padding: 0.9rem 1rem;
    background: var(--surface); border: 1px solid var(--accent); border-radius: var(--rad-sm);
  }
  .rll-why { margin: 0; color: var(--ink); font-size: 0.85rem; line-height: 1.45; }
  .rll-note { margin: 0.75rem 0; color: var(--muted); font-size: 0.8rem; }
  .rll-primary {
    cursor: pointer; padding: 0.6rem 1rem; font: inherit; font-size: 0.9rem; font-weight: 600;
    background: var(--accent); color: var(--bg); border: none; border-radius: 6px;
  }
  .rll-primary:disabled { opacity: 0.6; cursor: progress; }
</style>
