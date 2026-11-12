// Examples offered on /about. An entry with unlisted: true opens by link (/about?example=<id>) but is
// not rendered in the list (F292.3: the ring, which a website links to). Unlisted is not private.
export interface ExampleKb {
  id: string; icon: string; title: string; label?: string; body: string; file: string; space?: string;
  unlisted?: boolean; entities: number; triples: number;
}

export const EXAMPLE_KBS: ExampleKb[] = [
  { id: 'data-insight-solutions', icon: '◆', title: 'Data Insight Solutions', label: 'Built with Reckons.AI', body: 'A real website published by Data Insight Solutions LLC: each published page and post is a node, with a link to the live site.', file: '/starter-data-insight-solutions.ttl', space: 'Data Insight Solutions', entities: 15, triples: 133 },
  { id: 'triple-check', icon: '✓', title: 'Triple Check walkthrough', body: 'Four documents disagree about a fictional home battery, and an owners\' forum space comes with them. A guided story shows how Triple Check brings what it finds into Review.', file: '/starter-triple-check.ttl', space: 'Triple Check walkthrough', entities: 3, triples: 14 },
  {
    id: 'quickstart',
    icon: '🚀',
    title: 'Quick-Start Example',
    body: 'People, projects, research notes, decisions, and metrics — see how real-world data maps to facts.',
    file: '/starter-quickstart.ttl',
    space: 'Quick-Start Example',
    entities: 15,
    triples: 90
  },
  {
    // F58.9.4: opens as its OWN space, so trying it never mixes into the one you are working in.
    id: 'generated-assets',
    icon: '✦',
    title: 'Generated assets',
    body: 'Pictures, clips and Gaussian splats made by local models on one machine, each linked to the prompt it came from. Opens as its own space.',
    file: '/starter-generated-assets.ttl',
    space: 'Generated assets',
    entities: 9,
    triples: 81
  },
  {
    // F58.9.10: a guided space. The room in it is SYNTHETIC; the steps say how to use a real scan.
    id: 'your-room',
    icon: '⌂',
    title: 'Your room',
    body: 'Scan a room, bring it in as the background, and place generated objects inside it. Four steps, with a made-up room so you can try them first. Opens as its own space.',
    file: '/starter-your-room.ttl',
    space: 'Your room',
    entities: 7,
    triples: 53
  },
  {
    // F34.5: a generated space of the release's visual tests, for manual review. Verdicts are set from the node panel.
    // Unlisted 2026-11-12 (Matt: review examples are not public); still opened by /about?example=review-0.2.6 for the F34.5 release review.
    id: 'review-0.2.6',
    unlisted: true,
    icon: '✓',
    title: 'Review 0.2.6',
    body: 'The main workflows of v0.2.6 as visual tests: each step with its screenshot and what the test checks, ready for you to mark pass, fail or a note. Opens as its own space.',
    file: '/review-0.2.6.ttl',
    space: 'Review 0.2.6',
    entities: 21,
    triples: 119
  },
  {
    // F34.5: a generated space of the release's visual tests, for manual review. Verdicts are set from the node panel.
    // Unlisted 2026-11-12 (Matt: review examples are not public); still opened by /about?example=review-0.2.7 for the F34.5 release review.
    id: 'review-0.2.7',
    unlisted: true,
    icon: '✓',
    title: 'Review 0.2.7',
    body: 'The main workflows of v0.2.7 as visual tests: each step with its screenshot and what the test checks, ready for you to mark pass, fail or a note. Opens as its own space.',
    file: '/review-0.2.7.ttl',
    space: 'Review 0.2.7',
    entities: 7,
    triples: 31
  },
  {
    // F34.5: the release's visual tests, for manual review.
    // Unlisted 2026-11-12 (Matt: review examples are not public); still opened by /about?example=review-0.2.8 for the F34.5 release review.
    id: 'review-0.2.8',
    unlisted: true,
    icon: '✓',
    title: 'Review 0.2.8',
    body: 'The main workflows of v0.2.8 as visual tests: each step with its screenshot and what the test checks, ready for you to mark pass, fail or a note.',
    file: '/review-0.2.8.ttl',
    space: 'Review 0.2.8',
    entities: 42,
    triples: 209
  },
  {
    // F292.3: UNLISTED. Opened by /about?example=ring-scan (the Data Insight Solutions site links to it) and never shown in the list.
    // Unlisted is not private: the file is public. The ring is RECONSTRUCTED from photographs, not generated.
    id: 'ring-scan',
    icon: '◎',
    title: 'The ring',
    body: 'A ring filmed on a scan board and reconstructed into a 3D Gaussian splat, with the story of how.',
    file: '/starter-ring-scan.ttl',
    space: 'The ring',
    unlisted: true,
    entities: 41,
    triples: 255
  }
];

/** The entries shown in the examples list. */
export const listedExampleKbs = (kbs: readonly ExampleKb[] = EXAMPLE_KBS): ExampleKb[] => kbs.filter((k) => !k.unlisted);

/** Resolve an id from a /about?example=<id> link; unlisted entries resolve too. */
export const findExampleKb = (id: string | null, kbs: readonly ExampleKb[] = EXAMPLE_KBS): ExampleKb | undefined =>
  id ? kbs.find((k) => k.id === id) : undefined;
