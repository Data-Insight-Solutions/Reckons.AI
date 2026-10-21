<script lang="ts">
  import { threeExampleUrl } from '$lib/3d/three-example';
  let { value = '', disabled = false, isBackground = false, onchange, onopen, onbackground }: {
    value?: string; disabled?: boolean; isBackground?: boolean; onchange: (url: string) => Promise<void>; onopen: () => void;
    /** Set (true) or clear (false) this example as the space background. Omit to hide the button. */
    onbackground?: (on: boolean) => Promise<void>;
  } = $props();
  let draft = $state('');
  let editing = $state(false);
  let saving = $state(false);
  let error = $state('');
  async function save(remove = false) {
    const url = remove ? '' : threeExampleUrl(draft);
    if (url === null) { error = 'Paste a WebGL or WebGPU example link from threejs.org/examples/.'; return; }
    saving = true;
    try { await onchange(url); editing = false; error = ''; }
    catch { error = 'The example could not be saved. Please try again.'; }
    finally { saving = false; }
  }
</script>

<div class="three-example-editor">
  <span class="label">Three.js example</span>
  {#if editing}
    <label>Example URL <input type="url" bind:value={draft} placeholder="https://threejs.org/examples/#webgl_animation_keyframes" /></label>
    <div class="actions">
      <button onclick={() => save()} disabled={saving || disabled}>Attach example</button>
      <button onclick={() => { editing = false; error = ''; }}>Cancel</button>
    </div>
  {:else if value}
    <span class="example-name">{value.split('/').pop()?.replace('.html', '')}</span>
    <div class="actions">
      <button onclick={onopen}>Open example viewer</button>
      {#if onbackground}<button onclick={() => onbackground(!isBackground)} disabled={disabled}>{isBackground ? 'Clear background' : 'Set as background'}</button>{/if}
      <button onclick={() => { draft = value; editing = true; }} disabled={disabled || saving}>Edit example</button>
      <button onclick={() => save(true)} disabled={disabled || saving}>Remove example</button>
    </div>
  {:else}
    <button onclick={() => { draft = ''; editing = true; }} disabled={disabled}>Attach Three.js example</button>
  {/if}
  <p>Runs only when you load it in its viewer. <a href="https://threejs.org/examples/" target="_blank" rel="noopener noreferrer">Browse examples ↗</a> · <a href="/docs/features/threejs-examples">Viewer guide</a></p>
  {#if error}<p role="alert">{error}</p>{/if}
</div>

<style>
  .three-example-editor { display: grid; gap: .4rem; margin-top: .75rem; }
  .label { font: .7rem var(--font-mono); color: var(--muted); }
  .example-name { overflow-wrap: anywhere; font: .7rem var(--font-mono); }
  .actions { display: flex; flex-wrap: wrap; gap: .4rem; }
  label, p { font-size: .75rem; }
  p { margin: 0; color: var(--muted); }
  input { width: 100%; padding: .4rem; margin-top: .3rem; background: var(--surface); border: 1px solid var(--line); color: var(--ink); border-radius: 4px; }
  button { padding: .35rem .5rem; border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: var(--surface); cursor: pointer; font-size: .75rem; }
  button:disabled { opacity: .5; cursor: default; }
  a { color: var(--accent); }
</style>
