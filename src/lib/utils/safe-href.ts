/** True only when the value is an http(s) link. A stored value rendered as an `<a href>` is
 *  attacker-influenced data (a knowledge base can be imported from anywhere), so `javascript:`, `data:`
 *  and bare names never become links — they render as plain text instead. */
export function isSafeWebHref(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^https?:\/\/.+/i.test(value);
}
