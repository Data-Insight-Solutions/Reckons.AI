import { describe, it, expect } from 'vitest';
import { frontmatterToMarkdown, slugify, type PageFrontmatter } from '../page-markdown.js';

describe('slugify', () => {
  it('kebab-cases a title, mirroring src/lib/rdf/page.ts', () => {
    expect(slugify('Cross KB Alignment & Merging')).toBe('cross-kb-alignment-merging');
    expect(slugify("It's a Test!")).toBe('its-a-test');
    expect(slugify('  leading and trailing  ')).toBe('leading-and-trailing');
  });

  it('falls back to "page" for input with no sluggable characters', () => {
    expect(slugify('!!!')).toBe('page');
  });
});

describe('frontmatterToMarkdown', () => {
  const base: PageFrontmatter = {
    title: 'Welcome',
    slug: 'welcome',
    order: 1,
    section: 'Docs',
    template: 'doc',
    status: 'published',
    nav: 'sidebar',
    excerpt: 'An excerpt.',
  };

  it('matches the field order and quoting rules of pageToMarkdown() in site-export.ts', () => {
    const md = frontmatterToMarkdown(base, '# Welcome\n\nBody text.');
    expect(md.startsWith('---\n')).toBe(true);
    const lines = md.split('\n');
    expect(lines.slice(0, 9)).toEqual([
      '---',
      'title: "Welcome"',
      'slug: "welcome"',
      'order: 1',
      'section: "Docs"',
      'template: doc',
      'status: published',
      'nav: sidebar',
      'excerpt: "An excerpt."',
    ]);
    expect(lines[9]).toBe('---');
    expect(lines[10]).toBe('');
    expect(md).toContain('# Welcome\n\nBody text.');
  });

  it('omits optional keys (section, date, excerpt) entirely when unset, without shifting later keys out of order', () => {
    const minimal: PageFrontmatter = { title: 'X', slug: 'x', order: 0, template: 'doc', status: 'draft', nav: 'sidebar' };
    const md = frontmatterToMarkdown(minimal, 'body');
    const header = md.split('---\n')[1].trim().split('\n');
    expect(header).toEqual(['title: "X"', 'slug: "x"', 'order: 0', 'template: doc', 'status: draft', 'nav: sidebar']);
  });

  it('places date between nav and excerpt for the post template', () => {
    const post: PageFrontmatter = { ...base, template: 'post', date: '2026-07-01' };
    const md = frontmatterToMarkdown(post, 'body');
    const header = md.split('---\n')[1].trim().split('\n').map((l) => l.split(':')[0]);
    expect(header).toEqual(['title', 'slug', 'order', 'section', 'template', 'status', 'nav', 'date', 'excerpt']);
  });

  it('escapes backslashes and double quotes like yamlStr() in site-export.ts', () => {
    const md = frontmatterToMarkdown({ ...base, title: 'A "quoted" \\ title' }, 'body');
    expect(md).toContain('title: "A \\"quoted\\" \\\\ title"');
  });

  it('defaults an empty body to a level-1 heading of the title', () => {
    const md = frontmatterToMarkdown(base, '');
    expect(md.endsWith('# Welcome\n')).toBe(true);
  });
});
