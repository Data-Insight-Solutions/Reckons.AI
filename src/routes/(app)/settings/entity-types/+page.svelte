<script lang="ts">
  import {
    allTypes,
    createCustomType,
    deleteCustomType,
    updateTypeIcons,
    updateTypeColor
  } from '$lib/stores/entity-types.svelte';
  import { setGlb, clearGlb } from '$lib/stores/glb-overrides.svelte';
  import { BUILT_IN_TYPES, type GeometryName, type EntityTypeDef } from '$lib/rdf/entity-types';
  import { settings } from '$lib/stores/settings.svelte';
  import { startMeshyGeneration, pollMeshyTask, toEntityMeshyStatus } from '$lib/integrations/meshy/meshy';
  import { page } from '$app/state';

  const GEOMETRIES: { name: GeometryName; icon: string; label: string }[] = [
    { name: 'sphere',       icon: '●',  label: 'sphere'      },
    { name: 'octahedron',   icon: '◆',  label: 'octahedron'  },
    { name: 'tetrahedron',  icon: '▲',  label: 'tetrahedron' },
    { name: 'icosahedron',  icon: '⬡',  label: 'icosahedron' },
    { name: 'dodecahedron', icon: '⬠',  label: 'dodecahedron'},
    { name: 'box',          icon: '■',  label: 'cube'        },
    { name: 'box-flat',     icon: '▬',  label: 'flat slab'   },
    { name: 'cylinder',     icon: '⬛',  label: 'cylinder'    },
    { name: 'cone',         icon: '▼',  label: 'cone/spike'  },
    { name: 'capsule',      icon: '⊕',  label: 'capsule'     },
    { name: 'torus',        icon: '○',  label: 'torus/ring'  },
    { name: 'torus-knot',   icon: '✦',  label: 'torus-knot'  },
    { name: 'tetrahedron-inv', icon: '🔻', label: 'inv pyramid' },
  ];

  // ── new type form ──────────────────────────────────────────────────────────
  let formOpen = $state(false);
  let newLabel = $state('');
  let newGeometry = $state<GeometryName>('sphere');
  let newColor = $state('#a78bfa');
  let newDescription = $state('');
  let newPredicates = $state('');
  let newIcon2d = $state('');
  let saving = $state(false);
  let error = $state('');

  async function submit() {
    if (!newLabel.trim()) { error = 'label is required'; return; }
    saving = true;
    error = '';
    try {
      const predicates = newPredicates
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.includes(':') ? p : `urn:kbase:predicate/${p}`);
      await createCustomType(newLabel.trim(), newGeometry, newColor, newDescription.trim(), predicates, newIcon2d.trim() || undefined);
      newLabel = '';
      newGeometry = 'sphere';
      newColor = '#a78bfa';
      newDescription = '';
      newPredicates = '';
      newIcon2d = '';
      formOpen = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const customTypes = $derived(allTypes().filter((t) => !t.builtIn));

  // ── color editing ─────────────────────────────────────────────────────────
  let editingColor: Record<string, string> = $state({});

  async function saveColor(t: EntityTypeDef) {
    const c = editingColor[t.iri];
    if (c && c !== t.color) await updateTypeColor(t.iri, c);
    delete editingColor[t.iri];
  }

  // ── icon editing ──────────────────────────────────────────────────────────
  // Inline edit state keyed by type IRI
  let editingIcon: Record<string, string> = $state({});
  let savingIcon: Record<string, boolean> = $state({});

  function startIconEdit(t: EntityTypeDef) {
    editingIcon[t.iri] = t.icon2d ?? '';
  }

  async function saveIcon(t: EntityTypeDef) {
    savingIcon[t.iri] = true;
    try {
      await updateTypeIcons(t.iri, { icon2d: editingIcon[t.iri] || undefined });
      delete editingIcon[t.iri];
    } finally {
      savingIcon[t.iri] = false;
    }
  }

  // ── Meshy.AI 3D generation ────────────────────────────────────────────────
  let meshyGenerating: Record<string, boolean> = $state({});
  let meshyError: Record<string, string> = $state({});
  let meshyPrompts: Record<string, string> = $state({});

  const meshyKey = $derived(settings().meshyApiKey ?? '');

  async function generateMeshy(t: EntityTypeDef) {
    const apiKey = meshyKey;
    if (!apiKey) { meshyError[t.iri] = 'Add Meshy.AI API key in Settings → backends first.'; return; }
    const prompt = meshyPrompts[t.iri]?.trim() || `${t.label} icon, single object, centered, clean`;
    meshyGenerating[t.iri] = true;
    meshyError[t.iri] = '';
    try {
      await updateTypeIcons(t.iri, { meshyStatus: 'pending' });
      const taskId = await startMeshyGeneration(prompt, apiKey);
      await updateTypeIcons(t.iri, { meshyTaskId: taskId, meshyStatus: 'in-progress' });
      // Poll until done (max 3 min)
      const deadline = Date.now() + 3 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const result = await pollMeshyTask(taskId, apiKey);
        await updateTypeIcons(t.iri, { meshyStatus: toEntityMeshyStatus(result.status) });
        if (result.status === 'SUCCEEDED' && result.glbUrl) {
          await setGlb(t.iri, result.glbUrl);
          await updateTypeIcons(t.iri, { meshyStatus: 'succeeded' });
          break;
        }
        if (result.status === 'FAILED' || result.status === 'EXPIRED') {
          meshyError[t.iri] = `Generation ${result.status.toLowerCase()}`;
          break;
        }
      }
    } catch (e) {
      meshyError[t.iri] = e instanceof Error ? e.message : String(e);
      await updateTypeIcons(t.iri, { meshyStatus: 'failed' });
    } finally {
      meshyGenerating[t.iri] = false;
    }
  }

  async function clear3D(t: EntityTypeDef) {
    await clearGlb(t.iri);
    await updateTypeIcons(t.iri, { meshyTaskId: '', meshyStatus: undefined });
  }

  async function loadLocalGlb(iri: string, files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
    await setGlb(iri, dataUrl);
  }
