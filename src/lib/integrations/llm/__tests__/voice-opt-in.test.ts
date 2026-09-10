import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('voice opt-in dependency boundary', () => {
  it('defaults voice to disabled', () => {
    const db = source('src/lib/storage/db.ts');
    expect(db).toMatch(/DEFAULT_TURTLE_SETTINGS[\s\S]*voiceEnabled:\s*false/);
  });

  it('does not attach voice runtimes to the landing page or root layout', () => {
    const landing = source('src/lib/components/LandingPage.svelte');
    const layout = source('src/routes/(app)/+layout.svelte');
    const chat = source('src/lib/components/TurtleChatPanel.svelte');

    expect(landing).not.toContain("$lib/integrations/llm/kokoro-tts");
    expect(layout).not.toContain("import TurtleChatPanel from");
    expect(layout).toContain("import('$lib/components/TurtleChatPanel.svelte')");
    expect(chat).not.toContain("import ShellyVoice from");
    expect(chat).toContain("import('./ShellyVoice.svelte')");
  });

  it('does not let imported persona data grant local voice consent', () => {
    const ingest = source('src/routes/(app)/ingest/+page.svelte');
    expect(ingest).not.toMatch(/patch\.voiceEnabled\s*=\s*shellyPersona\.voiceEnabled/);
  });

  it('keeps voice and model runtimes out of the install-time PWA cache', () => {
    const vite = source('vite.config.ts');
    expect(vite).toContain('manifestTransforms');
    expect(vite).toContain('isOptInRuntimeAsset');
    expect(vite).toContain("url.endsWith('.wasm')");
    expect(vite).toContain('Kokoro-82M-v1.0-ONNX');
    expect(vite).toContain('HumeClient');
  });
});
