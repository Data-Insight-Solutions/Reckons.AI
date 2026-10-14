/**
 * Bench task definitions for the local generation stages (F183.1 / kb:gen-model-bench).
 *
 * A BENCHMARK NEEDS A GROUND TRUTH OR IT IS A VIBE. So each stage has fixed SYNTHETIC briefs, fixed
 * seeds, and a hand-written checklist per brief — the answer key a judge is held to. Nothing here
 * comes from anybody's notes.
 *
 * OPEN QUESTION, NOT DECIDED HERE (kb:task-model-bench, F183): whether a task should be a graph
 * entity. This is a plain TypeScript file until Matt decides; the shape (stage, briefs, seeds,
 * checklist) was chosen so it can move into the graph unchanged.
 *
 * The checklist for IMAGES is yes/no questions put to the local vision model; every expected
 * answer is YES, and the "exactly one" / "three-quarter view" items are the ones a weak model gets
 * wrong. VIDEO and SPLAT checklists are numeric expectations — no judge, so no judge error.
 */
import type { Stage } from './gen-assets.js';

export interface ImageItem { id: string; question: string }
export interface ImageBrief { slug: string; label: string; prompt: string; checklist: ImageItem[] }

export interface VideoBrief {
  slug: string; label: string;
  /** The image brief whose first-seed incumbent output is the clip's source frame. */
  sourceImage: string;
  prompt: string;
  /** What a correct clip does. `minMotion` is the lowest acceptable mean frame-to-frame change (0..1). */
  expects: { minMotion: number; note: string };
}

export interface SplatBrief {
  slug: string; label: string; sourceImage: string; gaussians: number;
  /** What a correct splat looks like. Depth/width is extent along the view axis over extent across it. */
  expects: { depthToWidth: [number, number]; minSilhouetteIoU: number; note: string };
}

export const SEEDS = [101, 202, 303];

export const IMAGE_BRIEFS: ImageBrief[] = [
  {
    slug: 'red-lighthouse', label: 'Red lighthouse on a shore',
    prompt: 'A tall lighthouse painted with red and white horizontal stripes standing on a rocky shore, the sea behind it, clear blue sky, wide shot, daylight photo',
    checklist: [
      { id: 'lighthouse', question: 'Is there a lighthouse in this picture?' },
      { id: 'red', question: 'Is the lighthouse painted at least partly red?' },
      { id: 'one', question: 'Is there exactly one lighthouse (not two or more)?' },
      { id: 'sea', question: 'Is there sea or open water visible?' },
      { id: 'sky', question: 'Is a blue sky visible?' },
    ],
  },
  {
    slug: 'one-boat', label: 'A single rowing boat at sunrise',
    prompt: 'A single wooden rowing boat floating alone on calm water at sunrise, low warm light, mist on the water, nobody in the boat',
    checklist: [
      { id: 'boat', question: 'Is there a boat in this picture?' },
      { id: 'one', question: 'Is there exactly one boat (not two or more)?' },
      { id: 'wood', question: 'Does the boat look like it is made of wood?' },
      { id: 'water', question: 'Is the boat on water?' },
      { id: 'empty', question: 'Is the boat free of people?' },
    ],
  },
  {
    slug: 'blue-teapot', label: 'Blue teapot on a wooden table',
    prompt: 'A blue ceramic teapot with a white lid on a wooden table, studio product photo, plain light background, soft even lighting',
    checklist: [
      { id: 'teapot', question: 'Is there a teapot in this picture?' },
      { id: 'blue', question: 'Is the teapot mostly blue?' },
      { id: 'lid', question: 'Does the teapot have a white lid?' },
      { id: 'table', question: 'Is the teapot standing on a wooden surface?' },
      { id: 'one', question: 'Is there exactly one teapot?' },
    ],
  },
  {
    slug: 'three-apples', label: 'Three green apples on a plate',
    prompt: 'Exactly three green apples in a row on a round white plate, top-down view slightly angled, plain wooden table, soft daylight',
    checklist: [
      { id: 'apples', question: 'Are there apples in this picture?' },
      { id: 'three', question: 'Are there exactly three apples?' },
      { id: 'green', question: 'Are the apples green?' },
      { id: 'plate', question: 'Are the apples on a plate?' },
      { id: 'white', question: 'Is the plate white?' },
    ],
  },
  {
    slug: 'turtle-three-quarter', label: 'Wooden sea turtle, three-quarter view',
    prompt: 'A hand-carved wooden sea turtle figurine with a high domed shell, standing on its four flippers, three-quarter view from the front and slightly above, the whole figurine visible, studio photo on a plain light grey background',
    checklist: [
      { id: 'turtle', question: 'Is there a turtle figurine in this picture?' },
      { id: 'wood', question: 'Does the figurine look carved from wood?' },
      { id: 'three-quarter', question: 'Is the turtle seen from an angle (three-quarter view), rather than straight from above or straight from the side?' },
      { id: 'whole', question: 'Is the whole turtle visible, with nothing cut off by the edge of the picture?' },
      { id: 'one', question: 'Is there exactly one turtle?' },
    ],
  },
];

