<script lang="ts">
  import { statements, sources, loaded } from '$lib/stores/kb.svelte';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { repositoryProfiles, repositoryOverlap, repositoryMetric } from '$lib/rdf/repository-comparison';
  import { termLabel } from '$lib/rdf/statement-chunks';
  import StatementCard from '$lib/components/StatementCard.svelte';
  let baseline = $state(''), selected = $state<string[] | null>(null), search = $state(''), viewName = $state('Repository shortlist');
  let viewId = $state(''), error = $state(''), busy = $state(false), facets = $state(['languages', 'topics', 'insights']);
  let chosenStatements = $state<string[]>([]);
  const profiles = $derived(repositoryProfiles(statements()));
  const base = $derived(profiles.find(r => r.id === baseline) ?? profiles.find(r => r.name.toLowerCase() === 'data-insight-solutions/reckons.ai') ?? profiles[0]);
  const ranked = $derived(base ? [...profiles].sort((a, b) => (repositoryOverlap(base, b).score ?? -1) - (repositoryOverlap(base, a).score ?? -1) || a.name.localeCompare(b.name)) : []);
  const picks = $derived(selected !== null ? profiles.filter(r => selected?.includes(r.id)) : [base, ...ranked.filter(r => r.id !== base?.id).slice(0, 4)].filter(Boolean));
  const candidateList = $derived(ranked.filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase())).slice(0, 40));
  const insights = $derived(statements().filter(s => ['pending', 'confirmed', 'refined'].includes(s.status) && /\/(may-complement|may-be-alternative-to|may-share-strategy-with)$/.test(s.p.value) && picks.some(r => r.id === s.s.value || r.id === s.o.value)));
  function toggle(id: string, checked: boolean) {
    const ids = new Set(picks.map(r => r.id)); if (checked) { if (ids.size >= 6) { error = 'Compare up to six repositories at a time.'; return; } ids.add(id); } else ids.delete(id);
    selected = [...ids]; error = ''; viewId = '';
  }
  async function saveView() {
    if (!picks.length || !viewName.trim()) return; busy = true;
    try {
      const predicates = [ ...(facets.includes('languages') ? ['https://schema.org/programmingLanguage'] : []), ...(facets.includes('topics') ? ['https://schema.org/keywords'] : []), ...(facets.includes('insights') ? ['urn:kbase:predicate/may-complement', 'urn:kbase:predicate/may-be-alternative-to', 'urn:kbase:predicate/may-share-strategy-with'] : []) ];
      if (!predicates.length && !chosenStatements.length) throw new Error('Choose at least one relationship group or statement.');
      const view = { id: crypto.randomUUID(), name: viewName.trim().slice(0, 100), entities: picks.map(r => r.id), predicates, statementIds: chosenStatements };
      await updateSettings({ researchViews: [...(settings().researchViews ?? []), view] }); viewId = view.id; error = '';
    } catch (e) { error = e instanceof Error ? e.message : 'Could not save view.'; } finally { busy = false; }
  }
  async function removeView(id: string) { try { await updateSettings({ researchViews: settings().researchViews?.filter(v => v.id !== id) }); if (viewId === id) viewId = ''; } catch { error = 'Could not remove view.'; } }
