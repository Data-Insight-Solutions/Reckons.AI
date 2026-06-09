<script lang="ts">
  let {
    nodeKey,
    label,
    x,
    y,
    ondetails = () => {},
    onreject = () => {},
    onmerge = () => {},
    oncreaterelation = () => {},
    onclose = () => {}
  } = $props<{
    nodeKey: string;
    label: string;
    x: number;
    y: number;
    ondetails?: () => void;
    onreject?: () => void;
    onmerge?: () => void;
    oncreaterelation?: () => void;
    onclose?: () => void;
  }>();

  let dragStart: { x: number; y: number } | null = $state(null);

  function handlePointerDown(e: PointerEvent) {
    dragStart = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerUp(e: PointerEvent) {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    dragStart = null;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 40) return;

    if (Math.abs(dx) > Math.abs(dy)) {
      dx > 0 ? oncreaterelation() : onmerge();
    } else {
      dy > 0 ? onreject() : ondetails();
    }
  }
</script>

<div class="radial" style="left:{x}px;top:{y}px">
  <button class="slot up" title="details (drag up)" onclick={ondetails}>↑</button>
  <button class="slot left" title="merge (drag left)" onclick={onmerge}>←</button>
  <div class="center" role="button" tabindex="0" onpointerdown={handlePointerDown} onpointerup={handlePointerUp}>
    <span class="label mono">{label}</span>
  </div>
  <button class="slot right" title="create relation (drag right)" onclick={oncreaterelation}>→</button>
  <button class="slot down" title="reject (drag down)" onclick={onreject}>↓</button>
  <button class="close ghost" onclick={onclose} title="close menu">✕</button>
</div>

<style>
  .radial {
    position: fixed;
    display: grid;
    grid-template-columns: auto auto auto;
    grid-template-rows: auto auto auto;
    gap: 0.5rem;
    transform: translate(-50%, -50%);
    z-index: 1000;
  }

  .center {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 60px;
    height: 60px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    backdrop-filter: blur(10px);
    cursor: grab;
    user-select: none;
  }

  .center:active {
    cursor: grabbing;
  }

  .label {
    font-size: 0.65rem;
    color: var(--muted);
    text-align: center;
    word-break: break-word;
    padding: 0.25rem;
  }

  .slot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--muted);
    cursor: pointer;
    backdrop-filter: blur(10px);
    font-size: 1rem;
    transition: all 0.15s;
  }

  .slot:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .up { grid-column: 2; grid-row: 1; }
  .left { grid-column: 1; grid-row: 2; }
  .right { grid-column: 3; grid-row: 2; }
  .down { grid-column: 2; grid-row: 3; }

  .close {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 24px;
    height: 24px;
    padding: 0;
    border-radius: 50%;
    background: var(--surface-3);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.75rem;
  }

  .close:hover {
    background: var(--danger);
    border-color: var(--danger);
    color: var(--ink);
  }
</style>
