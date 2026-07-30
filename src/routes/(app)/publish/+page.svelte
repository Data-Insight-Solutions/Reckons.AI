<script lang="ts">
  /**
   * Blog authoring (F27) — the front door to the publishing pipeline.
   *
   * `src/lib/publish/` could render a site, zip it and push it to GitHub, and NOTHING in the app
   * called any of it. A user could read pages the build generated and could not author one. This
   * page is the missing entry point, and it is deliberately graph-first: writing here creates a
   * `ktype:WebPage` node in the graph, and the markdown is a rendering of that node — the same
   * direction `content/` already assumes (generated, never hand-edited).
   *
   * HONEST BOUNDARY, stated in the UI as well as here: saving a post does NOT put it on the live
   * site. `/docs` globs markdown at BUILD time (mdsvex compiles each `.md` into a Svelte
   * component), so an authored post reaches the site only once its exported file is committed and
   * the site is rebuilt. The preview below renders from the graph and says so; calling it
   * "published" would be the overclaim kb:honest-status exists to prevent.
   */
  import { statements, addStatements, setStatus } from '$lib/stores/kb.svelte';
  import {
    buildPostStatements, validatePostDraft, takenSlugs, todayIso,
    type PostDraft,
  } from '$lib/publish/post-authoring';
  import { buildSitePages, sitePosts, type SitePage } from '$lib/rdf/page';
  import { contentPath, pageToMarkdown } from '$lib/publish/site-export';
  import {
    supportsWorkspace, workspaceState, writeToWorkspace, pickWorkspace,
  } from '$lib/stores/workspace.svelte';

  const SECTION_DEFAULT = 'Blog';

  let title = $state('');
  let slug = $state('');
  let section = $state(SECTION_DEFAULT);
  let date = $state(todayIso());
  let excerpt = $state('');
  let body = $state('');
  let status = $state<'draft' | 'published'>('draft');

  let saving = $state(false);
  let saved = $state('');
  let exported = $state('');
  let failure = $state('');
  /** Set once saved, so a second save EDITS the post instead of minting a duplicate. */
  let editingIri = $state<string | null>(null);

  const draft = $derived<PostDraft>({ title, slug, section, date, excerpt, body, status });

  /** Every post already in this graph — the collision set, and the list rendered below. */
  const existingPosts = $derived.by<SitePage[]>(() => sitePosts(buildSitePages(statements())));

  const validation = $derived(
    validatePostDraft(draft, takenSlugs(buildSitePages(statements()), editingIri ?? undefined)),
  );

  /**
   * The exact markdown that would be written. Built from a page object assembled the same way
   * `buildSitePages` would assemble it, so the preview is the artifact rather than a mock-up of
   * it — a preview that renders differently from the export is worse than no preview.
   */
  const previewPage = $derived.by<SitePage | null>(() => {
    if (!validation.ok) return null;
    const { statements: sts } = buildPostStatements(draft, {
      iri: editingIri ?? undefined,
      // Collisions are already reported by `validation`; re-checking here would throw on the
      // post being edited.
      existingSlugs: new Set(),
    });
    return buildSitePages(sts)[0] ?? null;
  });

  const previewMarkdown = $derived(
    previewPage ? pageToMarkdown(previewPage, new Map([[previewPage.iri, previewPage.slug]])) : '',
  );
  const previewPath = $derived(previewPage ? contentPath(previewPage) : '');

  async function savePost() {
    if (!validation.ok || saving) return;
    saving = true;
    failure = '';
    saved = '';
    exported = '';
    try {
      const built = buildPostStatements(draft, {
        iri: editingIri ?? undefined,
        existingSlugs: takenSlugs(buildSitePages(statements()), editingIri ?? undefined),
      });

      // EDIT = SUPERSEDE, not append. `buildSitePages` keeps the LAST value it sees for each
      // single-valued predicate, so leaving the previous title/body/date facts `confirmed` makes
      // which one wins depend on array order — the post would look correct now and could revert
      // to its old title after a TTL export/import or any change in Dexie's read order. Marking
      // them superseded is what `isActive` already filters on, so the old text stays in the graph
      // as history without competing to be the answer. Found by probing the graph after an edit;
      // the DOM looked right.
      if (editingIri) {
        const stale = statements().filter((s) => s.s.kind === 'iri' && s.s.value === editingIri);
        for (const s of stale) await setStatus(s.id, 'superseded');
      }

      await addStatements(built.statements, 'authored', { origin: 'manual' });
      editingIri = built.iri;
      saved = `Saved to the graph as ${built.statements.length} facts.`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /**
   * Write the markdown where the build expects it. With a workspace connected this lands in the
   * real checkout; without one it downloads, because a file in the Downloads folder the user must
   * move by hand is still an honest handoff — silently doing nothing is not.
   */
  async function exportMarkdown() {
    if (!previewPage) return;
    failure = '';
    const path = contentPath(previewPage);
    try {
      if (workspaceState() === 'connected') {
        await writeToWorkspace(path, previewMarkdown);
        exported = `Wrote ${path} into the connected workspace. Commit it and rebuild to publish.`;
      } else {
        const blob = new Blob([previewMarkdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${previewPage.slug}.md`;
        a.click();
        URL.revokeObjectURL(url);
        exported = `Downloaded ${previewPage.slug}.md — it belongs at ${path}.`;
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }

  function loadForEdit(page: SitePage) {
    title = page.title;
    slug = page.slug;
    section = page.section;
    date = page.date ?? todayIso();
    excerpt = page.excerpt;
    body = page.body;
    status = page.status === 'published' ? 'published' : 'draft';
    editingIri = page.iri;
    saved = '';
    exported = '';
    failure = '';
  }

  function newPost() {
    title = ''; slug = ''; section = SECTION_DEFAULT; date = todayIso();
    excerpt = ''; body = ''; status = 'draft'; editingIri = null;
    saved = ''; exported = ''; failure = '';
  }

  const problemFor = (field: keyof PostDraft) =>
    validation.problems.find((p) => p.field === field)?.message ?? '';
</script>

<svelte:head><title>Write a post · Reckons.AI</title></svelte:head>

<div class="publish-page">
  <header class="publish-head">
    <h1>Write a post</h1>
    <p class="lede">
      A post is a node in your graph, not a file. Saving writes it to the graph; exporting renders
      it to the markdown the site is built from.
    </p>
    <!-- The boundary, said where the user is standing rather than in a footnote. -->
    <p class="boundary" data-testid="publish-boundary">
      Saving does not put this on the live site. Pages are compiled at build time, so an exported
      post appears only after its file is committed and the site is rebuilt.
    </p>
  </header>

  <div class="publish-grid">
    <section class="editor" aria-label="Post editor">
      <label class="field">
        <span>Title</span>
        <input type="text" bind:value={title} data-testid="post-title" placeholder="Shipping the archive sweep" />
        {#if problemFor('title')}<em class="problem">{problemFor('title')}</em>{/if}
      </label>

      <div class="field-row">
        <label class="field">
          <span>Section</span>
          <input type="text" bind:value={section} data-testid="post-section" />
          {#if problemFor('section')}<em class="problem">{problemFor('section')}</em>{/if}
        </label>
        <label class="field">
          <span>Date</span>
          <input type="date" bind:value={date} data-testid="post-date" />
          {#if problemFor('date')}<em class="problem">{problemFor('date')}</em>{/if}
        </label>
      </div>

      <label class="field">
        <span>Slug <em class="hint">— blank derives it from the title</em></span>
        <input type="text" bind:value={slug} data-testid="post-slug" placeholder={validation.resolvedSlug} />
        {#if problemFor('slug')}<em class="problem">{problemFor('slug')}</em>{/if}
      </label>

      <label class="field">
        <span>Excerpt <em class="hint">— optional</em></span>
        <input type="text" bind:value={excerpt} data-testid="post-excerpt" />
      </label>

      <label class="field">
        <span>Body <em class="hint">— markdown</em></span>
        <textarea bind:value={body} rows="12" data-testid="post-body"></textarea>
        {#if problemFor('body')}<em class="problem">{problemFor('body')}</em>{/if}
      </label>

      <label class="field">
        <span>Status</span>
        <select bind:value={status} data-testid="post-status">
          <option value="draft">draft — not exported to the public site</option>
          <option value="published">published</option>
        </select>
      </label>

      <div class="actions">
        <button
          class="primary"
          disabled={!validation.ok || saving}
          onclick={savePost}
          data-testid="post-save"
        >
          {saving ? 'saving…' : editingIri ? 'update post' : 'save to graph'}
        </button>
        <button disabled={!previewPage} onclick={exportMarkdown} data-testid="post-export">
          export markdown
        </button>
        {#if editingIri}
          <button class="ghost" onclick={newPost} data-testid="post-new">new post</button>
        {/if}
      </div>

      {#if saved}<p class="ok mono" data-testid="post-saved">{saved}</p>{/if}
      {#if exported}<p class="ok mono" data-testid="post-exported">{exported}</p>{/if}
      {#if failure}<p class="err mono" data-testid="post-error">{failure}</p>{/if}

      {#if !validation.ok}
        <!-- All objections at once. A form that reveals them one at a time gets filled in wrong
             four times. -->
        <ul class="problems" data-testid="post-problems">
          {#each validation.problems as p (p.field)}<li>{p.message}</li>{/each}
        </ul>
      {/if}

      {#if supportsWorkspace() && workspaceState() !== 'connected'}
        <p class="hint-row">
          <button class="ghost sm" onclick={pickWorkspace}>connect a workspace</button>
          to write straight into your checkout instead of downloading.
        </p>
      {/if}
    </section>

    <section class="preview" aria-label="Export preview">
      <h2 class="mono">preview</h2>
      {#if previewPage}
        <p class="preview-path mono" data-testid="preview-path">{previewPath}</p>
        <!-- The artifact itself, not a mock-up of it: a preview that renders differently from the
             export is worse than no preview. -->
        <pre class="preview-md" data-testid="preview-markdown">{previewMarkdown}</pre>
      {:else}
        <p class="muted" data-testid="preview-empty">Fill in the post to see the file it produces.</p>
      {/if}
    </section>
  </div>

  <section class="post-list" aria-label="Posts in this graph">
    <h2 class="mono">posts in this graph ({existingPosts.length})</h2>
    {#if existingPosts.length === 0}
      <p class="muted" data-testid="posts-empty">No posts yet.</p>
    {:else}
      <ul data-testid="posts-list">
        {#each existingPosts as post (post.iri)}
          <li class="post-row">
            <button class="post-open" onclick={() => loadForEdit(post)}>{post.title}</button>
            <span class="mono muted">{post.date ?? '—'}</span>
            <span class="mono status-chip" class:published={post.status === 'published'}>
              {post.status}
            </span>
            <span class="mono muted">{contentPath(post)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .publish-page { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1rem 6rem; }
  .publish-head h1 { font-family: var(--font-display); margin: 0 0 0.35rem; }
  .lede { color: var(--muted); margin: 0 0 0.5rem; max-width: 62ch; }
  .boundary {
    margin: 0 0 1.25rem; max-width: 62ch;
    font-size: 0.78rem; color: var(--muted);
    border-left: 2px solid color-mix(in srgb, var(--danger) 50%, transparent);
    padding-left: 0.7rem;
  }

  .publish-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.25rem; }
  @media (max-width: 900px) { .publish-grid { grid-template-columns: minmax(0, 1fr); } }

  .editor { display: flex; flex-direction: column; gap: 0.8rem; min-width: 0; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .field > span {
    font-family: var(--font-mono); font-size: 0.68rem;
    text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent);
  }
  /* NOTE: every input above carries an explicit type="text". global.css styles fields via
     `input[type='text'], input[type='url'], …` — an ATTRIBUTE selector, which does not match an
     input whose type is merely the HTML default. Without it these rendered with the browser's
     white default fill inside a dark app, with near-invisible placeholder text. Caught by
     looking at the first screenshot; no assertion in either suite noticed. */
  .field input, .field textarea, .field select { min-height: 44px; width: 100%; }
  .field textarea { min-height: 12rem; font-family: var(--font-mono); font-size: 0.8rem; }
  .field-row { display: flex; gap: 0.8rem; }
  .field-row .field { flex: 1; min-width: 0; }
  .hint { font-style: normal; text-transform: none; letter-spacing: 0; color: var(--muted); }
  .problem { font-style: normal; font-size: 0.7rem; color: var(--danger); }

  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .actions button { min-height: 44px; }

  .problems { margin: 0; padding-left: 1.1rem; font-size: 0.72rem; color: var(--danger); }
  .hint-row { font-size: 0.72rem; color: var(--muted); display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
  .ok { font-size: 0.72rem; color: var(--accent); margin: 0; }
  .err { font-size: 0.72rem; color: var(--danger); margin: 0; }

  .preview { min-width: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .preview h2, .post-list h2 {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--accent); margin: 0;
  }
  .preview-path { font-size: 0.7rem; color: var(--muted); }
  .preview-md {
    margin: 0; padding: 0.8rem;
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    border: 1px solid var(--line); border-radius: var(--rad-sm);
    font-family: var(--font-mono); font-size: 0.72rem; line-height: 1.5;
    /* Wide content scrolls inside its own box; the page must never scroll sideways. */
    overflow-x: auto; white-space: pre; max-height: 32rem;
  }

  .post-list { margin-top: 2rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .post-list ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .post-row {
    display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--line); border-radius: var(--rad-sm);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
  }
  .post-open {
    background: none; border: none; padding: 0; min-height: 44px;
    color: var(--fg); cursor: pointer; text-align: left; flex: 1; min-width: 8rem;
  }
  .post-open:hover { color: var(--accent); }
  .status-chip {
    font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); border: 1px solid var(--line);
    border-radius: 3px; padding: 0.1rem 0.3rem;
  }
  .status-chip.published { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .muted { color: var(--muted); font-size: 0.75rem; }
</style>
