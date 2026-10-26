<script lang="ts">
  import { onMount } from 'svelte';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { getRegistry, getCurrentKbId } from '$lib/storage/kb-registry';
  import { openExampleSpace } from '$lib/storage/example-space';
  import { tripleCheckStatus } from '$lib/stores/triple-check.svelte';
  import { dailyLimit } from '$lib/rdf/triple-check';
  import type { SettingsRecord } from '$lib/storage/db';
  let error = $state(''), saved = $state(false), saving = $state(false);
  let examples = $state<{ file: string; triples: number }[]>([]);
  const spaces = getRegistry().filter(s => s.id !== getCurrentKbId() && !s.archiveOf);
  onMount(() => { fetch('/triple-check-examples.json').then(r => r.json()).then(rows => { examples = rows; }).catch(() => { error = 'Example catalog unavailable.'; }); });
  async function save(patch: Partial<SettingsRecord>) {
    saving = true; saved = false;
    try { await updateSettings(patch); saved = true; error = ''; } catch { error = 'Could not save settings. Please retry.'; } finally { saving = false; }
  }
  function reference(id: string, enabled: boolean) {
    const ids = new Set(settings().tripleCheckReferenceSpaceIds ?? []); if (enabled) ids.add(id); else ids.delete(id);
    return save({ tripleCheckReferenceSpaceIds: [...ids] });
  }
  async function example(file: string) { try { await openExampleSpace(file, file.slice(1).replace(/\.ttl$/, '').replace(/-/g, ' ')); } catch { error = 'Could not open the example.'; } }
</script>
<svelte:head><title>Triple Check — Reckons.AI</title></svelte:head>
<main>
  <a href="/settings">← Settings</a><h1>Triple Check</h1>
  <p>Check unique statements against the internet and all spaces on this device. Review cited support, possible conflicts and wording suggestions.</p>
  <fieldset disabled={saving}>
    <label><input type="checkbox" checked={settings().tripleCheckEnabled === true} onchange={e => save({ tripleCheckEnabled: e.currentTarget.checked })} /> Keep Triple Check on for this space</label>
    <p>Checks one pending or retained assertion at a time, about once a minute while the app is open. New and changed statements are picked up automatically. Successful checks refresh after seven days; incomplete checks retry after an hour. Suggestions never settle assertions.</p>
    <label><input type="checkbox" checked={settings().tripleCheckWebEnabled !== false} onchange={e => save({ tripleCheckWebEnabled: e.currentTarget.checked })} /> Check the internet</label>
    <p>Web checking sends each checked statement to your selected search service and evidence model. Turn it off for sensitive statements. Search, scraping and model calls may incur charges.</p>
    <label>Web checks per 24 hours<input type="number" min="1" max="100" value={dailyLimit(settings().tripleCheckDailyLimit)} onchange={e => save({ tripleCheckDailyLimit: dailyLimit(e.currentTarget.valueAsNumber) })} /></label>
    <label>Search service<select value={settings().tripleCheckSearch ?? 'tavily'} onchange={e => save({ tripleCheckSearch: e.currentTarget.value as SettingsRecord['tripleCheckSearch'] })}><option value="tavily">Tavily</option><option value="firecrawl">Firecrawl</option></select></label>
    <label>Read evidence from<select value={settings().tripleCheckScrape ?? 'snippets'} onchange={e => save({ tripleCheckScrape: e.currentTarget.value as SettingsRecord['tripleCheckScrape'] })}><option value="snippets">Search passages</option><option value="firecrawl">Full pages through Firecrawl</option></select></label>
    <label>Evidence model provider<select value={settings().tripleCheckBackend ?? ''} onchange={e => save({ tripleCheckBackend: (e.currentTarget.value || undefined) as SettingsRecord['tripleCheckBackend'] })}><option value="">Use analysis provider</option>{#each ['ollama', 'claude', 'openai', 'gemini', 'openrouter', 'reckons'] as p}<option value={p}>{p}</option>{/each}</select></label>
    <label>Model override<input value={settings().tripleCheckModel ?? ''} onchange={e => save({ tripleCheckModel: e.currentTarget.value.trim() })} placeholder="Use configured provider model" /></label>
    <p>Each web check makes one search, up to five page reads and one model call. Uses your <a href="/settings/integrations">integration credentials</a>. Missing providers are reported; no automatic provider fallback.</p>
    <h2>Reference spaces</h2>
    <p>All registered spaces are compared locally, excluding archives. Mark taxonomy or domain spaces to prioritize their definitions. Repeated assertions retain their source links and are checked once.</p>
    {#each spaces as space}<label><input type="checkbox" checked={settings().tripleCheckReferenceSpaceIds?.includes(space.id) ?? false} onchange={e => reference(space.id, e.currentTarget.checked)} /> {space.name}</label>{/each}
    <label><input type="checkbox" checked={settings().tripleCheckSpaceAnalysis === true} onchange={e => save({ tripleCheckSpaceAnalysis: e.currentTarget.checked })} /> Compare meaning and suggest corrections with Ollama</label>
    <p>Optional: sends up to eight matching passages to your configured Ollama endpoint and analysis model. Lexical comparisons work without it. This local feature does not provide enterprise RBAC or shared-space access controls.</p>
  </fieldset>
  {#if saved}<p role="status">Settings saved</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
  {#if settings().tripleCheckEnabled}<p role="status">{tripleCheckStatus()}</p>{/if}
  <p><a href="/review#triple-check">Review evidence →</a> · <a href="/compare/repositories">Repository comparison views →</a></p>
  <details><summary>Research workflow and bundled examples</summary><ol><li>Extract assertions with their sources.</li><li>Choose integrations and reference spaces.</li><li>Enable checking and inspect conflicting passages, including within the same space.</li><li>Accept, refine, reject or ignore suggestions.</li><li>Use <a href="/analyze">Analyze</a> to organize a changed purpose.</li></ol>
  {#each examples as e}<p><button onclick={() => example(e.file)}>{e.file.slice(1)} ({e.triples} RDF records)</button></p>{/each}
  <p>Examples open separately and preserve earlier edits. Checking starts disabled.</p></details>
</main>
<style>
  main { max-width: 850px; margin: 1.5rem auto; padding: 0 1rem 5rem; color: var(--ink); } fieldset { border: 1px solid var(--line); border-radius: var(--rad); padding: 1rem; }
  label { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0.8rem 0; } input:not([type='checkbox']), select { max-width: 100%; padding: 0.4rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
  p, li { line-height: 1.6; } fieldset p { color: var(--muted); font-size: 0.85rem; } a, summary { color: var(--accent); } details { border-top: 1px solid var(--line); padding-top: 1rem; }
</style>