</script>
<svelte:head><title>Repository comparisons — Reckons.AI</title></svelte:head>
<main>
  <a href="/">← Space</a><h1>Repository comparison views</h1>
  <p>Pick a few GitHub repositories from the space you are in and compare them side by side: what GitHub reports about each (stars, license, last push), how much their topics and languages overlap, and any reviewed comparisons. You can save the selection as a view that narrows the canvas to just those repositories.</p>
  {#if !loaded()}<p role="status">Loading this space…</p>{:else if !profiles.length}
    <p>The space you are in has no GitHub repositories in it. To compare your starred repositories:</p>
    <ol>
      <li>Build the starred-repositories file: <code>npx tsx scripts/research/github-stars.ts --refresh</code>. It is written outside the repository, to <code>~/.local/state/reckons/research/github-stars/github-stars.ttl</code>, because your stars are yours.</li>
      <li>On <a href="/kb">Spaces</a>, create a new space and switch to it.</li>
      <li>On <a href="/ingest">Add</a>, import that file as a Turtle file, then come back here.</li>
    </ol>
    <p>With about 20,000 statements it is also a good test of how a large space behaves.</p>
    <a href="/ingest">Add a source →</a>
  {:else}
    <div class="controls">
      <label>Compare against<select value={base?.id ?? ''} onchange={e => { baseline = e.currentTarget.value; selected = null; }}>
        {#each profiles as repo}<option value={repo.id}>{repo.name}</option>{/each}
      </select></label>
      <label>Find repositories<input bind:value={search} type="search" placeholder="Owner or repository name" /></label>
      <details><summary>Choose repositories ({picks.length} selected; {profiles.length} available)</summary><div class="choices">
        {#each candidateList as repo}<label><input type="checkbox" checked={picks.some(r => r.id === repo.id)} onchange={e => toggle(repo.id, e.currentTarget.checked)} /> {repo.name}</label>{/each}
        {#if candidateList.length === 40}<p>Showing 40 matches. Narrow the search to find others.</p>{/if}
      </div></details>
    </div>
    <p>Similarity is Jaccard overlap of publisher-applied topics and observed languages: shared values ÷ all distinct values. It measures overlap, not quality, speed or compatibility. Missing data stays unknown.</p>
    <div class="table-scroll"><table aria-label="Quantitative repository comparison"><thead><tr><th>Source observation</th>{#each picks as repo}<th><a href={repo.id} target="_blank" rel="noopener noreferrer">{repo.name}</a></th>{/each}</tr></thead>
      <tbody>
        <tr><th>Topic / language overlap with baseline</th>{#each picks as repo}<td>{base && repositoryOverlap(base, repo).score !== null ? `${Math.round(repositoryOverlap(base, repo).score! * 100)}%` : 'Unknown'}</td>{/each}</tr>
        {#each [['reported-star-count', 'GitHub stars (popularity)'], ['reported-license', 'License reported by GitHub'], ['reported-archived', 'Archived'], ['reported-last-push', 'Last pushed']] as [predicate, label]}
          <tr><th>{label}</th>{#each picks as repo}<td>{#each repositoryMetric(repo, predicate) as claim}<div>{claim.o.value}<br /><small>{#if sources().find(s => s.id === claim.sourceId)?.uri}<a href={sources().find(s => s.id === claim.sourceId)!.uri} target="_blank" rel="noopener noreferrer">Source</a> · {/if}{new Date(sources().find(s => s.id === claim.sourceId)?.ingestedAt ?? claim.updatedAt).toLocaleDateString()}</small></div>{:else}Unknown{/each}</td>{/each}</tr>
        {/each}
        <tr><th>Languages</th>{#each picks as repo}<td>{[...repo.languages].map(termLabel).join(', ') || 'Unknown'}</td>{/each}</tr>
        <tr><th>Topics</th>{#each picks as repo}<td>{[...repo.topics].map(termLabel).join(', ') || 'Unknown'}</td>{/each}</tr>
      </tbody></table></div>
    <h2>Qualitative comparisons</h2>
    <p>Publisher claims can suggest an experiment or tradeoff. Compatibility and performance require testing; a proposed advantage is not a benchmark.</p>
    {#each insights.slice(0, 15) as statement}
      <div class="insight"><label><input type="checkbox" bind:group={chosenStatements} value={statement.id} /> Include this statement in a precise view</label><small>{statement.status} · {new Date(statement.updatedAt).toLocaleDateString()}</small><StatementCard {statement} showGraph={false} /></div>
    {:else}<p>No cited comparison hypotheses in this selection yet. Add or review source-backed proposals; metric overlap alone does not generate a strategic conclusion.</p>{/each}
    {#if insights.length > 15}<p>Showing 15 of {insights.length} matching comparisons. Narrow the repository selection to inspect others.</p>{/if}
    <section><h2>Save a focused view</h2>
      <label>View name<input bind:value={viewName} maxlength="100" /></label>
      <div class="facets">{#each ['languages', 'topics', 'insights'] as facet}<label><input type="checkbox" bind:group={facets} value={facet} /> {facet}</label>{/each}</div>
      <p>Includes {picks.length} selected entities and their chosen relationships. Selecting specific statements limits the view to those assertions and entity labels.</p>
      <button onclick={saveView} disabled={busy || !viewName.trim() || !picks.length}>Save space view</button>
      {#if viewId}<p role="status">View saved. <a href={`/?view=${encodeURIComponent(viewId)}`}>Open focused canvas →</a></p>{/if}
    </section>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if settings().researchViews?.length}<h2>Saved views</h2>{#each settings().researchViews ?? [] as view}<p><a href={`/?view=${encodeURIComponent(view.id)}`}>{view.name}</a> ({view.entities.length} selected entities) <button onclick={() => removeView(view.id)}>Remove view</button></p>{/each}{/if}
  <p><a href="/settings/triple-check">Configure Triple Check →</a></p>
</main>
<style>
  main { max-width: 1250px; margin: 1.5rem auto; padding: 0 1rem 5rem; color: var(--ink); } p { line-height: 1.6; } a, summary { color: var(--accent); }
  .controls { display: grid; gap: 0.8rem; } label { display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem; } input, select { max-width: 100%; background: var(--surface); color: var(--ink); border: 1px solid var(--line); padding: 0.4rem; }
  .choices { max-height: 320px; overflow: auto; padding: 0.8rem; } .choices label { min-height: 36px; } .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--rad); }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; } th, td { padding: 0.8rem; border: 1px solid var(--line); text-align: left; vertical-align: top; min-width: 160px; overflow-wrap: anywhere; } small { color: var(--muted); } .insight, section { border: 1px solid var(--line); border-radius: var(--rad); padding: 1rem; margin: 1rem 0; } .facets { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; } button { padding: 0.5rem; }
</style>
