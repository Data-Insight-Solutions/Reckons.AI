/**
 * n8n review-notification (F73) — "email me when there's something to review".
 *
 * Reckons.AI is local-first and sends no email itself; instead, when new facts
 * land for review it POSTs a small summary to the user's self-hosted n8n, which
 * routes it however they like (email, Slack, a digest…). Same base URL + design
 * as the contact form (contact.ts) and currents-sync: the app fires the event,
 * n8n owns the side effect.
 *
 * One unified signal drives all of it: pending facts arriving via addStatements —
 * whether from a scheduled grant scrape (currents), a subscribed publisher's pod,
 * or any ingest. Opt-in via settings.n8nNotifyOnReview + n8nBaseUrl.
 */
import { settings } from '../../stores/settings.svelte';

export const REVIEW_WEBHOOK_PATH = '/webhook/reckons-review';

export type ReviewNotice = {
  /** How many new facts are waiting for review in this batch. */
  count: number;
  /** Where they came from — a source title, publisher name, or "grant scrape". */
  source?: string;
  /** Coarse kind, so an n8n workflow can route/format per origin. */
  kind?: 'ingest' | 'pod' | 'subscription' | 'scrape';
  /** A few human-readable example labels (subjects) to preview in the email. */
  samples?: string[];
};

export type NotifyResult = { ok: true } | { ok: false; error: string; skipped?: boolean };

/** True when review notifications are enabled AND an n8n base URL is set. */
export function reviewNotifyEnabled(): boolean {
  return !!settings().n8nNotifyOnReview && !!settings().n8nBaseUrl?.trim();
}

/**
 * Best-effort: POST a review summary to n8n. Never throws and returns quickly —
 * callers fire-and-forget from the ingest path so a slow/absent n8n never blocks
 * a graph edit. No-ops (skipped) when disabled or unconfigured.
 */
export async function notifyReview(notice: ReviewNotice): Promise<NotifyResult> {
  if (!settings().n8nNotifyOnReview) return { ok: false, error: 'notifications disabled', skipped: true };
  const base = settings().n8nBaseUrl?.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'no n8n instance configured', skipped: true };
  if (notice.count <= 0) return { ok: false, error: 'nothing to notify', skipped: true };

  try {
    const res = await fetch(`${base}${REVIEW_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...notice,
        samples: notice.samples?.slice(0, 5),
        at: new Date().toISOString(),
      }),
    });
    if (!res.ok) return { ok: false, error: `n8n responded ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
