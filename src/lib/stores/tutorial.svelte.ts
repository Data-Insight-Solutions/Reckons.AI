/**
 * Tutorial nudge engine.
 *
 * Fires contextual one-time notifications to guide new users through the
 * main workflow tabs. Nudges use the existing `pushNotification` with
 * `oneTime: true` so they are stored in localStorage and never re-appear
 * after dismissal.
 *
 * All nudges are suppressed when `settings().showTutorialHints === false`.
 *
 * Usage — call `nudge(event)` at lifecycle moments in +layout.svelte or page components.
 * Each nudge ID is stable, so it fires at most once per device.
 */

import { pushNotification } from './notifications.svelte';
import { getSettings } from '$lib/storage/db';

export type TutorialEvent =
  | 'app-loaded-empty'        // KB is empty on first load
  | 'template-selected'       // user picked a starter template
  | 'first-source-ingested'   // first source has been ingested
  | 'first-pending-statement' // first pending statement is in the queue
  | 'first-confirmed-statement' // first statement confirmed
  | 'first-reckoning-done'    // first Reckoning proposal generated
  | 'kb-has-data';            // KB has confirmed data — suggest Reckoning

export async function nudge(event: TutorialEvent): Promise<void> {
  // Check settings async (avoids importing the reactive store which causes SSR issues)
  const s = await getSettings().catch(() => null);
  if (!s?.showTutorialHints) return;

  switch (event) {
    case 'app-loaded-empty':
      pushNotification({
        id: 'tutorial:empty-kb',
        type: 'info',
        title: 'Welcome to Reckons.AI',
        body: 'Choose a starter scenario below to explore the app, or head to Ingest to add your own knowledge.',
        oneTime: true,
      });
      break;

    case 'template-selected':
      pushNotification({
        id: 'tutorial:template-loaded',
        type: 'success',
        title: 'Starter loaded',
        body: 'Your KB has some knowledge. Ask Shelly a question, or run a Reckoning to see what it knows.',
        action: { label: 'Open Shelly' },
        oneTime: true,
      });
      break;

    case 'first-source-ingested':
      pushNotification({
        id: 'tutorial:first-ingest',
        type: 'success',
        title: 'Source ingested',
        body: 'Triples are waiting for your review. Head to Review to confirm the ones that look right.',
        action: { label: 'Review →', href: '/review' },
        oneTime: true,
      });
      break;

    case 'first-pending-statement':
      pushNotification({
        id: 'tutorial:first-pending',
        type: 'info',
        title: 'Triples extracted',
        body: 'The AI found facts in your source. Confirm the accurate ones in Review — only confirmed triples enter your KB.',
        action: { label: 'Review →', href: '/review' },
        oneTime: true,
      });
      break;

    case 'first-confirmed-statement':
      pushNotification({
        id: 'tutorial:first-confirmed',
        type: 'success',
        title: 'First triple confirmed',
        body: 'Your KB is building up. When you have a few facts, try a Reckoning — describe your situation and let the KB propose a path forward.',
        action: { label: 'Try a Reckoning →', href: '/reckoning' },
        oneTime: true,
      });
      break;

    case 'kb-has-data':
      pushNotification({
        id: 'tutorial:has-data',
        type: 'info',
        title: 'Ready for a Reckoning',
        body: 'You have verified knowledge in your KB. Describe a situation and target — Reckons.AI will propose options grounded in what you already know.',
        action: { label: 'Run a Reckoning →', href: '/reckoning' },
        oneTime: true,
      });
      break;

    case 'first-reckoning-done':
      pushNotification({
        id: 'tutorial:first-reckoning',
        type: 'success',
        title: 'Your first Reckoning',
        body: 'The proposal is grounded in your KB. Accept KB actions to mark the decision — then export your .ttl to share it with others.',
        action: { label: 'KB →', href: '/kb' },
        oneTime: true,
      });
      break;
  }
}
