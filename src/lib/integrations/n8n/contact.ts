/**
 * Contact / feedback submission (F20 use case, kb:feedback-channel).
 *
 * THIS POSTS TO THE PRODUCT'S FEEDBACK ENDPOINT, NOT THE USER'S OWN n8n — and that distinction
 * is the whole point of this module, so do not "simplify" it back.
 *
 * It originally reused settings().n8nBaseUrl, the user's own automation instance. That is right
 * for every OTHER n8n feature (currents sync, review notifications): those are the user's
 * automations firing into their own systems. Feedback is the opposite direction — a message TO
 * THE MAINTAINERS about the product — and routing it through the user's instance meant:
 *
 *   - user with no n8n         -> mailto fallback (fine)
 *   - user with their OWN n8n  -> POST to THEIR server, which has no reckons-contact workflow
 *                                 -> 404 -> feedback silently lost
 *
 * That second case hits exactly the technically-inclined users most likely to run n8n, and most
 * likely to have something worth telling us.
 *
 * The endpoint is therefore CONFIGURED, not derived from user settings, and deliberately not
 * hardcoded here: set VITE_FEEDBACK_WEBHOOK_URL at build time (see .env.example). Unset means no
 * direct submit at all — the form degrades to mailto, which always works. A fork or self-hoster
 * points it at their own desk by setting their own value.
 */
export const CONTACT_WEBHOOK_PATH = '/webhook/reckons-contact';

/** The product's feedback webhook, from build-time config. Empty = mailto-only. */
export function feedbackWebhookUrl(): string {
  return (import.meta.env.VITE_FEEDBACK_WEBHOOK_URL ?? '').trim().replace(/\/+$/, '');
}

export type ContactPayload = {
  name: string;
  email: string;
  message: string;
  /** Where the submission came from (page slug, "about", etc.) — for routing. */
  source?: string;
};

export type ContactResult = { ok: true } | { ok: false; error: string; unconfigured?: boolean };

/** True when a feedback endpoint is configured, so the form can POST instead of mailto. */
export function n8nConfigured(): boolean {
  return !!feedbackWebhookUrl();
}

/** Submit a contact form to the product's feedback endpoint. */
export async function submitContactForm(payload: ContactPayload): Promise<ContactResult> {
  const url = feedbackWebhookUrl();
  if (!url) return { ok: false, error: 'No feedback endpoint configured.', unconfigured: true };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, submittedAt: new Date().toISOString() }),
    });
    if (!res.ok) return { ok: false, error: `n8n responded ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