</script>

<header class="head">
  <p class="kicker mono">settings</p>
  <h1>system configuration</h1>
  <div class="settings-nav">
    <a href="/settings" class:active={!page.url.pathname.includes('/turtle') && !page.url.pathname.includes('/entity-types') && !page.url.pathname.includes('/integrations')} class="nav-link">backends</a>
    <a href="/settings/integrations" class:active={page.url.pathname.includes('/integrations')} class="nav-link">integrations</a>
    <a href="/settings/turtle" class:active={page.url.pathname.includes('/turtle')} class="nav-link">turtle</a>
    <a href="/settings/entity-types" class:active={page.url.pathname.includes('/entity-types')} class="nav-link">entity types</a>
    <a href="/kb" class="nav-link">← graph</a>
  </div>
</header>

<!-- ── Built-in types ──────────────────────────────────────────────────── -->
<section class="card">
  <h3>built-in types</h3>
  <p class="sub">built-in types have default emoji icons. you can override them and generate 3D models via Meshy.AI.</p>
  <div class="type-grid">
    {#each allTypes().filter(t => t.builtIn) as t}
      <div class="type-row">
        {#if editingColor[t.iri] !== undefined}
          <input type="color" class="swatch-edit" bind:value={editingColor[t.iri]}
            onchange={() => saveColor(t)} />
        {:else}
          <button class="swatch swatch-btn" style="background: {t.color}"
            title="click to change color"
            onclick={() => { editingColor[t.iri] = t.color; }}></button>
        {/if}
        <div class="info">
          <span class="label">{t.label}</span>
          <span class="geo mono">{GEOMETRIES.find(g => g.name === t.geometry)?.icon ?? '?'} {t.geometry}</span>
        </div>
        <p class="desc">{t.description}</p>
        {#if t.schemaPredicates.length > 0}
          <div class="predicates mono">
            {t.schemaPredicates.map((p) => p.split('/').pop()).join(' · ')}
          </div>
        {/if}
        <div class="icon-row">
          {#if editingIcon[t.iri] !== undefined}
            <input class="icon-input" type="text" bind:value={editingIcon[t.iri]}
              placeholder="emoji or text" maxlength={4}
              onkeydown={(e) => { if (e.key === 'Enter') saveIcon(t); if (e.key === 'Escape') delete editingIcon[t.iri]; }} />
            <button class="sm" onclick={() => saveIcon(t)} disabled={savingIcon[t.iri]}>
              {savingIcon[t.iri] ? '…' : 'save'}
            </button>
            <button class="sm ghost" onclick={() => delete editingIcon[t.iri]}>cancel</button>
          {:else}
            <span class="icon-badge">{t.icon2d ?? '—'}</span>
            <button class="sm ghost" onclick={() => startIconEdit(t)}>edit icon</button>
          {/if}
          {#if t.icon3d}
            <span class="meshy-badge ok">3D ✓</span>
            <button class="sm ghost danger" onclick={() => clear3D(t)}>clear</button>
          {:else}
            <label class="glb-pick-btn sm">
              📁 choose .glb
              <input type="file" accept=".glb,.gltf" class="file-hidden"
                onchange={(e) => {
                  loadLocalGlb(t.iri, (e.currentTarget as HTMLInputElement).files);
                  (e.currentTarget as HTMLInputElement).value = '';
                }} />
            </label>
            <span class="or-sep mono">or</span>
            <div class="meshy-gen">
              <input class="meshy-prompt" type="text" bind:value={meshyPrompts[t.iri]}
                placeholder="{t.label} icon, single object…" />
              <button class="sm" onclick={() => generateMeshy(t)}
                disabled={meshyGenerating[t.iri] || !meshyKey}
                title={!meshyKey ? 'Add Meshy.AI key in Settings → backends' : ''}>
                {meshyGenerating[t.iri] ? `generating… (${t.meshyStatus ?? ''})` : 'gen 3D'}
              </button>
            </div>
          {/if}
          {#if meshyError[t.iri]}
            <span class="meshy-err">{meshyError[t.iri]}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</section>

<!-- ── Custom types ────────────────────────────────────────────────────── -->
<section class="card" style="margin-top: 1rem;">
  <div class="section-head">
    <h3>custom types</h3>
    <button class="primary sm" onclick={() => (formOpen = !formOpen)}>
      {formOpen ? 'cancel' : '+ new type'}
    </button>
  </div>

  {#if formOpen}
    <div class="form">
      <label class="field">
        <span class="lbl mono">label *</span>
        <input type="text" bind:value={newLabel} placeholder="e.g. Medication" />
      </label>
      <div class="row2">
        <div class="field">
          <span class="lbl mono">geometry</span>
          <div class="geo-grid">
            {#each GEOMETRIES as g}
              <button
                type="button"
                class="geo-btn"
                class:active={newGeometry === g.name}
                onclick={() => (newGeometry = g.name)}
                title={g.label}
              >
                <span class="geo-icon">{g.icon}</span>
                <span class="geo-name mono">{g.label}</span>
              </button>
            {/each}
          </div>
        </div>
        <label class="field">
          <span class="lbl mono">color</span>
          <div class="color-row">
            <input type="color" bind:value={newColor} class="color-pick" />
            <input type="text" bind:value={newColor} class="color-text" maxlength={7} />
          </div>
        </label>
      </div>
      <label class="field">
        <span class="lbl mono">description</span>
        <input type="text" bind:value={newDescription} placeholder="one-line description" />
      </label>
      <label class="field">
        <span class="lbl mono">schema predicates (comma-separated)</span>
        <input
          type="text"
          bind:value={newPredicates}
          placeholder="dosage, frequency, prescribed-by"
        />
        <span class="hint">short names become urn:kbase:predicate/… automatically</span>
      </label>
      <label class="field">
        <span class="lbl mono">emoji icon</span>
        <input type="text" bind:value={newIcon2d} placeholder="e.g. 💊" maxlength={4} style="width:6rem" />
        <span class="hint">shown on graph nodes of this type in 2D and 3D views</span>
      </label>
      {#if error}
        <p class="err">{error}</p>
      {/if}
      <div class="form-actions">
        <button class="primary" onclick={submit} disabled={saving}>
          {saving ? 'saving…' : 'create type'}
        </button>
      </div>
    </div>
  {/if}

  {#if customTypes.length === 0 && !formOpen}
    <p class="empty">no custom types yet.</p>
  {:else}
    <div class="type-grid">
      {#each customTypes as t}
        <div class="type-row">
          {#if editingColor[t.iri] !== undefined}
            <input type="color" class="swatch-edit" bind:value={editingColor[t.iri]}
              onchange={() => saveColor(t)} />
          {:else}
            <button class="swatch swatch-btn" style="background: {t.color}"
              title="click to change color"
              onclick={() => { editingColor[t.iri] = t.color; }}></button>
          {/if}
          <div class="info">
            <span class="label">{t.label}</span>
            <span class="geo mono">{t.geometry}</span>
          </div>
          <p class="desc">{t.description || '—'}</p>
          {#if t.schemaPredicates.length > 0}
            <div class="predicates mono">
              {t.schemaPredicates.map((p) => p.split('/').pop()).join(' · ')}
            </div>
          {/if}
          <div class="icon-row">
            {#if editingIcon[t.iri] !== undefined}
              <input class="icon-input" type="text" bind:value={editingIcon[t.iri]}
                placeholder="emoji" maxlength={4}
                onkeydown={(e) => { if (e.key === 'Enter') saveIcon(t); if (e.key === 'Escape') delete editingIcon[t.iri]; }} />
              <button class="sm" onclick={() => saveIcon(t)} disabled={savingIcon[t.iri]}>
                {savingIcon[t.iri] ? '…' : 'save'}
              </button>
              <button class="sm ghost" onclick={() => delete editingIcon[t.iri]}>cancel</button>
            {:else}
              <span class="icon-badge">{t.icon2d ?? '—'}</span>
              <button class="sm ghost" onclick={() => startIconEdit(t)}>edit icon</button>
            {/if}
            {#if t.icon3d}
              <span class="meshy-badge ok">3D ✓</span>
              <button class="sm ghost danger" onclick={() => clear3D(t)}>clear</button>
            {:else}
              <div class="meshy-gen">
                <input class="meshy-prompt" type="text" bind:value={meshyPrompts[t.iri]}
                  placeholder="{t.label} icon, single object" />
                <button class="sm" onclick={() => generateMeshy(t)}
                  disabled={meshyGenerating[t.iri] || !meshyKey}>
                  {meshyGenerating[t.iri] ? `generating… (${t.meshyStatus ?? ''})` : 'gen 3D'}
                </button>
              </div>
            {/if}
            {#if meshyError[t.iri]}
              <span class="meshy-err">{meshyError[t.iri]}</span>
            {/if}
          </div>
          <button class="sm danger del" onclick={() => deleteCustomType(t.iri)}>delete</button>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .head { margin-bottom: 1.25rem; }
  .kicker {
    color: var(--accent);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .sub { color: var(--muted); font-size: 0.82rem; margin: 0.2rem 0 0.7rem; }
  .settings-nav {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding-top: 0.75rem;
    border-top: 1px solid var(--line);
  }
  .nav-link {
    padding: 0.35rem 0.75rem;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    border: 1px solid var(--line);
    color: var(--muted);
    text-decoration: none;
    transition: all 0.15s;
  }
  .nav-link:hover { color: var(--ink-2); border-color: var(--muted-2); }
  .nav-link.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  h3 {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    margin: 0 0 0.6rem;
  }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
  .section-head h3 { margin: 0; }

  .type-grid { display: flex; flex-direction: column; gap: 0.55rem; }
  .type-row {
    display: grid;
    grid-template-columns: 1.4rem 1fr auto;
    grid-template-rows: auto auto;
    align-items: start;
    gap: 0.2rem 0.7rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.65rem 0.85rem;
  }
  .swatch {
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    margin-top: 0.15rem;
    flex-shrink: 0;
  }
  .swatch-btn {
    border: 2px solid transparent;
    cursor: pointer;
    transition: border-color 0.12s;
    padding: 0;
  }
  .swatch-btn:hover { border-color: var(--accent); }
  .swatch-edit {
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: none;
    cursor: pointer;
    border-radius: 50%;
    margin-top: 0.05rem;
  }
  .info { display: flex; align-items: baseline; gap: 0.5rem; }
  .label { font-weight: 600; font-size: 0.95rem; }
  .geo { font-size: 0.68rem; color: var(--muted); }
  .desc {
    grid-column: 2 / 3;
    font-size: 0.78rem;
    color: var(--muted);
    margin: 0;
  }
  .predicates {
    grid-column: 1 / -1;
    font-size: 0.67rem;
    color: var(--data);
    letter-spacing: 0.02em;
  }
  .del { grid-row: 1; grid-column: 3; }

  /* form */
  .form {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 1rem;
    margin-bottom: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .lbl { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); }
  .hint { font-size: 0.7rem; color: var(--muted); }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; }
  .color-row { display: flex; gap: 0.5rem; align-items: center; }
  .color-pick { width: 2.2rem; height: 2.2rem; padding: 0; border: none; cursor: pointer; border-radius: var(--rad-sm); }
  .color-text { flex: 1; font-family: var(--font-mono); }
  .form-actions { display: flex; justify-content: flex-end; }
  .err { color: var(--danger); font-size: 0.8rem; margin: 0; }
  .empty { color: var(--muted); font-size: 0.85rem; margin: 0.5rem 0 0; }
  button.sm { padding: 0.3rem 0.7rem; font-size: 0.78rem; }

  /* Icon + Meshy row */
  .icon-row {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-top: 0.3rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--line);
  }
  .icon-badge {
    font-size: 1.1rem;
    min-width: 1.4rem;
    text-align: center;
    line-height: 1;
  }
  .icon-input {
    width: 4rem;
    text-align: center;
    font-size: 1rem;
    padding: 0.2rem 0.3rem;
  }
  .file-hidden {
    display: none;
  }
  .glb-pick-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    padding: 0.3rem 0.7rem;
    font-size: 0.78rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface);
    color: inherit;
    transition: border-color 0.12s, background 0.12s;
    white-space: nowrap;
  }
  .glb-pick-btn:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .or-sep {
    font-size: 0.65rem;
    color: var(--muted);
    opacity: 0.6;
    flex-shrink: 0;
  }
  .meshy-gen {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex: 1;
  }
  .meshy-prompt {
    flex: 1;
    min-width: 0;
    font-size: 0.72rem;
    padding: 0.25rem 0.4rem;
    color: var(--muted);
  }
  .meshy-badge {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--muted);
  }
  .meshy-badge.ok { border-color: var(--ok, #22c55e); color: var(--ok, #22c55e); }
  .meshy-err { font-size: 0.7rem; color: var(--danger); }
  button.ghost { background: transparent; border-color: var(--line); color: var(--muted); }
  button.ghost:hover { border-color: var(--accent); color: var(--accent); }
  button.ghost.danger:hover { border-color: var(--danger); color: var(--danger); }

  /* Geometry picker grid */
  .geo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    gap: 0.35rem;
  }
  .geo-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    padding: 0.45rem 0.3rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface);
    cursor: pointer;
    transition: all 0.12s;
  }
  .geo-btn:hover { border-color: var(--accent); background: var(--accent-soft); }
  .geo-btn.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
  .geo-icon { font-size: 1.2rem; line-height: 1; }
  .geo-name { font-size: 0.58rem; color: var(--muted); text-align: center; }
</style>
