const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
/** True only for an address on this machine. Triple Check (F100.1) sends a statement nowhere else
 *  (Matt's decision of 2026-10-28, quoted under kpred:decided on kb:triple-check). */
export function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try { return LOOPBACK.includes(new URL(value).hostname); } catch { return false; }
}
/** Private by LITERAL address or mDNS suffix only: RFC 1918 (10/8, 172.16/12, 192.168/16), fd00::/8, *.local.
 *  A bare name (gpu-box) is never private here: the browser cannot see what it resolves to, so it could be public. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h.endsWith('.local')) return h.length > 6;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) { const [a, b, c, d] = v4.slice(1).map(Number); if ([a, b, c, d].some(n => n > 255)) return false; return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  return /^\[fd[0-9a-f]{2}:[0-9a-f:]*\]$/.test(h);
}
/** An allowlist entry in the form URL gives a hostname, so "fd12::1", "[fd12::1]" and "fd12:0::1" all match. */
function allowedHost(entry: string): string | null {
  const e = entry.trim();
  if (!e) return null;
  try { return new URL(`http://${e.includes(':') && !e.startsWith('[') ? `[${e}]` : e}`).hostname.toLowerCase(); } catch { return null; }
}
/** Loopback always; a private address only when the user named it in `allowed` (empty by default). */
export function isPermittedLocalUrl(value: string | undefined, allowed: string[] | undefined): boolean {
  if (isLoopbackUrl(value)) return true;
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return isPrivateHost(host) && (allowed ?? []).some(a => allowedHost(a) === host);
  } catch { return false; }
}
