<script lang="ts">
  /**
   * Feedback from anywhere (kb:feedback-channel).
   *
   * bits-ui Dialog for the same reason DownloadConsentDialog uses it: a hand-rolled overlay
   * dropped tap events on touch devices, and bits-ui handles portal, focus trap and Escape.
   *
   * Deliberately NOT a floating chip on the canvas — that pattern was tried for pod view and
   * removed because it was disliked. This has no persistent on-canvas presence; it is reached
   * from the nav, and otherwise invisible.
   */
  import { Dialog } from 'bits-ui';
  import ContactForm from '$lib/components/ContactForm.svelte';
  import { feedbackOpen, feedbackSource, closeFeedback } from '$lib/stores/feedback.svelte';

  const open = $derived(feedbackOpen());
  const source = $derived(feedbackSource());
</script>

<Dialog.Root {open} onOpenChange={(o) => { if (!o) closeFeedback(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="feedback-overlay" />
    <Dialog.Content class="feedback-dialog">
      <Dialog.Title class="feedback-title mono">send feedback</Dialog.Title>
      <Dialog.Description class="feedback-desc">
        What's working, what isn't, what you expected instead. We read all of it.
        <span class="feedback-source mono">from: {source}</span>
      </Dialog.Description>

      <ContactForm {source} subject="Reckons.AI feedback" />

      <button class="feedback-close mono" onclick={closeFeedback}>close</button>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* Above NavBar (400) and the Shelly/search layers, matching the consent dialog's band. */
  :global(.feedback-overlay) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 600;
    backdrop-filter: blur(2px);
  }
  :global(.feedback-dialog) {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 601;
    width: calc(100vw - 2rem);
    max-width: 560px;
    max-height: calc(100vh - 3rem);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-md, 10px);
    padding: 1.25rem;
  }
  :global(.feedback-title) {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
    margin: 0 0 0.4rem;
  }
  :global(.feedback-desc) {
    display: block;
    font-size: 0.85rem;
    color: var(--text-2, var(--muted));
    line-height: 1.5;
    margin: 0 0 1rem;
  }
  .feedback-source {
    display: inline-block;
    margin-left: 0.5rem;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    opacity: 0.85;
  }
  .feedback-close {
    margin-top: 1rem;
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--muted);
    padding: 0.35rem 0.8rem;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .feedback-close:hover { color: var(--ink); border-color: var(--accent); }
</style>
