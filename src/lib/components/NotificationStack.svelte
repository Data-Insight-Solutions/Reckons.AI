<script lang="ts">
  import { notifications, dismissNotification } from '$lib/stores/notifications.svelte';

  const typeIcon: Record<string, string> = {
    info: 'ℹ',
    success: '✓',
    warn: '⚠',
  };

  const typeColor: Record<string, string> = {
    info: 'var(--accent)',
    success: 'var(--ok, #4caf50)',
    warn: '#f59e0b',
  };
</script>

{#if notifications().length > 0}
  <div class="notification-stack" aria-live="polite">
    {#each notifications() as n (n.id)}
      <div class="notification" style:--nc={typeColor[n.type]}>
        <span class="notif-icon" style:color={typeColor[n.type]}>{typeIcon[n.type]}</span>
        <div class="notif-body">
          <p class="notif-title">{n.title}</p>
          {#if n.body}
            <p class="notif-text">{n.body}</p>
          {/if}
          {#if n.action}
            {#if n.action.href}
              <a class="notif-action" href={n.action.href}>{n.action.label}</a>
            {:else}
              <button class="notif-action" onclick={() => { n.action?.onclick?.(); dismissNotification(n.id); }}>{n.action.label}</button>
            {/if}
          {/if}
        </div>
        <button class="notif-close" onclick={() => dismissNotification(n.id)} aria-label="dismiss">✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .notification-stack {
    position: fixed;
    top: 4rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 600;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 300px;
    pointer-events: none;
  }

  .notification {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 3px solid var(--nc);
    border-radius: var(--rad-sm);
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    backdrop-filter: blur(8px);
    pointer-events: all;
    animation: notif-in 0.18s ease-out;
  }

  @keyframes notif-in {
    from { opacity: 0; transform: translateX(1rem); }
    to   { opacity: 1; transform: translateX(0); }
  }

  .notif-icon {
    font-size: 0.85rem;
    flex-shrink: 0;
    padding-top: 0.05rem;
  }

  .notif-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .notif-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--ink);
    margin: 0;
    line-height: 1.3;
  }

  .notif-text {
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.45;
  }

  .notif-action {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--nc);
    background: none;
    border: none;
    border-bottom: 1px solid var(--nc);
    padding: 0;
    cursor: pointer;
    text-decoration: none;
    align-self: flex-start;
    transition: opacity 0.15s;
    margin-top: 0.1rem;
  }
  .notif-action:hover { opacity: 0.75; }

  .notif-close {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.7rem;
    padding: 0.1rem 0.25rem;
    border-radius: 3px;
    flex-shrink: 0;
    transition: color 0.15s;
    line-height: 1;
  }
  .notif-close:hover { color: var(--ink); }
</style>
