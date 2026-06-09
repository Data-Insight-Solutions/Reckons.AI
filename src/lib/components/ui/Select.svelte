<script lang="ts">
  import { Select } from 'bits-ui';

  type Option = { value: string; label: string };
  type Group = { label: string; options: Option[] };

  let {
    value = $bindable(''),
    options,
    groups,
    placeholder = 'Select…',
    disabled = false,
    class: cls = '',
    onchange,
  } = $props<{
    value?: string;
    options?: Option[];
    groups?: Group[];
    placeholder?: string;
    disabled?: boolean;
    class?: string;
    onchange?: (value: string) => void;
  }>();

  const allOptions = $derived.by(() => {
    if (options) return options;
    if (groups) return groups.flatMap((g) => g.options);
    return [];
  });

  const selectedLabel = $derived(allOptions.find((o) => o.value === value)?.label ?? '');
</script>

<Select.Root type="single" bind:value {disabled} onValueChange={(v) => onchange?.(v)}>
  <Select.Trigger class="ui-select-trigger {cls}">
    <span class="ui-select-val" class:placeholder={!value}>
      {value ? selectedLabel : placeholder}
    </span>
    <span class="ui-select-chevron" aria-hidden="true">▾</span>
  </Select.Trigger>

  <Select.Portal>
    <Select.Content class="ui-select-content" sideOffset={4}>
      <Select.Viewport class="ui-select-viewport">
        {#if options}
          {#each options as opt (opt.value)}
            <Select.Item value={opt.value} label={opt.label} class="ui-select-item">
              {#snippet children({ selected })}
                <span class="ui-select-check">{selected ? '✓' : ''}</span>
                {opt.label}
              {/snippet}
            </Select.Item>
          {/each}
        {:else if groups}
          {#each groups as group}
            <Select.Group class="ui-select-group">
              <Select.GroupHeading class="ui-select-group-heading">
                {group.label}
              </Select.GroupHeading>
              {#each group.options as opt (opt.value)}
                <Select.Item value={opt.value} label={opt.label} class="ui-select-item">
                  {#snippet children({ selected })}
                    <span class="ui-select-check">{selected ? '✓' : ''}</span>
                    {opt.label}
                  {/snippet}
                </Select.Item>
              {/each}
            </Select.Group>
          {/each}
        {/if}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>

<style>
  :global(.ui-select-trigger) {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    cursor: pointer;
    min-width: 10rem;
    transition: border-color 0.15s;
    width: 100%;
  }
  :global(.ui-select-trigger:hover) {
    border-color: var(--accent);
  }
  :global(.ui-select-trigger:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  :global(.ui-select-trigger[data-disabled]) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(.ui-select-val) {
    flex: 1;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(.ui-select-val.placeholder) {
    color: var(--muted);
  }
  :global(.ui-select-chevron) {
    flex-shrink: 0;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1;
  }

  :global(.ui-select-content) {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 500;
    min-width: var(--bits-select-trigger-width);
    max-height: 280px;
    overflow: hidden;
  }
  :global(.ui-select-viewport) {
    padding: 0.25rem;
    overflow-y: auto;
    max-height: 280px;
  }

  :global(.ui-select-group) {
    padding: 0;
  }
  :global(.ui-select-group-heading) {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    padding: 0.4rem 0.6rem 0.2rem;
    border-top: 1px solid var(--line);
    margin-top: 0.2rem;
  }
  :global(.ui-select-group:first-child .ui-select-group-heading) {
    border-top: none;
    margin-top: 0;
  }

  :global(.ui-select-item) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--fg);
    cursor: pointer;
    transition: background 0.1s;
    user-select: none;
  }
  :global(.ui-select-item[data-highlighted]) {
    background: var(--accent-soft);
    color: var(--accent);
  }
  :global(.ui-select-item[data-selected]) {
    color: var(--accent);
  }
  :global(.ui-select-item[data-disabled]) {
    opacity: 0.4;
    cursor: not-allowed;
  }
  :global(.ui-select-check) {
    width: 0.8rem;
    text-align: center;
    font-size: 0.7rem;
    color: var(--accent);
    flex-shrink: 0;
  }
</style>
