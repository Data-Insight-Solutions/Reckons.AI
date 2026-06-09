/**
 * Meshy.AI Text-to-3D API client.
 *
 * Generates a .glb 3D model from a text prompt.
 * API key is stored in settings (meshyApiKey).
 *
 * Workflow:
 *   1. startGeneration(prompt, apiKey)  → taskId
 *   2. Poll pollTask(taskId, apiKey)    → { status, glbUrl? }
 *   3. When status === 'SUCCEEDED', glbUrl is the download link
 */

const BASE = 'https://api.meshy.ai/openapi/v2/text-to-3d';

export type MeshyStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export type MeshyTaskResult = {
  id: string;
  status: MeshyStatus;
  /** Available when status === 'SUCCEEDED' */
  glbUrl?: string;
  /** Progress 0-100 */
  progress?: number;
};

/** Start a text-to-3D generation. Returns the task ID. */
export async function startMeshyGeneration(
  prompt: string,
  apiKey: string,
  artStyle: 'realistic' | 'cartoon' | 'low-poly' | 'sculpture' = 'low-poly'
): Promise<string> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      mode: 'preview',
      prompt,
      art_style: artStyle,
      should_remesh: true
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meshy API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.result) throw new Error('Meshy API returned no task ID');
  return data.result as string;
}

/** Poll a task for its current status and (if done) GLB URL. */
export async function pollMeshyTask(taskId: string, apiKey: string): Promise<MeshyTaskResult> {
  const res = await fetch(`${BASE}/${taskId}`, {
    headers: { 'authorization': `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meshy poll ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    id: data.id ?? taskId,
    status: data.status as MeshyStatus,
    glbUrl: data.model_urls?.glb as string | undefined,
    progress: data.progress as number | undefined
  };
}

/** Map Meshy status to our EntityTypeDef meshyStatus values. */
export function toEntityMeshyStatus(s: MeshyStatus): 'pending' | 'in-progress' | 'succeeded' | 'failed' {
  if (s === 'PENDING')     return 'pending';
  if (s === 'IN_PROGRESS') return 'in-progress';
  if (s === 'SUCCEEDED')   return 'succeeded';
  return 'failed';
}
