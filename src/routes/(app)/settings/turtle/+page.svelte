<script lang="ts">
  import { page } from '$app/state';
  import { turtleSettings, updateTurtleSettings, setTurtlePersonality, setVoiceType } from '$lib/stores/turtle-settings.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { VOICES, speakStreaming } from '$lib/integrations/llm/kokoro-tts';

  let ts = $derived(turtleSettings());

  // ── Kokoro voice picker ──────────────────────────────────────────────────
  let previewAbort: (() => void) | null = null;
  let previewingVoice = $state('');

  const voicesByGroup = $derived.by(() => {
    const groups: Record<string, typeof VOICES> = {};
    for (const v of VOICES) {
      const key = `${v.accent} ${v.gender === 'F' ? 'Female' : 'Male'}`;
      (groups[key] ??= []).push(v);
    }
    return groups;
  });

  function previewVoice(voiceId: string) {
    if (previewAbort) { previewAbort(); previewAbort = null; }
    if (previewingVoice === voiceId) { previewingVoice = ''; return; }
    previewingVoice = voiceId;
    previewAbort = speakStreaming('Hello! This is how I sound when reading your knowledge graph.', {
      voice: voiceId,
      rate: ts.speechRate ?? 0.75,
      volume: Math.min((ts.volume ?? 75) / 100, 0.9),
      onEnd: () => { previewingVoice = ''; previewAbort = null; },
      onError: () => { previewingVoice = ''; previewAbort = null; },
    });
  }

  // Derived helpers for Hume config status
  const humeConfigured = $derived(!!(ts.humeApiKey || settings().humeAiApiKey));

  // ── Hume.AI auto-config ────────────────────────────────────────────────────
  let humeAutoConfigBusy = $state(false);
  let humeAutoConfigMsg = $state('');

  async function autoConfigHumeVoice() {
    const apiKey = ts.humeApiKey || settings().humeAiApiKey;
    if (!apiKey) { humeAutoConfigMsg = 'Add a Hume API key first.'; return; }

    humeAutoConfigBusy = true;
    humeAutoConfigMsg = '';

    try {
      // Create an EVI config named after this turtle persona
      const name = ts.name || 'Shelly';
      const res = await fetch('https://api.hume.ai/v0/evi/configs', {
        method: 'POST',
        headers: {
          'X-Hume-Api-Key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `${name} — Reckons.AI`,
          language_model: {
            model_provider: 'CUSTOM_LANGUAGE_MODEL',
            // Reckons.AI overrides the LM — Hume only handles voice
          },
          voice: {
            provider: 'HUME_AI',
            // Use Hume's default voice — user can customize in Hume portal
          }
        })
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Hume API ${res.status}: ${body}`);
      }

      const config = await res.json();
      const configId = config.id;
      await updateTurtleSettings({ humeConfigId: configId });
      humeAutoConfigMsg = `Created voice config "${name}" (${configId.slice(0, 8)}...). You can customize the voice in the Hume portal.`;
    } catch (e) {
      humeAutoConfigMsg = (e as Error).message || 'Failed to create config';
    } finally {
      humeAutoConfigBusy = false;
    }
  }
</script>

<div class="turtle-settings">
  <header class="head">
    <p class="kicker mono">settings</p>
    <h1>system configuration</h1>

    <div class="settings-nav">
      <a href="/settings" class:active={!page.url.pathname.includes('/turtle') && !page.url.pathname.includes('/entity-types') && !page.url.pathname.includes('/integrations') && !page.url.pathname.includes('/publishing')} class="nav-link">backends</a>
      <a href="/settings/publishing" class:active={page.url.pathname.includes('/publishing')} class="nav-link">publishing</a>
      <a href="/settings/integrations" class:active={page.url.pathname.includes('/integrations')} class="nav-link">integrations</a>
      <a href="/settings/turtle" class:active={page.url.pathname.includes('/turtle')} class="nav-link">turtle</a>
      <a href="/settings/entity-types" class:active={page.url.pathname.includes('/entity-types')} class="nav-link">entity types</a>
      <a href="/analyze" class="nav-link">analyze history &#x2197;</a>
    </div>
  </header>

  <p class="page-intro">
    Configure Shelly, your knowledge assistant (identity, personality, voice) and the turtle companion
    (visual appearance, movement). Every graph can have its own persona — personality travels with the .ttl file.
  </p>

  <div class="section-divider">
    <span class="divider-label mono">shelly chatbot</span>
  </div>

  <div class="settings-grid">
    <!-- ── Identity ───────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Identity</h2>

      <div class="setting-group">
        <label for="shelly-name">Name</label>
        <input
          id="shelly-name"
          type="text"
          class="text-input"
          placeholder="Shelly"
          value={ts.name}
          oninput={(e) => updateTurtleSettings({ name: (e.target as HTMLInputElement).value })}
        />
        <p class="hint">The turtle's display name. Shown under the icon and used in conversations.</p>
      </div>

      <div class="setting-group">
        <label for="shelly-greeting">Greeting</label>
        <input
          id="shelly-greeting"
          type="text"
          class="text-input"
          placeholder="e.g. Right then, let's have a look at your graph."
          value={ts.greeting}
          oninput={(e) => updateTurtleSettings({ greeting: (e.target as HTMLInputElement).value })}
        />
        <p class="hint">First message when chat opens. Leave blank for the default.</p>
      </div>
    </section>

    <!-- ── Personality ────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Personality</h2>

      <div class="setting-group">
        <label>Tone</label>
        <div class="button-group">
          {#each ['helpful', 'witty', 'laid-back', 'sarcastic'] as type}
            <button
              class="personality-btn"
              class:active={ts.personality === type}
              onclick={() => setTurtlePersonality(type as 'helpful' | 'witty' | 'laid-back' | 'sarcastic')}
            >
              {type}
            </button>
          {/each}
        </div>
        <p class="hint">
          {#if ts.personality === 'helpful'}
            Supportive and instructive guidance
          {:else if ts.personality === 'witty'}
            Clever and humorous responses with wordplay
          {:else if ts.personality === 'laid-back'}
            Relaxed and casual — no rush, no pressure
          {:else}
            Dry-witted and sarcastic, but helpful underneath
          {/if}
        </p>
      </div>

      <div class="setting-group">
        <label>Response Style</label>
        <div class="button-group">
          {#each [['concise', 'Concise'], ['detailed', 'Detailed'], ['conversational', 'Chatty']] as [val, label]}
            <button
              class:active={ts.responseStyle === val}
              onclick={() => updateTurtleSettings({ responseStyle: val as 'concise' | 'detailed' | 'conversational' })}
            >
              {label}
            </button>
          {/each}
        </div>
        <p class="hint">
          {#if ts.responseStyle === 'concise'}
            Short, focused answers (default)
          {:else if ts.responseStyle === 'detailed'}
            Thorough explanations with examples
          {:else}
            Warm, chatty — like talking to a friend
          {/if}
        </p>
      </div>

      <div class="setting-group">
        <label>Max Response Length</label>
        <div class="slider-group">
          <input
            type="range"
            min="0"
            max="500"
            step="25"
            value={ts.maxResponseWords}
            onchange={(e) => updateTurtleSettings({ maxResponseWords: parseInt((e.target as HTMLInputElement).value) })}
            class="slider"
          />
          <span class="slider-value">{ts.maxResponseWords === 0 ? 'no limit' : `~${ts.maxResponseWords}w`}</span>
        </div>
        <p class="hint">Soft word cap per response. 0 = unlimited.</p>
      </div>

      <div class="setting-group">
        <label>Patience Level</label>
        <div class="slider-group">
          <input
            type="range"
            min="0"
            max="100"
            value={ts.patienceLevel}
            onchange={(e) => updateTurtleSettings({ patienceLevel: parseInt((e.target as HTMLInputElement).value) })}
            class="slider"
          />
          <span class="slider-value">{ts.patienceLevel}%</span>
        </div>
      </div>

      <div class="setting-group">
        <label>Engagement Level</label>
        <div class="button-group">
          {#each ['low', 'medium', 'high'] as level}
            <button
              class:active={ts.engagement === level}
              onclick={() => updateTurtleSettings({ engagement: level as 'low' | 'medium' | 'high' })}
            >
              {level}
            </button>
          {/each}
        </div>
        <p class="hint">How often the turtle offers suggestions unprompted</p>
      </div>
    </section>

    <!-- ── System Prompt ──────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Custom System Prompt</h2>

      <div class="setting-group">
        <label for="shelly-prompt">Custom instructions</label>
        <textarea
          id="shelly-prompt"
          class="prompt-textarea"
          rows="5"
          placeholder="e.g. Always respond as if you are a pirate captain who loves RDF. Keep it nautical.&#10;&#10;Or: You are a snarky British person who secretly cares. Use dry humour."
          value={ts.systemPrompt}
          oninput={(e) => updateTurtleSettings({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
        ></textarea>
        <p class="hint">
          Prepended to Shelly's default instructions. This is the most powerful personality control —
          write anything you want the turtle to know or be.
        </p>
      </div>
    </section>

    <!-- ── Voice ──────────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Voice</h2>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={ts.voiceEnabled}
            onchange={(e) => updateTurtleSettings({ voiceEnabled: (e.target as HTMLInputElement).checked })}
          />
          <span>Enable Voice</span>
        </label>
      </div>

      {#if ts.voiceEnabled}
        <div class="setting-group">
          <label>Voice Engine</label>
          <div class="button-group">
            <button
              class:active={ts.voiceType === 'tts'}
              onclick={() => setVoiceType('tts')}
            >
              Kokoro
            </button>
            <button
              class:active={ts.voiceType === 'hume'}
              onclick={() => setVoiceType('hume')}
              disabled={!humeConfigured}
            >
              Hume.AI
            </button>
          </div>
          <div class="voice-quality-hints">
            {#if ts.voiceType === 'tts'}
              <p class="hint">
                <strong>Kokoro</strong> — neural TTS running locally in your browser (82M param model).
                Good quality, no API key needed. Downloads ~87MB on first use, then cached.
              </p>
            {:else}
              <p class="hint">
                <strong>Hume.AI</strong> — premium cloud voice with emotional intelligence.
                Best quality, customizable personas. Requires API key below.
              </p>
            {/if}
          </div>
          {#if !humeConfigured && ts.voiceType === 'tts'}
            <p class="hint" style="margin-top: 0.25rem; color: var(--accent);">
              For the best voice experience, add a Hume.AI API key below.
            </p>
          {/if}
        </div>

        {#if ts.voiceType === 'tts'}
          <div class="setting-group">
            <label>Kokoro Voice</label>
            {#each Object.entries(voicesByGroup) as [group, voices]}
              <p class="voice-group-label">{group}</p>
              <div class="voice-grid">
                {#each voices as v}
                  <button
                    class="voice-chip"
                    class:active={ts.kokoroVoice === v.id}
                    class:previewing={previewingVoice === v.id}
                    onclick={() => {
                      updateTurtleSettings({ kokoroVoice: v.id });
                      previewVoice(v.id);
                    }}
                  >
                    <span class="voice-name">{v.label}</span>
                    <span class="voice-grade">{v.grade}</span>
                  </button>
                {/each}
              </div>
            {/each}
            <p class="hint">Click a voice to select and preview it. Grade indicates quality (A = best).</p>
          </div>
        {/if}

        <div class="setting-group">
          <label>Speech Rate</label>
          <div class="slider-group">
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={ts.speechRate}
              onchange={(e) => updateTurtleSettings({ speechRate: parseFloat((e.target as HTMLInputElement).value) })}
              class="slider"
            />
            <span class="slider-value">{ts.speechRate.toFixed(1)}x</span>
          </div>
        </div>

        <div class="setting-group">
          <label>Volume</label>
          <div class="slider-group">
            <input
              type="range"
              min="0"
              max="100"
              value={ts.volume}
              onchange={(e) => updateTurtleSettings({ volume: parseInt((e.target as HTMLInputElement).value) })}
              class="slider"
            />
            <span class="slider-value">{ts.volume}%</span>
          </div>
        </div>
      {/if}
    </section>

    <!-- ── Hume.AI ────────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Hume.AI Voice Persona</h2>

      <p class="section-intro">
        Connect a Hume.AI EVI voice persona for natural spoken conversation.
        Each turtle persona can have its own voice — a calm voice for personal, an energetic one for work.
      </p>

      <div class="setting-group">
        <label for="hume-api-key">API Key</label>
        <input
          id="hume-api-key"
          type="password"
          class="text-input"
          placeholder="paste API key from platform.hume.ai"
          value={ts.humeApiKey}
          oninput={(e) => updateTurtleSettings({ humeApiKey: (e.target as HTMLInputElement).value })}
        />
      </div>

      <div class="setting-group">
        <label for="hume-secret-key">Secret Key</label>
        <input
          id="hume-secret-key"
          type="password"
          class="text-input"
          placeholder="paste Secret key from platform.hume.ai"
          value={ts.humeSecretKey}
          oninput={(e) => updateTurtleSettings({ humeSecretKey: (e.target as HTMLInputElement).value })}
        />
        <p class="hint">
          Both keys enable token-based auth (more secure).
          Find them at <span class="mono">platform.hume.ai &#x2192; API Keys</span>.
        </p>
      </div>

      <div class="setting-group">
        <label for="hume-config-id">EVI Config ID</label>
        <input
          id="hume-config-id"
          type="text"
          class="text-input"
          placeholder="leave blank for Hume default voice"
          value={ts.humeConfigId}
          oninput={(e) => updateTurtleSettings({ humeConfigId: (e.target as HTMLInputElement).value })}
        />
        <p class="hint">
          Voice persona from <span class="mono">platform.hume.ai &#x2192; EVI &#x2192; Configs</span>.
          Different personas let you give each turtle a unique voice.
        </p>
      </div>

      {#if ts.humeApiKey && !ts.humeConfigId}
        <div class="setting-group">
          <button
            class="auto-config-btn"
            onclick={autoConfigHumeVoice}
            disabled={humeAutoConfigBusy}
          >
            {humeAutoConfigBusy ? 'Creating...' : `Auto-create voice config for "${ts.name || 'Shelly'}"`}
          </button>
          {#if humeAutoConfigMsg}
            <p class="hint">{humeAutoConfigMsg}</p>
          {/if}
          <p class="hint">Creates an EVI config via the Hume API. You can then customize the voice in the Hume portal.</p>
        </div>
      {/if}

      <details class="voice-docs">
        <summary>Manual setup: create a custom voice persona</summary>
        <ol class="voice-steps">
          <li>Go to <span class="mono">platform.hume.ai</span> and sign in.</li>
          <li>Navigate to <strong>EVI &gt; Configs</strong> and click <strong>New Config</strong>.</li>
          <li>Name it after your turtle (e.g. "{ts.name || 'Shelly'}") and choose a voice.</li>
          <li>Under <strong>Language Model</strong>, leave default — Reckons.AI overrides with the turtle's brain.</li>
          <li>Click <strong>Create</strong>, copy the <strong>Config ID</strong>.</li>
          <li>Paste it in the <strong>EVI Config ID</strong> field above.</li>
        </ol>
      </details>
    </section>

  </div>

  <div class="section-divider">
    <span class="divider-label mono">turtle companion</span>
  </div>

  <div class="settings-grid">
    <!-- ── Visual ─────────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Visual &amp; Animation</h2>

      <div class="setting-group">
        <label>Animation Speed</label>
        <div class="button-group">
          {#each ['slow', 'normal', 'fast'] as speed}
            <button
              class:active={ts.animationSpeed === speed}
              onclick={() => updateTurtleSettings({ animationSpeed: speed as 'slow' | 'normal' | 'fast' })}
            >
              {speed}
            </button>
          {/each}
        </div>
      </div>

      <div class="setting-group">
        <label>Opacity (when idle)</label>
        <div class="slider-group">
          <input
            type="range"
            min="0"
            max="100"
            value={ts.opacity}
            onchange={(e) => updateTurtleSettings({ opacity: parseInt((e.target as HTMLInputElement).value) })}
            class="slider"
          />
          <span class="slider-value">{ts.opacity}%</span>
        </div>
      </div>

      <div class="setting-group">
        <label>Size</label>
        <div class="button-group">
          {#each ['small', 'medium', 'large'] as size}
            <button
              class:active={ts.size === size}
              onclick={() => updateTurtleSettings({ size: size as 'small' | 'medium' | 'large' })}
            >
              {size}
            </button>
          {/each}
        </div>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={ts.glowEffect}
            onchange={(e) => updateTurtleSettings({ glowEffect: (e.target as HTMLInputElement).checked })}
          />
          <span>Glow Effect on Hover</span>
        </label>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={ts.positionSticky}
            onchange={(e) => updateTurtleSettings({ positionSticky: (e.target as HTMLInputElement).checked })}
          />
          <span>Sticky Position (persists across reloads)</span>
        </label>
      </div>
    </section>


    <!-- ── Help & Tutorial ────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Help &amp; Tutorial</h2>

      <div class="setting-group">
        <label>Proactive Help</label>
        <div class="button-group">
          {#each ['never', 'errors-only', 'always'] as level}
            <button
              class:active={ts.proactiveHelp === level}
              onclick={() => updateTurtleSettings({ proactiveHelp: level as 'never' | 'errors-only' | 'always' })}
            >
              {level}
            </button>
          {/each}
        </div>
      </div>

      <div class="setting-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={ts.showTutorialHints}
            onchange={(e) => updateTurtleSettings({ showTutorialHints: (e.target as HTMLInputElement).checked })}
          />
          <span>Show Tutorial Hints During Tasks</span>
        </label>
      </div>

      <div class="setting-group">
        <label>Response Frequency</label>
        <div class="slider-group">
          <input
            type="range"
            min="0"
            max="100"
            value={ts.responseFrequency}
            onchange={(e) => updateTurtleSettings({ responseFrequency: parseInt((e.target as HTMLInputElement).value) })}
            class="slider"
          />
          <span class="slider-value">{ts.responseFrequency}%</span>
        </div>
        <p class="hint">How often the turtle responds to your actions</p>
      </div>
    </section>

    <!-- ── TTL Personality ────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2>Personality in .ttl Files</h2>

      <p class="section-intro">
        Turtle personality can be embedded in a .ttl file using the <span class="mono">shelly:</span> vocabulary.
        When you import a .ttl with personality triples, they override the defaults for that graph.
      </p>

      <details class="voice-docs">
        <summary>Example .ttl personality block</summary>
        <pre class="code-block mono"><code>@prefix shelly: &lt;urn:reckons:shelly/&gt; .

shelly:persona
    shelly:name         "Nigel" ;
    shelly:greeting     "Right then, let's sort this graph." ;
    shelly:personality  "sarcastic" ;
    shelly:systemPrompt "You are a snarky British person who secretly cares deeply about data quality. Use dry humour and British spellings." ;
    shelly:responseStyle "conversational" ;
    shelly:maxWords     "150" .</code></pre>
        <p class="hint">
          Include this block in any .ttl you share. Recipients will see your custom persona
          when they import the file.
        </p>
      </details>
    </section>

    <!-- ── Support footer ─────────────────────────────────────────── -->
    <footer class="settings-support-footer">
      <a href="https://www.paypal.com/ncp/payment/KH5J484QMVFS2" target="_blank" rel="noopener noreferrer" class="support-link mono">☕ buy me a coffee</a>
      <p class="mono support-sub">Reckons.AI is free, open source, and self-funded.</p>
    </footer>
  </div>
</div>

<style>
  .turtle-settings {
    max-width: 900px;
    margin: 0 auto;
    padding: 2rem;
  }

  .head { margin-bottom: 1.25rem; }
  .kicker {
    color: var(--accent);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    margin: 0 0 0.25rem;
  }

  .page-intro {
    font-size: 0.88rem;
    color: var(--ink-2);
    line-height: 1.6;
    margin: 0 0 1.5rem;
    max-width: 640px;
  }

  .section-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 2rem 0 1.25rem;
  }
  .section-divider::before,
  .section-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .divider-label {
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    white-space: nowrap;
  }

  .settings-nav {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding-top: 0.75rem;
    border-top: 1px solid var(--line);
  }

  .nav-link {
    padding: 0.35rem 0.75rem;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--muted);
    border: 1px solid var(--line);
    text-decoration: none;
    transition: all 0.15s;
  }

  .nav-link:hover {
    color: var(--ink-2);
    border-color: var(--muted-2);
  }

  .nav-link.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: 2rem;
  }

  .settings-section {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.5rem;
  }

  .settings-section h2 {
    font-size: 0.85rem;
    color: var(--accent);
    margin: 0 0 1.25rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .setting-group {
    margin-bottom: 1.5rem;
  }

  .setting-group:last-child {
    margin-bottom: 0;
  }

  .setting-group label {
    display: block;
    font-size: 0.9rem;
    color: var(--ink-2);
    margin-bottom: 0.6rem;
    font-weight: 500;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    margin-bottom: 0;
  }

  .checkbox-label input {
    cursor: pointer;
  }

  .button-group {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .button-group button {
    padding: 0.5rem 0.85rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
    flex: 1;
    min-width: 80px;
  }

  .button-group button:hover {
    border-color: var(--muted-2);
    color: var(--ink-2);
  }

  .button-group button.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .slider-group {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .slider {
    flex: 1;
    cursor: pointer;
  }

  .slider-value {
    min-width: 60px;
    text-align: right;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--ink-2);
  }

  .hint {
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0.5rem 0 0;
  }

  .section-intro {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0 0 1.25rem;
    line-height: 1.5;
  }

  .prompt-textarea {
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    resize: vertical;
    line-height: 1.5;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .prompt-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .text-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 0.82rem;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .text-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .voice-quality-hints {
    margin-top: 0.5rem;
  }
  .voice-docs {
    margin-top: 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
  }
  .voice-docs summary {
    font-size: 0.78rem;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono);
    user-select: none;
  }
  .voice-steps {
    margin: 0.75rem 0 0.5rem 1rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .voice-steps li {
    font-size: 0.78rem;
    color: var(--ink-2);
    line-height: 1.45;
  }

  .code-block {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.75rem;
    margin: 0.75rem 0 0.5rem;
    overflow-x: auto;
    font-size: 0.72rem;
    line-height: 1.5;
    white-space: pre;
    color: var(--ink-2);
  }

  .voice-group-label {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0.75rem 0 0.35rem;
  }
  .voice-group-label:first-of-type {
    margin-top: 0.25rem;
  }
  .voice-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .voice-chip {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .voice-chip:hover {
    border-color: var(--muted-2);
    color: var(--ink-2);
  }
  .voice-chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .voice-chip.previewing {
    box-shadow: 0 0 0 1px var(--accent), 0 0 6px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .voice-grade {
    font-size: 0.62rem;
    opacity: 0.6;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .auto-config-btn {
    padding: 0.5rem 1rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .auto-config-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--surface);
  }
  .auto-config-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  @media (max-width: 768px) {
    .settings-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── Support footer ──────────────────────────────────────────── */
  .settings-support-footer {
    text-align: center;
    padding: 1.5rem 1rem;
    margin-top: 0.5rem;
    border-top: 1px solid var(--line);
  }
  .support-link {
    font-size: 0.8rem;
    color: var(--accent);
    text-decoration: none;
    transition: opacity 0.15s;
  }
  .support-link:hover { opacity: 0.7; }
  .support-sub {
    font-size: 0.65rem;
    color: var(--muted);
    margin: 0.3rem 0 0;
  }
</style>
