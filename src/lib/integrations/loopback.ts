/** True only for an address on this machine. Triple Check (F100.1) sends a statement nowhere else:
 *  Matt, 2026-10-28: "completely free open source, without API services off this device other than the
 *  web get". An Ollama or SearXNG address that names another host is refused, not tried. */
export function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); } catch { return false; }
}
