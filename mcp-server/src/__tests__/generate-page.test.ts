import { describe, it, expect, vi, beforeEach } from 'vitest';

const ollamaChatJSONMock = vi.fn();

vi.mock('../ollama-client.js', () => ({
  ollamaChatJSON: (...args: unknown[]) => ollamaChatJSONMock(...args),
}));

import { generatePageMarkdown, GENERATE_PAGE_SYSTEM_PROMPT } from '../generate-page.js';

beforeEach(() => {
  ollamaChatJSONMock.mockReset();
});

describe('GENERATE_PAGE_SYSTEM_PROMPT', () => {
  it('includes the ethics preamble and grounding-discipline rules', () => {
    expect(GENERATE_PAGE_SYSTEM_PROMPT).toContain('CONTENT ETHICS');
    expect(GENERATE_PAGE_SYSTEM_PROMPT).toMatch(/ONLY facts present in the GRAPH CONTEXT/);
  });
});

describe('generatePageMarkdown', () => {
  it('propagates errors from the underlying Ollama call (e.g. disabled or retry exhausted)', async () => {
    ollamaChatJSONMock.mockRejectedValue(new Error('Local LLM offload is disabled'));
    await expect(
      generatePageMarkdown({ prompt: 'overview of the review workflow' }, '# review-workflow\n  .has-status functional'),
    ).rejects.toThrow(/disabled/);
  });

  it('happy path: produces frontmatter with the exact key order pageToMarkdown writes', async () => {
    ollamaChatJSONMock.mockResolvedValue({
      title: 'Review Workflow',
      excerpt: 'A short summary of the review workflow.',
      body: 'The review workflow has four tabs.',
    });

    const result = await generatePageMarkdown(
      { prompt: 'overview of the review workflow' },
      '# review-workflow\n  .has-status functional',
    );

    // Frontmatter key order must mirror pageToMarkdown() in site-export.ts:
    // title, slug, order, section?, template, status, nav, date?, excerpt?
    const fmBlock = result.markdown.split('---\n')[1];
    const keys = fmBlock
      .trim()
      .split('\n')
      .map((line) => line.split(':')[0]);
    expect(keys).toEqual(['title', 'slug', 'order', 'section', 'template', 'status', 'nav', 'excerpt']);

    expect(result.frontmatter.title).toBe('Review Workflow');
    expect(result.frontmatter.slug).toBe('review-workflow');
    expect(result.frontmatter.section).toBe('docs');
    expect(result.frontmatter.template).toBe('doc');
    expect(result.frontmatter.status).toBe('draft');
    expect(result.frontmatter.nav).toBe('sidebar');
    expect(result.frontmatter.excerpt).toBe('A short summary of the review workflow.');
    expect(result.frontmatter.date).toBeUndefined();

    expect(result.markdown.startsWith('---\n')).toBe(true);
    expect(result.markdown).toContain('title: "Review Workflow"');
    expect(result.markdown).toContain('template: doc');
    expect(result.markdown).toContain('status: draft');
    expect(result.markdown).toContain('The review workflow has four tabs.');

    // Grounding context and prompt reach the model.
    const [messages] = ollamaChatJSONMock.mock.calls[0];
    expect(messages[0].content).toContain('CONTENT ETHICS');
    expect(messages[1].content).toContain('overview of the review workflow');
    expect(messages[1].content).toContain('review-workflow');
  });

  it('derives the slug from the title via kebab-case when no explicit slug is given', async () => {
    ollamaChatJSONMock.mockResolvedValue({
      title: 'Cross KB Alignment & Merging',
      excerpt: 'Excerpt.',
      body: 'Body.',
    });
    const result = await generatePageMarkdown({ prompt: 'cross kb alignment' }, '');
    expect(result.frontmatter.slug).toBe('cross-kb-alignment-merging');
  });

  it('uses an explicit slug param over the derived one, still kebab-cased', async () => {
    ollamaChatJSONMock.mockResolvedValue({ title: 'Title', excerpt: 'E', body: 'B' });
    const result = await generatePageMarkdown({ prompt: 'x', slug: 'Custom Slug!' }, '');
    expect(result.frontmatter.slug).toBe('custom-slug');
  });

  it('respects an explicit title param over the model-generated one', async () => {
    ollamaChatJSONMock.mockResolvedValue({ title: 'Model Title', excerpt: 'E', body: 'B' });
    const result = await generatePageMarkdown({ prompt: 'x', title: 'My Title' }, '');
    expect(result.frontmatter.title).toBe('My Title');
    expect(result.frontmatter.slug).toBe('my-title');
  });

  it('the "post" template adds a date: today, in ISO yyyy-mm-dd form', async () => {
    ollamaChatJSONMock.mockResolvedValue({ title: 'Release Notes', excerpt: 'E', body: 'B' });
    const result = await generatePageMarkdown({ prompt: 'x', template: 'post' }, '');
    expect(result.frontmatter.template).toBe('post');
    expect(result.frontmatter.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.markdown).toMatch(/date: "\d{4}-\d{2}-\d{2}"/);
    // date must be positioned after nav and before excerpt, matching pageToMarkdown order
    const fmBlock = result.markdown.split('---\n')[1];
    const keys = fmBlock.trim().split('\n').map((line) => line.split(':')[0]);
    expect(keys.indexOf('date')).toBeGreaterThan(keys.indexOf('nav'));
    expect(keys.indexOf('date')).toBeLessThan(keys.indexOf('excerpt'));
  });

  it('falls back to a "doc" template for an unrecognized template value', async () => {
    ollamaChatJSONMock.mockResolvedValue({ title: 'T', excerpt: 'E', body: 'B' });
    const result = await generatePageMarkdown({ prompt: 'x', template: 'not-a-real-template' as never }, '');
    expect(result.frontmatter.template).toBe('doc');
  });

  it('falls back to a placeholder title/body when the model omits them', async () => {
    ollamaChatJSONMock.mockResolvedValue({});
    const result = await generatePageMarkdown({ prompt: 'x' }, '');
    expect(result.frontmatter.title).toBe('Untitled');
    expect(result.body).toContain('Untitled');
  });

  it('passes "no relevant facts" placeholder when graphContext is empty', async () => {
    ollamaChatJSONMock.mockResolvedValue({ title: 'T', excerpt: 'E', body: 'B' });
    await generatePageMarkdown({ prompt: 'obscure topic' }, '');
    const [messages] = ollamaChatJSONMock.mock.calls[0];
    expect(messages[1].content).toContain('no relevant facts found in the knowledge base');
  });
});