export const VIDEO_BRIEFS: VideoBrief[] = [
  { slug: 'red-lighthouse', label: 'Lighthouse and waves', sourceImage: 'red-lighthouse',
    prompt: 'waves roll in and break against the rocks below the lighthouse, clouds drift slowly across the sky, the camera pushes in gently',
    expects: { minMotion: 0.01, note: 'water and clouds move; the lighthouse stays put' } },
  { slug: 'one-boat', label: 'Boat drifting', sourceImage: 'one-boat',
    prompt: 'the wooden rowing boat drifts slowly forward on the calm water, ripples spread out from it, mist moves across the surface',
    expects: { minMotion: 0.01, note: 'the boat drifts and the water ripples' } },
  { slug: 'blue-teapot', label: 'Teapot steam', sourceImage: 'blue-teapot',
    prompt: 'steam rises from the spout of the blue teapot, the camera slowly circles around the table',
    expects: { minMotion: 0.01, note: 'steam rises and the viewpoint turns' } },
  { slug: 'turtle-three-quarter', label: 'Turtle swims', sourceImage: 'turtle-three-quarter',
    prompt: 'the wooden sea turtle figurine swims forward, its flippers paddling up and down, the camera slowly orbits around it',
    expects: { minMotion: 0.01, note: 'flippers move and the camera orbits' } },
];

export const SPLAT_BRIEFS: SplatBrief[] = [
  { slug: 'blue-teapot', label: 'Teapot', sourceImage: 'blue-teapot', gaussians: 32768,
    expects: { depthToWidth: [0.3, 1.6], minSilhouetteIoU: 0.5, note: 'a rounded solid, not a flat card' } },
  { slug: 'turtle-three-quarter', label: 'Turtle', sourceImage: 'turtle-three-quarter', gaussians: 32768,
    expects: { depthToWidth: [0.3, 1.6], minSilhouetteIoU: 0.5, note: 'a solid with a domed shell' } },
  { slug: 'three-apples', label: 'Apples on a plate', sourceImage: 'three-apples', gaussians: 32768,
    expects: { depthToWidth: [0.2, 1.6], minSilhouetteIoU: 0.5, note: 'three solids on a disc' } },
  { slug: 'one-boat', label: 'Boat', sourceImage: 'one-boat', gaussians: 32768,
    expects: { depthToWidth: [0.2, 1.6], minSilhouetteIoU: 0.4, note: 'a hull with depth' } },
];

export function tasksFor(stage: Stage) {
  return stage === 'image' ? IMAGE_BRIEFS : stage === 'video' ? VIDEO_BRIEFS : SPLAT_BRIEFS;
}
