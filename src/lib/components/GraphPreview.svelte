<script lang="ts">
  /**
   * A lazy visual fingerprint of a graph, for the gallery.
   *
   * Matt: "lazy load preview images, so they populate after the main graph." That constraint
   * is the whole design. Loading a graph's statements is a full IndexedDB read, and doing it
   * for every card up front would make opening the gallery wait on N graphs it is not even
   * looking at. So this loads NOTHING until two things are both true:
   *
   *   1. the card is actually ON SCREEN (IntersectionObserver), and
   *   2. the browser is IDLE (requestIdleCallback) — the gallery paints first, previews trickle
   *      in behind it.
   *
   * The preview itself is deliberately cheap and DETERMINISTIC: each entity is a dot whose
   * position is hashed from its IRI and whose colour is hashed from its rdf:type. No force
   * simulation — one per card would be absurd — but the result is a stable fingerprint: the
   * same graph always looks the same, entities of a type share a colour, and two different
   * graphs look different at a glance. That is what a preview is FOR.
   *
   * Honest empty state: a graph with no confirmed statements shows "empty", never a fake
   * picture of nothing.
   */
  import { onMount } from 'svelte';
  import { loadKbStatements } from '$lib/rdf/cross-kb-align';

  let { kbId, width = 96, height = 64 }: { kbId: string; width?: number; height?: number } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let host: HTMLDivElement | undefined = $state();
  let phase = $state<'idle' | 'loading' | 'done' | 'empty' | 'error'>('idle');

  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  /** Cap the work per card. A fingerprint does not need every node — it needs the shape. */
  const MAX_DOTS = 120;

  /** Stable 32-bit hash — same string, same number, every time and every machine. */
  function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  async function buildPreview() {
    if (phase !== 'idle') return;
    phase = 'loading';
    try {
      const statements = await loadKbStatements(kbId);
      if (statements.length === 0) {
        phase = 'empty';
        return;
      }

      // Each subject IRI is an entity; its type (if declared) drives its colour.
      const typeOf = new Map<string, string>();
      const entities = new Set<string>();
      for (const st of statements) {
        if (st.s.kind === 'iri') entities.add(st.s.value);
        if (st.p.value === RDF_TYPE && st.s.kind === 'iri') typeOf.set(st.s.value, st.o.value);
      }

      const iris = [...entities].slice(0, MAX_DOTS);
      const ctx = canvas?.getContext('2d');
      if (!ctx) {
        phase = 'error';
        return;
      }
      ctx.clearRect(0, 0, width, height);

      for (const iri of iris) {
        const hx = hash(iri);
        const hy = hash(iri + '·y');
        const x = 4 + (hx % (width - 8));
        const y = 4 + (hy % (height - 8));
        // Untyped entities are muted grey; typed ones take a hue from their type, so a graph
        // that is "mostly one kind of thing" reads as mostly one colour.
        const type = typeOf.get(iri);
        const hue = type ? hash(type) % 360 : 0;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = type ? `hsl(${hue} 65% 60% / 0.85)` : 'hsl(0 0% 55% / 0.5)';
        ctx.fill();
      }
      phase = 'done';
    } catch {
      phase = 'error';
    }
  }

  onMount(() => {
    if (!host) return;
    // Only build when the card scrolls into view. rootMargin lets it start just before, so a
    // preview is usually ready by the time the user reaches it.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          // …and even then, yield to the browser so the gallery stays responsive.
          const run = () => buildPreview();
          if ('requestIdleCallback' in window) (window as any).requestIdleCallback(run, { timeout: 1500 });
          else setTimeout(run, 200);
        }
      },
      { rootMargin: '150px' },
    );
    io.observe(host);
    return () => io.disconnect();
  });
</script>

<div class="graph-preview" bind:this={host} style="width:{width}px;height:{height}px" aria-hidden="true">
  <canvas bind:this={canvas} {width} {height} class:visible={phase === 'done'}></canvas>
  {#if phase === 'loading' || phase === 'idle'}
    <span class="gp-shimmer"></span>
  {:else if phase === 'empty'}
    <span class="gp-note mono">empty</span>
  {:else if phase === 'error'}
    <span class="gp-note mono">—</span>
  {/if}
</div>

<style>
  .graph-preview {
    position: relative;
    border-radius: 6px;
    overflow: hidden;
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    border: 1px solid var(--line);
    flex-shrink: 0;
  }
  canvas {
    display: block;
    opacity: 0;
    transition: opacity 0.4s ease;
  }
  canvas.visible { opacity: 1; }
  .gp-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--accent) 8%, transparent) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: gp-slide 1.2s ease-in-out infinite;
  }
  @keyframes gp-slide {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }
  .gp-note {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.55rem;
    color: var(--muted);
    opacity: 0.6;
  }
</style>
