/**
 * Placement mode (F58.9.16): which node's splat is being placed in the space's background right now.
 * While it is set the large asset preview is collapsed (it covered the graph, so the person could not
 * see the splat move) and a compact bar floats over the graph instead.
 */
export const placement = $state<{ iri: string | null }>({ iri: null });

export function startPlacing(iri: string) { placement.iri = iri; }
export function stopPlacing() { placement.iri = null; }
