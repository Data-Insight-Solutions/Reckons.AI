<script lang="ts">
  /**
   * Contact form — the front-end web-integration use case for n8n (F20).
   *
   * When an n8n instance is configured (Settings → Integrations) the form POSTs
   * to its /webhook/reckons-contact endpoint; otherwise it falls back to a
   * mailto link so it always works. Embeddable on the About page and (later)
   * published pages.
   */
  import { submitContactForm, n8nConfigured, type ContactPayload } from '$lib/integrations/n8n/contact';

  let {
    source = 'about',
    fallbackEmail = 'matthew.roe@data-insight.solutions',
    subject = 'Reckons.AI contact',
  }: { source?: string; fallbackEmail?: string; subject?: string } = $props();

  let name = $state('');
  let email = $state('');
  let message = $state('');
  let sending = $state(false);
  let status = $state<'idle' | 'sent' | 'error'>('idle');
  let errorMsg = $state('');

  const configured = $derived(n8nConfigured());
  const canSend = $derived(name.trim() && email.trim() && message.trim() && !sending);

  const mailtoHref = $derived(
    `mailto:${fallbackEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`
  );

  async function send() {
    if (!canSend) return;
    sending = true;
    status = 'idle';
    const payload: ContactPayload = { name: name.trim(), email: email.trim(), message: message.trim(), source };
    const res = await submitContactForm(payload);
    sending = false;
    if (res.ok) {
      status = 'sent';
      name = ''; email = ''; message = '';
    } else {
      status = 'error';
      errorMsg = res.error;
    }
  }
</script>

<form class="contact-form" onsubmit={(e) => { e.preventDefault(); send(); }}>
  {#if status === 'sent'}
    <p class="cf-note cf-ok mono">✓ Sent — thanks, we'll be in touch.</p>
  {/if}
  <div class="cf-row">
    <label class="cf-field">
      <span class="cf-label mono">name</span>
      <input class="cf-input" type="text" bind:value={name} placeholder="your name" required />
    </label>
    <label class="cf-field">
      <span class="cf-label mono">email</span>
      <input class="cf-input" type="email" bind:value={email} placeholder="you@example.com" required />
    </label>
  </div>
  <label class="cf-field">
    <span class="cf-label mono">message</span>
    <textarea class="cf-input cf-textarea" bind:value={message} rows="4" placeholder="what's on your mind?" required></textarea>
  </label>

  <div class="cf-actions">
    {#if configured}
      <button class="cf-send" type="submit" disabled={!canSend}>{sending ? 'sending…' : 'send →'}</button>
    {:else}
      <!-- No n8n instance configured — degrade to a mailto so it always works. -->
      <a class="cf-send" class:cf-disabled={!message.trim()} href={message.trim() ? mailtoHref : undefined}>send via email →</a>
      <span class="cf-hint mono">Configure an n8n instance in Settings → Integrations to submit directly.</span>
    {/if}
    {#if status === 'error'}
      <span class="cf-note cf-err mono">Couldn't send: {errorMsg}. Try email instead.</span>
    {/if}
  </div>
</form>

<style>
  .contact-form { display: flex; flex-direction: column; gap: 0.6rem; max-width: 560px; }
  .cf-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .cf-field { display: flex; flex-direction: column; gap: 0.25rem; flex: 1; min-width: 180px; }
  .cf-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.15em; color: var(--muted); }
  .cf-input {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    padding: 0.5rem 0.65rem;
    font-size: 0.85rem;
    font-family: inherit;
  }
  .cf-input:focus { outline: none; border-color: var(--accent); }
  .cf-textarea { resize: vertical; }
  .cf-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .cf-send {
    display: inline-flex;
    align-items: center;
    background: var(--accent);
    color: #062018;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
  }
  .cf-send:disabled, .cf-disabled { opacity: 0.5; cursor: default; pointer-events: none; }
  .cf-hint { font-size: 0.62rem; color: var(--muted); opacity: 0.8; }
  .cf-note { font-size: 0.72rem; }
  .cf-ok { color: var(--accent); }
  .cf-err { color: var(--danger); }
</style>
