/// <reference lib="webworker" />

/**
 * Dedicated worker that owns the LLM pipeline.
 * Communicates via structured-clone messages with the main thread.
 *
 * @huggingface/transformers (and ort-web) are dynamically imported inside the
 * first `init` message handler rather than at module evaluation time.
 * This prevents ort-web's backend registration code from running before
 * the Worker context is fully set up, which causes the
 * "Cannot read properties of undefined (reading 'registerBackend')" crash.
 */

const FALLBACK_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';

/**
 * Trim a raw generation to just the assistant's turn. Small models frequently run
 * PAST their <|im_end|> — repeating, or hallucinating further <|im_start|>user /
 * assistant turns — and that trailing text was being returned verbatim as "odd
 * responses". Cut at the first stop token / next-turn marker and trim. A clean
 * generation has none of these, so this is a no-op there.
 */
function cleanGeneration(text: string): string {
  return text
    .split(/<\|im_end\|>|<\|endoftext\|>|<\|im_start\|>/)[0]
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let generator: any = null;
let loadedModel = '';

type Inbound =
  | { id: number; type: 'init'; model: string }
  | { id: number; type: 'extract'; system: string; user: string }
  | { id: number; type: 'chat'; system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> };

const post = (data: object) => (self as unknown as Worker).postMessage(data);

/** Returns true if the error looks like a HuggingFace access/auth problem. */
function isAccessError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unauthorized|forbidden|access denied|gated|login|401|403/i.test(msg);
}

/** Returns true if the error is a fundamental ONNX/browser incompatibility. */
function isOnnxBroken(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /registerBackend|backend.*registration|InferenceSession/i.test(msg);
}

/**
 * Probe whether ONNX runtime is functional before attempting a full pipeline load.
 * Returns true if ort-web backends are registered, false if not.
 */
async function probeOnnxBackend(): Promise<boolean> {
  try {
    const { env } = await import('@huggingface/transformers');
    // If ort-web registered successfully, env.backends.onnx.wasm exists
    return !!(env.backends?.onnx?.wasm);
  } catch {
    return false;
  }
}

async function initPipeline(id: number, model: string): Promise<void> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
  }

  generator = await pipeline('text-generation', model, {
    dtype: 'q4',
    progress_callback: (p: { status: string; progress?: number }) => {
      post({ id, type: 'progress', status: p.status, progress: p.progress });
    }
  });
  loadedModel = model;
}

self.addEventListener('message', async (ev: MessageEvent<Inbound>) => {
  const msg = ev.data;

  try {
    if (msg.type === 'init') {
      if (loadedModel !== msg.model) {
        // Pre-flight: check if ONNX runtime is even functional before attempting download
        const onnxOk = await probeOnnxBackend();
        if (!onnxOk) {
          throw new Error(
            'ONNX runtime unavailable in this browser. '
            + 'Try Chrome AI (built-in Gemini Nano) or Ollama as a local alternative.'
          );
        }

        try {
          await initPipeline(msg.id, msg.model);
        } catch (firstErr) {
          // ONNX runtime errors are browser-level — switching models won't help
          if (isOnnxBroken(firstErr)) {
            throw new Error(
              'ONNX runtime failed to create an inference session. '
              + 'Try Chrome AI (built-in Gemini Nano) or Ollama as a local alternative.'
            );
          }

          // Model access/auth/download error — fall back to safe default
          if (msg.model !== FALLBACK_MODEL) {
            const reason = firstErr instanceof Error ? firstErr.message : String(firstErr);
            const isAuth = isAccessError(firstErr);
            const hint = isAuth
              ? `Model "${msg.model}" requires authentication — falling back to ${FALLBACK_MODEL}`
              : `Model "${msg.model}" failed to load (${reason}) — falling back to ${FALLBACK_MODEL}`;

            post({ id: msg.id, type: 'progress', status: hint });
            post({ id: msg.id, type: 'fallback', requestedModel: msg.model, actualModel: FALLBACK_MODEL, reason });

            generator = null;
            loadedModel = '';
            await initPipeline(msg.id, FALLBACK_MODEL);
          } else {
            throw firstErr;
          }
        }
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
      post({ id: msg.id, type: 'result', text: cleanGeneration(out[0]?.generated_text ?? '') });
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
      post({ id: msg.id, type: 'result', text: cleanGeneration(out[0]?.generated_text ?? '') });
    }
  } catch (err) {
    post({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});

export {};
