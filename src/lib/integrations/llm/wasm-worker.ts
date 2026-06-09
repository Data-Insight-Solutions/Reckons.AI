/// <reference lib="webworker" />

/**
 * Dedicated worker that owns the LLM pipeline.
 * Communicates via structured-clone messages with the main thread.
 *
 * @xenova/transformers (and ort-web) are dynamically imported inside the
 * first `init` message handler rather than at module evaluation time.
 * This prevents ort-web's backend registration code from running before
 * the Worker context is fully set up, which causes the
 * "Cannot read properties of undefined (reading 'registerBackend')" crash.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let generator: any = null;
let loadedModel = '';

type Inbound =
  | { id: number; type: 'init'; model: string }
  | { id: number; type: 'extract'; system: string; user: string }
  | { id: number; type: 'chat'; system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> };

self.addEventListener('message', async (ev: MessageEvent<Inbound>) => {
  const msg = ev.data;
  const post = (data: object) => (self as unknown as Worker).postMessage(data);

  try {
    if (msg.type === 'init') {
      if (loadedModel !== msg.model) {
        // Dynamic import defers ort-web initialization until first use
        const { pipeline, env } = await import('@xenova/transformers');
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        // Single-threaded avoids SharedArrayBuffer / cross-origin isolation requirements
        env.backends.onnx.wasm.numThreads = 1;

        generator = await pipeline('text-generation', msg.model, {
          progress_callback: (p: { status: string; progress?: number }) => {
            post({ id: msg.id, type: 'progress', status: p.status, progress: p.progress });
          }
        });
        loadedModel = msg.model;
      }
      post({ id: msg.id, type: 'ready' });
      return;
    }

    if (msg.type === 'extract') {
      if (!generator) throw new Error('pipeline not initialised');
      const prompt = `<|im_start|>system\n${msg.system}<|im_end|>\n<|im_start|>user\n${msg.user}<|im_end|>\n<|im_start|>assistant\n`;
      const out = (await generator(prompt, {
        max_new_tokens: 1024,
        temperature: 0.1,
        do_sample: false,
        return_full_text: false
      })) as Array<{ generated_text: string }>;
      post({ id: msg.id, type: 'result', text: out[0]?.generated_text ?? '' });
    }

    if (msg.type === 'chat') {
      if (!generator) throw new Error('pipeline not initialised');
      let prompt = `<|im_start|>system\n${msg.system}<|im_end|>\n`;
      for (const m of msg.messages) prompt += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
      prompt += `<|im_start|>assistant\n`;
      const out = (await generator(prompt, {
        max_new_tokens: 512,
        temperature: 0.7,
        do_sample: true,
        return_full_text: false
      })) as Array<{ generated_text: string }>;
      post({ id: msg.id, type: 'result', text: out[0]?.generated_text ?? '' });
    }
  } catch (err) {
    post({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});

export {};
