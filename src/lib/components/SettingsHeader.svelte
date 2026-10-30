<script lang="ts">
  /**
   * The one header every settings page shares: kicker, title, and the row of settings pages.
   *
   * It was copied by hand into five pages, each copy a little different (one linked "← graph"
   * where the others linked analyze history; one forgot to mark itself active), and the sixth
   * page, Triple Check, shipped with no header at all. The page list lives here once now, so a
   * new settings page is one line in SETTINGS_PAGES. A page's own section links go in `toc`.
   */
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';

  let { aside, toc }: { aside?: Snippet; toc?: Snippet } = $props();

  const SETTINGS_PAGES = [
    { href: '/settings', label: 'backends' },
    { href: '/settings/integrations', label: 'integrations' },
    { href: '/settings/triple-check', label: 'triple check' },
    { href: '/settings/publishing', label: 'publishing' },
    { href: '/settings/turtle', label: 'turtle' },
    { href: '/settings/entity-types', label: 'entity types' },
  ];
  const current = $derived(page.url.pathname.replace(/\/$/, '') || '/settings');
</script>

<header class="settings-head">
  <p class="settings-kicker mono">settings</p>
  <div class="settings-title-row">
    <h1>system configuration</h1>
    {@render aside?.()}
  </div>
  <nav class="settings-pages" aria-label="Settings pages">
    {#each SETTINGS_PAGES as p (p.href)}
      <a href={p.href} class="settings-page-link" class:active={current === p.href} aria-current={current === p.href ? 'page' : undefined}>{p.label}</a>
    {/each}
    <a href="/analyze" class="settings-page-link">analyze history ↗</a>
  </nav>
  {@render toc?.()}
</header>

<style>
  .settings-head { margin-bottom: 1.25rem; }
  .settings-kicker {
    color: var(--accent);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .settings-title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .settings-pages {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    border-bottom: 1px solid var(--line);
    padding-bottom: 0.75rem;
    /* Wrap rather than scroll: seven links are wider than the settings column (Matt, staging 2026-10-08). */
    flex-wrap: wrap;
  }
  .settings-page-link {
    padding: 0.35rem 0.6rem;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    border: 1px solid transparent;
    transition: all 0.15s;
    white-space: nowrap;
    text-decoration: none;
  }
  .settings-page-link:hover { color: var(--ink-2); border-color: var(--muted-2); }
  .settings-page-link.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
</style>
