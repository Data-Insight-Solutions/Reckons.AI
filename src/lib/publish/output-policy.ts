import sanitizeHtml from 'sanitize-html';

/** Static exports have no executable runtime and load images only from their own site. */
export const STATIC_SITE_CSP = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function localImageUrl(value: string | null): string | null {
  if (!value || /[\s\\\x00-\x1f\x7f]/.test(value) || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'https://published.invalid/');
    // Require a relative reference. Even an absolute URL using the test origin is rejected.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || url.origin !== 'https://published.invalid') return null;
    return value;
  } catch { return null; }
}

export function sanitizePageHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code',
      'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 's', 'del', 'a', 'img', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'caption', 'details', 'summary', 'div', 'span', 'sup', 'sub'],
    allowedAttributes: { a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title'],
      code: ['class'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], ol: ['start'] },
    allowedClasses: { code: [/^language-[a-z0-9-]+$/i] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    nestingLimit: 30,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
      img: (tagName, attribs): sanitizeHtml.Tag => {
        const src = localImageUrl(attribs.src);
        return { tagName, attribs: src ? { ...attribs, src } : { alt: attribs.alt ?? '' } };
      },
    },
  });
}

export function themeColor(value: string | null, fallback: string): string {
  if (!value) return fallback;
  // Explicit color syntax only. No CSS functions with URLs, escapes or declarations.
  return /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|rgba?\(\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+(?:\s*,\s*[\d.]+)?\s*\)|[a-z]+)$/i.test(value)
    ? value : fallback;
}

export function themeFont(value: string | null, fallback: string): string {
  return value && /^[a-zA-Z0-9 ,_-]+$/.test(value) ? value : fallback;
}
