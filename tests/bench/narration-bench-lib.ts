/**
 * Pure helpers for the narration benchmark (F275.8.3): the word-error-rate normalizer,
 * a seeded shuffle, and the blind manifest / key split. No I/O, so each is unit-tested.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0-999 in words; larger numbers are spoken digit by digit (good enough for narration lines). */
export function numberToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  return String(n).split('').map((d) => ONES[Number(d)]).join(' ');
}

/** Lowercase, spell digits, drop punctuation, collapse space; hyphens split words. */
export function normalizeForWer(text: string): string[] {
  const spelled = text
    .toLowerCase()
    .replace(/\d+/g, (m) => ` ${numberToWords(Number(m))} `)
    .replace(/['’]/g, '')
    .replace(/[^a-z\s]/g, ' ');
  return spelled.split(/\s+/).filter(Boolean);
}

/** Word error rate: word-level edit distance over the reference length (0 = identical). */
export function wer(reference: string, hypothesis: string): number {
  const r = normalizeForWer(reference);
  const h = normalizeForWer(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/** mulberry32: a small deterministic generator so a recorded seed reproduces the shuffle. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rnd = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type BenchLine = { id: string; text: string };
export type ArmClip = { arm: string; file: string };

export type BlindEntry = {
  lineId: string;
  text: string;
  /** The reference clip is shown by name; it is the known Hume recording, not one of the blind labels. */
  humeRef: string;
  clips: { label: string; file: string }[];
};
export type KeyEntry = { lineId: string; labels: Record<string, string> };

/**
 * Builds the blind manifest and its separate key. `blind` carries no arm names anywhere; the arm for
 * each label lives only in `key`. Labels are A, B, C ... in order; which arm gets which label is a
 * seeded shuffle, independently per line.
 */
export function buildBlind(
  lines: BenchLine[],
  blindArms: string[],
  fileFor: (lineId: string, arm: string) => string,
  humeRefFor: (lineId: string) => string,
  seed: number,
): { blind: { seed: number; entries: BlindEntry[] }; key: { seed: number; entries: KeyEntry[] } } {
  const rnd = seededRandom(seed);
  const blindEntries: BlindEntry[] = [];
  const keyEntries: KeyEntry[] = [];
  for (const line of lines) {
    const order = [...blindArms];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const labels: Record<string, string> = {};
    const clips = order.map((arm, i) => {
      const label = String.fromCharCode(65 + i);
      labels[label] = arm;
      return { label, file: fileFor(line.id, arm) };
    });
    blindEntries.push({ lineId: line.id, text: line.text, humeRef: humeRefFor(line.id), clips });
    keyEntries.push({ lineId: line.id, labels });
  }
  return { blind: { seed, entries: blindEntries }, key: { seed, entries: keyEntries } };
}
