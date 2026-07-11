/**
 * n8n contact-form submission (F20 use case).
 *
 * A front-end contact form POSTs to an n8n webhook, which the user's self-hosted
 * n8n instance routes however they like (email, a sheet, a ticket, Slack…). This
 * is the clean "web integration via open-source, self-hosted automation" case:
 * the app stays static/offline-first; n8n owns the side effects.
 *
 * Reuses settings().n8nBaseUrl (Settings → Integrations), the same base as the
 * currents-sync workflows. Webhook path: /webhook/reckons-contact.
 */
import { settings } from '../../stores/settings.svelte';

export const CONTACT_WEBHOOK_PATH = '/webhook/reckons-contact';

export type ContactPayload = {
  name: string;
  email: string;
  message: string;
  /** Where the submission came from (page slug, "about", etc.) — for routing. */
  source?: string;
};

export type ContactResult = { ok: true } | { ok: false; error: string; unconfigured?: boolean };

/** True when an n8n base URL is configured, so the form can POST instead of mailto. */
export function n8nConfigured(): boolean {
  return !!settings().n8nBaseUrl?.trim();
}

/** Submit a contact form to the configured n8n instance. */
export async function submitContactForm(payload: ContactPayload): Promise<ContactResult> {
  const base = settings().n8nBaseUrl?.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'No n8n instance configured.', unconfigured: true };

  try {
    const res = await fetch(`${base}${CONTACT_WEBHOOK_PATH}`, {
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
