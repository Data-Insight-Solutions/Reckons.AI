/**
 * What a story step may OFFER the reader with one click (F261): a setting, or a page to open.
 *
 * Matt, 2026-10-27: "make the walkthroughs a bit more hand held, so settings should be suggested with
 * a single click to set them, from Shelly story." A step that says "open Settings, then Triple Check,
 * and tick the box" makes a first-time reader leave the story to do it; a button in the step does it
 * where they are.
 *
 * OFFERED, NEVER APPLIED, AND ONLY FROM AN ALLOWLIST. A story is data, and it can arrive from anyone. So a step names an offer, the reader's click applies it, and only the settings
 * below can be offered at all, with only the values listed. Nothing that sends data anywhere is on it:
 * a story can offer to keep Triple Check OFF the internet, never to turn the internet on; it can never
 * offer a backend, an address, a key or a model. Anything else is ignored, not guessed at.
 *
 * Authored as literals on a step:
 *   story:offerSetting "tripleCheckEnabled=true" ;
 *   story:openPage     "/review?group=source" .
 */
import type { SettingsRecord } from '$lib/storage/db';

export type SettingOffer = { kind: 'setting'; key: keyof SettingsRecord; value: boolean; label: string };
export type PageOffer = { kind: 'page'; path: string; label: string };
export type StoryOffer = SettingOffer | PageOffer;

const OFFERABLE: Partial<Record<keyof SettingsRecord, Partial<Record<'true' | 'false', string>>>> = {
  tripleCheckEnabled: { true: 'Turn on Triple Check for this space', false: 'Turn off Triple Check for this space' },
  // Off only: turning the internet ON sends each checked claim to services the reader chooses in Settings.
  tripleCheckWebEnabled: { false: 'Keep Triple Check off the internet' },
  prefer2D: { true: 'Use the 2D graph', false: 'Use the 3D graph' },
};

/** What an unset value means, so a button can say it is already done. Triple Check is off until turned on; its web half is on until turned off. */
const DEFAULTS: Partial<Record<keyof SettingsRecord, boolean>> = { tripleCheckEnabled: false, tripleCheckWebEnabled: true, prefer2D: false };

export function offerApplied(offer: SettingOffer, current: Partial<SettingsRecord>): boolean {
  return ((current[offer.key] as boolean | undefined) ?? DEFAULTS[offer.key]) === offer.value;
}

/** "key=value" -> an offer, or null for anything not on the allowlist. */
export function parseSettingOffer(raw: string): SettingOffer | null {
  const m = raw.trim().match(/^(\w+)=(true|false)$/);
  if (!m) return null;
  const label = OFFERABLE[m[1] as keyof SettingsRecord]?.[m[2] as 'true' | 'false'];
  return label ? { kind: 'setting', key: m[1] as keyof SettingsRecord, value: m[2] === 'true', label } : null;
}

const PAGE_NAMES: Record<string, string> = { '': 'the graph', review: 'Review', settings: 'Settings', kb: 'Spaces', ingest: 'Add', about: 'About' };

/** A path inside this app only: no other origin, no protocol, no script. */
export function parsePageOffer(raw: string): PageOffer | null {
  const path = raw.trim();
  if (!/^\/(?![/\\])[\w\-/?=&.%]*$/.test(path)) return null;
  const first = path.slice(1).split(/[/?]/)[0];
  const name = PAGE_NAMES[first];
  return name ? { kind: 'page', path, label: `Open ${name}` } : null;
}
