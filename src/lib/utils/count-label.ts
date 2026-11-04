/**
 * "1 fact", "2 facts", "0 facts". Only for regular English plurals (add an s); pass `plural` for
 * an irregular one. Exists so a count shown to a person is never "1 facts".
 */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}
