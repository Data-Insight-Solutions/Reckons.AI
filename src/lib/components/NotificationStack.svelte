<script lang="ts">
  import { page } from '$app/state';
  import { notifications, dismissNotification, notificationStackHeight } from '$lib/stores/notifications.svelte';

  const MAX_VISIBLE = 3;

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

  // Collapse state. The stack sits at the top-right; on the main graph view ('/') the top-right is
  // free, but on other views (Review, Settings…) it overlaps the side panel. So collapse into a
  // corner bell by DEFAULT on any non-home route, and let the user toggle it open per view.
  // `userToggle` is the per-view override; it resets whenever the route changes.
  let userToggle = $state<boolean | null>(null);
  let lastPath = $state(page.url.pathname);
  $effect(() => {
    if (page.url.pathname !== lastPath) { lastPath = page.url.pathname; userToggle = null; }
  });
  const routeWantsCollapse = $derived(page.url.pathname !== '/');
  const collapsed = $derived(userToggle ?? routeWantsCollapse);

  // Highest-severity type present, for the bell tint (warn > success > info).
  const bellColor = $derived.by(() => {
    const list = notifications();
    if (list.some((n) => n.type === 'warn')) return typeColor.warn;
    if (list.some((n) => n.type === 'success')) return typeColor.success;
    return typeColor.info;
  });

  let stackEl = $state<HTMLDivElement | undefined>(undefined);

  // Keep the reactive store in sync with the ACTUAL rendered height so the node panel's max-height
  // leaves room. When collapsed to the bell, the stack occupies no vertical space → report 0.
  $effect(() => {
    notifications(); // re-run on add/remove
    if (collapsed) { notificationStackHeight.set(0); return; }
    let ro: ResizeObserver | undefined;
    const id = requestAnimationFrame(() => {
      const el = stackEl;
      if (!el) { notificationStackHeight.set(0); return; }
      notificationStackHeight.set(el.offsetHeight);
      ro = new ResizeObserver(() => notificationStackHeight.set(el.offsetHeight));
      ro.observe(el);
    });
    return () => { cancelAnimationFrame(id); ro?.disconnect(); };
  });
</script>

{#if notifications().length > 0}
  <!-- Corner bell — always in the very top-right; clicking toggles the stack open/closed. -->
  <button
    class="notif-bell"
    class:has-open={!collapsed}
    style:--bell-c={bellColor}
    onclick={() => { userToggle = !collapsed; }}
    aria-label={collapsed ? `Show ${notifications().length} notification${notifications().length === 1 ? '' : 's'}` : 'Collapse notifications'}
    aria-expanded={!collapsed}
    title={collapsed ? 'Show notifications' : 'Collapse notifications'}
  >
    <span class="bell-glyph" aria-hidden="true">🔔</span>
    <span class="bell-badge mono">{notifications().length > 99 ? '99+' : notifications().length}</span>
  </button>

  {#if !collapsed}
    <div class="notification-stack" aria-live="polite" bind:this={stackEl}>
      {#each notifications().slice(0, MAX_VISIBLE) as n (n.id)}
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
      {#if notifications().length > MAX_VISIBLE}
        <div class="notif-overflow mono">
          +{notifications().length - MAX_VISIBLE} more
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* Corner bell: the very top-right, above the stack (z-600) and everything else. */
  .notif-bell {
    position: fixed;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 601;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 2px solid var(--bell-c, var(--accent));
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    backdrop-filter: blur(8px);
    cursor: pointer;
    transition: transform 0.12s ease-out, border-color 0.15s;
  }
  .notif-bell:hover { transform: scale(1.08); }
  .notif-bell.has-open { border-color: var(--bell-c, var(--accent)); }
  .bell-glyph { font-size: 0.9rem; line-height: 1; filter: grayscale(0.1); }
  .bell-badge {
    position: absolute;
    top: -0.3rem;
    right: -0.3rem;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6rem;
    font-weight: 700;
    color: #fff;
    background: var(--bell-c, var(--accent));
    border-radius: 999px;
    line-height: 1;
  }

  .notification-stack {
    position: fixed;
    top: 3rem; /* below the corner bell */
    right: 0.75rem;
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

  .notif-overflow {
    font-size: 0.68rem;
    color: var(--muted);
    text-align: right;
    padding: 0.15rem 0.5rem;
    pointer-events: none;
  }
</style>
