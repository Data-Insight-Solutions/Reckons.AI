/**
 * Minimal replica of the WebPage markdown shape (frontmatter + body) used by
 * the app's publishing pipeline. mcp-server is a standalone Node.js package
 * (own package.json) and cannot import across the package boundary, so this
 * mirrors the writer just enough to stay round-trip compatible with what
 * Sveltia CMS and `scripts/md-align.ts` expect.
 *
 * Canonical source: `src/lib/publish/site-export.ts` (`pageToMarkdown`,
 * `yamlStr`) and `src/lib/rdf/page.ts` (`PageTemplate`/`PageStatus`/`PageNav`
 * unions, `slugify`). Keep this in sync if those change — especially
 * frontmatter key order, since `src/lib/publish/site-import.ts` parses files
 * back out with a fixed set of recognized keys.
 *
 * Deliberately omits `parent`/`related`: those only make sense for pages
 * that already exist as graph nodes with resolvable sibling slugs, which
 * doesn't apply to the standalone/proposal documents these tools produce.
 * Omitting them doesn't disturb key order — `pageToMarkdown` only emits them
 * when present, so the remaining keys line up exactly.
 */

export type PageTemplate = 'landing' | 'doc' | 'full' | 'sidebar' | 'post';
export type PageStatus = 'draft' | 'published' | 'unlisted';
export type PageNav = 'menu' | 'sidebar' | 'both' | 'hidden';

export interface PageFrontmatter {
  title: string;
  slug: string;
  order: number;
  section?: string;
  template: PageTemplate;
  status: PageStatus;
  nav: PageNav;
  /** ISO yyyy-mm-dd — post template only. */
  date?: string;
  excerpt?: string;
}

/** Mirrors `slugify()` in `src/lib/rdf/page.ts`. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page'
  );
}

/** Mirrors `yamlStr()` in `src/lib/publish/site-export.ts`. */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serialize frontmatter + body into a WebPage markdown document. Mirrors
 * `pageToMarkdown()`'s field order exactly: title, slug, order, section?,
 * template, status, nav, date?, excerpt? — then a blank line, then the body.
 */
export function frontmatterToMarkdown(fm: PageFrontmatter, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlStr(fm.title)}`);
  lines.push(`slug: ${yamlStr(fm.slug)}`);
  lines.push(`order: ${fm.order}`);
  if (fm.section) lines.push(`section: ${yamlStr(fm.section)}`);
  lines.push(`template: ${fm.template}`);
  lines.push(`status: ${fm.status}`);
  lines.push(`nav: ${fm.nav}`);
  if (fm.date) lines.push(`date: ${yamlStr(fm.date)}`);
  if (fm.excerpt) lines.push(`excerpt: ${yamlStr(fm.excerpt)}`);
  lines.push('---');
  lines.push('');
  lines.push(body || `# ${fm.title}\n`);
  return lines.join('\n');
}
