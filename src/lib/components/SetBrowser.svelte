<script lang="ts">
  import type { ProvenanceIndex, ProvenanceSource, ProvenanceGroup } from '$lib/rdf/provenance-view';

  let { index, sources, mode, assetFor, onselect } = $props<{
    index: ProvenanceIndex;
    sources: ProvenanceSource[];
    mode: 'folders' | 'list' | 'gallery';
    assetFor: (iri: string) => { kind: 'image' | 'video' | 'glb'; url: string } | null;
    onselect: (key: string) => void;
  }>();
  const groups = $derived((sources as ProvenanceSource[]).flatMap((source) => source.groups.map((group) => ({ source, group }))));
  const label = (key: string) => index.entities.get(key)?.label ?? key.slice(2);
  function preview(group: ProvenanceGroup) {
    return group.members.map((key) => ({ key, label: label(key), asset: assetFor(key.slice(2)) })).slice(0, 4);
  }
</script>

<section class="set-browser" aria-label={`${mode === 'folders' ? 'Folders' : mode === 'list' ? 'List' : 'Gallery'} of source sets`}>
  <header><div><p class="eyebrow">Sources / Sets</p><h2>Your source sets</h2></div><span>{sources.length} sources · {groups.length} sets</span></header>
  <p class="explanation">Sets collect the entities each source contributed to. Open one to inspect its members and original statements.</p>
  {#if !sources.length}
    <div class="empty"><h3>Select sources to explore</h3><p>Choose up to five sources from the source picker.</p></div>
  {:else if mode === 'folders'}
    <div class="folder-tree">
      {#each sources as source (source.id)}
        <details class="source-folder" open>
          <summary><span class="folder-icon" aria-hidden="true">▱</span>{source.title}<small>{source.groups.length} sets</small></summary>
          <button class="inspect" onclick={() => onselect(source.key)}>Source details →</button>
          {#each source.groups as group (group.key)}
            <details class="set-folder">
              <summary><span class="set-icon" aria-hidden="true">▦</span>{group.label}<small>{group.members.length} members</small></summary>
              <button class="inspect" onclick={() => onselect(group.key)}>Inspect set →</button>
              <ul>{#each group.members as key (key)}<li><button onclick={() => onselect(key)}>{label(key)}</button></li>{/each}</ul>
            </details>
          {/each}
          {#if !source.groups.length}<p>No active entity statements are retained for this source.</p>{/if}
        </details>
      {/each}
    </div>
  {:else if mode === 'list'}
    <div class="table-scroll"><table>
      <thead><tr><th>Set</th><th>Source</th><th>Members</th><th>Statements</th></tr></thead>
      <tbody>{#each groups as { source, group } (group.key)}
        <tr><td><button class="set-link" onclick={() => onselect(group.key)}><span aria-hidden="true">▦</span>{group.label}</button>
          <small>{group.members.slice(0, 3).map(label).join(', ')}{group.members.length > 3 ? '…' : ''}</small></td>
          <td><button class="source-link" onclick={() => onselect(source.key)}>{source.title}</button></td>
          <td>{group.members.length}</td><td>{group.statementIds.length}</td></tr>
      {/each}</tbody>
    </table></div>
    {#each sources.filter((source: ProvenanceSource) => !source.groups.length) as source (source.id)}
      <button class="empty-source" onclick={() => onselect(source.key)}>{source.title} · no active entity statements →</button>
    {/each}
  {:else}
    <div class="gallery">
      {#each groups as { source, group } (group.key)}
        <button class="set-card" onclick={() => onselect(group.key)} aria-label={`Open set ${group.label} from ${source.title}`}>
          <div class="member-preview" aria-hidden="true">
            {#each preview(group) as member (member.key)}
              <div class="member-tile">
                {#if member.asset?.kind === 'image'}<img src={member.asset.url} alt="" loading="lazy" />
                {:else}<span class="member-initial">{member.asset?.kind === 'video' ? '▷' : member.asset?.kind === 'glb' ? '◇' : member.label.slice(0, 1).toUpperCase()}</span>{/if}
                <span>{member.label}</span>
              </div>
            {/each}
          </div>
          <div class="card-copy"><span class="set-name"><span aria-hidden="true">▦</span> {group.label}</span><span class="source-name">{source.title}</span>
            <span class="counts">{group.members.length} members · {group.statementIds.length} statements</span></div>
        </button>
      {/each}
      {#each sources.filter((source: ProvenanceSource) => !source.groups.length) as source (source.id)}
        <button class="set-card empty-card" onclick={() => onselect(source.key)}><span aria-hidden="true">▱</span><strong>{source.title}</strong><span>No active entity statements</span></button>
      {/each}
    </div>
  {/if}
</section>

<style>
  .set-browser { padding: 1.4rem; }
  header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; }
  header > span, .explanation, small, .counts, .source-name { color: var(--muted); font-size: 0.8rem; }
  .eyebrow { color: var(--accent); font-size: 0.73rem; margin: 0 0 0.4rem; }
  h2 { font-size: 1.4rem; margin: 0; }
  .explanation { line-height: 1.6; margin: 0.8rem 0 1.5rem; max-width: 48rem; }
  button { cursor: pointer; }
  .folder-tree { display: grid; gap: 0.6rem; }
  .source-folder { border: 1px solid var(--line); border-radius: var(--rad); background: var(--surface); padding: 0.7rem; }
  summary { cursor: pointer; padding: 0.5rem; font-size: 0.9rem; overflow-wrap: anywhere; }
  summary small { margin-left: 0.6rem; }
  .folder-icon, .set-icon { margin: 0 0.5rem; color: var(--accent); }
  .set-folder { margin: 0.4rem 0 0.4rem 1rem; border-left: 1px solid var(--line); padding-left: 0.7rem; }
  .inspect { margin: 0.25rem 0.7rem; color: var(--accent); background: transparent; border: none; font-size: 0.78rem; }
  ul { padding-left: 1.6rem; }
  li { margin: 0.3rem 0; }
  li button { background: transparent; border: none; padding: 0.35rem; text-align: left; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: var(--muted); font-size: 0.73rem; font-weight: 500; padding: 0.65rem; }
  td { border-top: 1px solid var(--line); padding: 0.85rem 0.65rem; }
  td:first-child { min-width: 160px; }
  td small { display: block; margin-top: 0.35rem; }
  .set-link, .source-link { background: transparent; border: none; text-align: left; padding: 0; }
  .set-link { display: flex; gap: 0.5rem; color: var(--ink); font-weight: 600; }
  .set-link span { color: var(--accent); }
  .source-link { color: var(--muted); font-size: 0.8rem; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .set-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad); padding: 0; overflow: hidden; text-align: left; }
  .set-card:hover { border-color: var(--accent); }
  .member-preview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; aspect-ratio: 1.65; background: var(--line); }
  .member-tile { min-width: 0; min-height: 0; position: relative; background: var(--surface-2); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .member-tile:only-child { grid-column: 1 / -1; }
  .member-tile img { width: 100%; height: 100%; object-fit: cover; }
  .member-initial { font-size: 1.8rem; color: var(--accent); opacity: 0.65; }
  .member-tile > span:last-child:not(.member-initial) { position: absolute; bottom: 0; left: 0; right: 0; padding: 0.25rem 0.5rem; background: color-mix(in srgb, var(--surface) 90%, transparent); font-size: 0.66rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-copy { padding: 0.9rem; display: grid; gap: 0.45rem; }
  .set-name { font-size: 0.95rem; font-weight: 600; }
  .source-name { overflow-wrap: anywhere; }
  .empty, .empty-card { padding: 2rem; text-align: center; }
  .empty-card { display: grid; place-content: center; gap: 0.6rem; }
  .empty-source { display: block; margin: 1rem 0; }
  @media (max-width: 850px) { .set-browser { padding: 0.8rem; } .gallery { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.6rem; } summary, li button, .inspect { min-height: 44px; } }
</style>
