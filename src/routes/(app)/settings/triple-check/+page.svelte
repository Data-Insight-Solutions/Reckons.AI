<script lang="ts">
  import SettingsHeader from '$lib/components/SettingsHeader.svelte';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { getRegistry, getCurrentKbId } from '$lib/storage/kb-registry';
  import { openExampleSpace } from '$lib/storage/example-space';
  import { tripleCheckStatus } from '$lib/stores/triple-check.svelte';
  import { dailyLimit } from '$lib/rdf/triple-check';
  import type { SettingsRecord } from '$lib/storage/db';
  let error = $state(''), saved = $state(false), saving = $state(false);
  const spaces = getRegistry().filter(s => s.id !== getCurrentKbId() && !s.archiveOf);
  async function save(patch: Partial<SettingsRecord>) {
    saving = true; saved = false;
    try { await updateSettings(patch); saved = true; error = ''; } catch { error = 'Could not save settings. Please retry.'; } finally { saving = false; }
  }
  function reference(id: string, enabled: boolean) {
    const ids = new Set(settings().tripleCheckReferenceSpaceIds ?? []); if (enabled) ids.add(id); else ids.delete(id);
    return save({ tripleCheckReferenceSpaceIds: [...ids] });
  }
  async function walkthrough() { try { await openExampleSpace('/starter-triple-check.ttl', 'Triple Check walkthrough', { story: true }); } catch { error = 'Could not open the walkthrough.'; } }
</script>
<svelte:head><title>Triple Check — Reckons.AI</title></svelte:head>
<main>
  <SettingsHeader />
  <h2 class="page-title">Triple Check</h2>
  <p>Checks statements in this space against your other spaces and, if you allow it, the internet. What it finds arrives in <a href="/review?group=source">Review</a> as pending statements from a new source: a source that agrees becomes a second source for the statement, and one that disagrees becomes its own statement beside it.</p>
  <section class="walkthrough">
    <h2>New to Triple Check?</h2>
    <p>Open a small example space where four documents disagree about a fictional home battery, together with an owners' forum it is checked against. A guided story walks you through turning checking on and reviewing what it adds. Both open as their own spaces; nothing here changes.</p>
    <button onclick={walkthrough}>Open the walkthrough space</button>
    <p class="hint">Triple Check works in any space, including the other examples on the <a href="/about">About</a> page.</p>
  </section>
  <fieldset disabled={saving}>
    <label><input type="checkbox" checked={settings().tripleCheckEnabled === true} onchange={e => save({ tripleCheckEnabled: e.currentTarget.checked })} /> Keep Triple Check on for this space</label>
    <p>Checks one pending or retained assertion at a time, about once a minute while the app is open. New and changed statements are picked up automatically. Successful checks refresh after seven days; incomplete checks retry after an hour. Nothing it adds is accepted without you, and a statement you rejected is not proposed again.</p>
    <label><input type="checkbox" checked={settings().tripleCheckWebEnabled !== false} onchange={e => save({ tripleCheckWebEnabled: e.currentTarget.checked })} /> Check the internet</label>
    <p>Free and local. Web checking runs a search through a SearXNG instance on this machine, which asks public search engines for the statement's wording (a plain GET), and judges the passages with a model on this device. No account, no key and no hosted service is used. Turn it off for sensitive statements.</p>
    <label>Web checks per 24 hours<input type="number" min="1" max="100" value={dailyLimit(settings().tripleCheckDailyLimit)} onchange={e => save({ tripleCheckDailyLimit: dailyLimit(e.currentTarget.valueAsNumber) })} /></label>
    <label>SearXNG address<input value={settings().searxngBaseUrl ?? ''} onchange={e => save({ searxngBaseUrl: e.currentTarget.value.trim() || undefined })} placeholder="http://localhost:8888" /></label>
    <p>Must be on this machine. The instance must allow JSON results and this app's address (CORS).</p>
    <label>Evidence model<select value={settings().tripleCheckBackend ?? 'ollama'} onchange={e => save({ tripleCheckBackend: e.currentTarget.value as SettingsRecord['tripleCheckBackend'] })}><option value="ollama">Ollama on this machine</option><option value="wasm">In-browser model</option><option value="chrome-ai">Chrome built-in model</option></select></label>
    <label>Model override<input value={settings().tripleCheckModel ?? ''} onchange={e => save({ tripleCheckModel: e.currentTarget.value.trim() })} placeholder="Use configured provider model" /></label>
    <p>Each web check makes one local search and one local model call. Hosted search, scraping and model services are not used here, whatever is chosen elsewhere in the app.</p>
    <h2>Reference spaces</h2>
    <p>All registered spaces are compared locally, excluding archives. Mark taxonomy or domain spaces to prioritize their definitions. Repeated assertions retain their source links and are checked once.</p>
    {#each spaces as space}<label><input type="checkbox" checked={settings().tripleCheckReferenceSpaceIds?.includes(space.id) ?? false} onchange={e => reference(space.id, e.currentTarget.checked)} /> {space.name}</label>{/each}
    <label><input type="checkbox" checked={settings().tripleCheckSpaceAnalysis === true} onchange={e => save({ tripleCheckSpaceAnalysis: e.currentTarget.checked })} /> Compare meaning with Ollama</label>
    <p>Optional: sends up to eight matching passages to your configured Ollama endpoint and analysis model. Two different values it judges compatible are not proposed as a disagreement. Exact comparisons work without it. This local feature does not provide enterprise RBAC or shared-space access controls.</p>
  </fieldset>
  {#if saved}<p role="status">Settings saved</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
  {#if settings().tripleCheckEnabled}<p role="status">{tripleCheckStatus()}</p>{/if}
  <p><a href="/review?group=source">Review what it found →</a> · <a href="/compare/repositories">Repository comparison views →</a></p>
</main>
<style>
  main { max-width: 850px; margin: 1.5rem auto; padding: 0 1rem 5rem; color: var(--ink); } fieldset { border: 1px solid var(--line); border-radius: var(--rad); padding: 1rem; }
  label { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0.8rem 0; } input:not([type='checkbox']), select { max-width: 100%; padding: 0.4rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
  p { line-height: 1.6; } fieldset p, .hint { color: var(--muted); font-size: 0.85rem; } a { color: var(--accent); }
  .page-title { font-family: var(--font-mono); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); margin: 0 0 0.5rem; }
  .walkthrough { border: 1px solid var(--accent); border-radius: var(--rad); padding: 1rem; margin: 1rem 0; }
  .walkthrough h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  .walkthrough button { padding: 0.5rem 0.8rem; background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent); border-radius: var(--rad-sm); cursor: pointer; }
</style>
