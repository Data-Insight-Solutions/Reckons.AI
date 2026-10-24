import { GENERATION_STAGES, STAGE_LABELS, type GenerationCapabilities, type GenerationStage } from './protocol';

/**
 * F166.1.2: the plan Shelly proposes is DATA chosen from a fixed menu, never a command. One step
 * names a stage (a declared template), its prompt, and for a derivation the earlier image it is made
 * from. "Three images and a splat for each" is six steps, approved once as a unit.
 */
export interface JobPlanStep {
  stage: GenerationStage;
  prompt?: string;
  /** Index of an earlier IMAGE step in the same plan that this derivation is made from. */
  from?: number;
}
export interface JobPlanItem {
  stage: GenerationStage;
  prompt: string;
  parent?: number;
}

/** Enough for "a few images, each with a video and a splat"; a GPU queue is not a batch farm. */
export const MAX_PLAN_STEPS = 12;

/**
 * Check a proposed plan against the menu and against what the connected runner says it can do.
 * All or nothing: a plan with one impossible step is refused whole, with the reason, rather than
 * half-run so that a person approves six jobs and gets three.
 */
export function validateJobPlan(steps: unknown, capabilities: GenerationCapabilities | null):
  { ok: true; items: JobPlanItem[] } | { ok: false; error: string } {
  if (!capabilities) return { ok: false, error: 'No local generation runner is connected, so nothing can be queued yet.' };
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'The plan has no jobs.' };
  if (steps.length > MAX_PLAN_STEPS) return { ok: false, error: `The plan has ${steps.length} jobs; at most ${MAX_PLAN_STEPS} can be queued at once.` };
  const items: JobPlanItem[] = [];
  for (const [index, raw] of steps.entries()) {
    const step = raw as Partial<JobPlanStep> | null;
    const n = index + 1;
    if (!step || typeof step !== 'object' || !GENERATION_STAGES.includes(step.stage as GenerationStage)) {
      return { ok: false, error: `Job ${n} is not one of: ${GENERATION_STAGES.join(', ')}.` };
    }
    const stage = step.stage as GenerationStage;
    const capability = capabilities.stages.find(s => s.stage === stage);
    if (!capability?.available) return { ok: false, error: `Job ${n} (${STAGE_LABELS[stage]}) is unavailable: ${capability?.reason ?? 'the runner does not offer it'}` };
    if (stage === 'image') {
      const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : '';
      if (!prompt || prompt.length > 2000) return { ok: false, error: `Job ${n} needs an image prompt of 1 to 2000 characters.` };
      if (step.from !== undefined) return { ok: false, error: `Job ${n} is an image, so it is made from a prompt, not from another job.` };
      items.push({ stage, prompt });
      continue;
    }
    const from = step.from;
    if (!Number.isInteger(from) || (from as number) < 0 || (from as number) >= index || items[from as number].stage !== 'image') {
      return { ok: false, error: `Job ${n} (${STAGE_LABELS[stage]}) must name an earlier image job in this plan to be made from.` };
    }
    // A splat is made from the picture alone; a video may add motion words, else it reuses the picture's prompt.
    const own = typeof step.prompt === 'string' ? step.prompt.trim() : '';
    if (own.length > 2000) return { ok: false, error: `Job ${n}'s prompt is longer than 2000 characters.` };
    items.push({ stage, prompt: stage === 'video' && own ? own : items[from as number].prompt, parent: from as number });
  }
  return { ok: true, items };
}

/** One line per step for the approval card, so a person sees exactly what each job will make. */
export function describePlan(items: JobPlanItem[]): string[] {
  return items.map((item, i) => item.parent === undefined
    ? `${i + 1}. ${STAGE_LABELS[item.stage]}: ${item.prompt}`
    : `${i + 1}. ${STAGE_LABELS[item.stage]} from image ${item.parent + 1}`);
}
