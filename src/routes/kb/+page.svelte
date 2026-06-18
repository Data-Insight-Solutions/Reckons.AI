<script lang="ts">
  import {
    statements,
    sources,
    confirmedStatements,
    deleteSource,
    statementsForSource,
    addStatements
  } from '$lib/stores/kb.svelte';
  import { toTurtle, toNQuads, parseNQuads } from '$lib/rdf/serialize';
  import { merge, splitByConcept, closure } from '$lib/rdf/reasoning';
  import PredicateManager from '$lib/components/PredicateManager.svelte';
  import { v4 as uuid } from 'uuid';
  import type { Statement } from '$lib/rdf/types';
  import type { KbStoryStep } from '$lib/storage/db';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import {
    workspaceName, workspaceState, supportsWorkspace,
    pickWorkspace, reconnectWorkspace, clearWorkspace,
    syncAllKbs, lastSyncTime, syncedKbCount
  } from '$lib/stores/workspace.svelte';
  import {
    isAutoSaveSupported, hasAutoSaveFile, getAutoSaveFileName,
    pickAutoSaveFile, clearAutoSaveFile
  } from '$lib/storage/backup';
  import { ensureAuth, isSignedIn } from '$lib/integrations/google/auth';
  import { uploadTurtle, listTurtleFiles, type DriveFile } from '$lib/integrations/google/drive';
  import { KB_CALENDAR_NAME } from '$lib/integrations/google/calendar';
  import {
    getRegistry,
    getCurrentKbId,
    switchToKb,
    createKb,
    removeKbFromRegistry,
    updateKbName,
    toggleBookmark,
    kbUrl,
    type KbEntry
  } from '$lib/storage/kb-registry';
  import { buildGifPackage } from '$lib/storage/gif-package';
  import { gifOverrides } from '$lib/stores/gif-overrides.svelte';
  import { db } from '$lib/storage/db';

  // ── KB identity ────────────────────────────────────────────────────────────
  const currentKbId = getCurrentKbId();

  let kbTitleLocal = $state(settings().kbTitle ?? '');
  let kbDescLocal = $state(settings().kbDescription ?? '');
  let titleSaving = $state(false);
  let descSaving = $state(false);

  // Sync if settings change (e.g. on load)
  $effect(() => {
    const s = settings();
    if (kbTitleLocal === '' && s.kbTitle) kbTitleLocal = s.kbTitle;
    if (kbDescLocal === '' && s.kbDescription) kbDescLocal = s.kbDescription;
  });

  async function saveTitle() {
    titleSaving = true;
    await updateSettings({ kbTitle: kbTitleLocal.trim() || undefined });
    titleSaving = false;
  }

  async function saveDesc() {
    descSaving = true;
    await updateSettings({ kbDescription: kbDescLocal.trim() || undefined });
    descSaving = false;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  const nonAnalysisSources = $derived(sources().filter((s) => s.kind !== 'analysis'));

  const entityCount = $derived(
    new Set(confirmedStatements().filter((s) => s.s.kind === 'iri').map((s) => s.s.value)).size
  );

  const pendingTotal = $derived(
    statements().filter((s) => s.status === 'pending' && nonAnalysisSources.some((src) => src.id === s.sourceId)).length
  );

  // ── Per-source counts ─────────────────────────────────────────────────────
  function sourcePending(id: string): number {
    return statementsForSource(id).filter((s) => s.status === 'pending').length;
  }
  function sourceConfirmed(id: string): number {
    return statementsForSource(id).filter((s) => s.status === 'confirmed' || s.status === 'refined').length;
  }

  // ── KB registry ───────────────────────────────────────────────────────────
  let localKbs = $state<KbEntry[]>(getRegistry());
  let newKbName = $state('');
  let showNewKbForm = $state(false);
  let editingKbId = $state<string | null>(null);
  let editingName = $state('');
  let compareSelection = $state<Set<string>>(new Set());
  let kbFilter = $state<'all' | 'bookmarked'>('all');

  const sortedKbs = $derived(
    localKbs
      .filter(kb => kbFilter === 'all' || kb.bookmarked)
      .sort((a, b) => {
        // Current KB first, then bookmarked, then by name
        if (a.id === currentKbId) return -1;
        if (b.id === currentKbId) return 1;
        if (a.bookmarked && !b.bookmarked) return -1;
        if (!a.bookmarked && b.bookmarked) return 1;
        return a.name.localeCompare(b.name);
      })
  );

  const bookmarkedCount = $derived(localKbs.filter(k => k.bookmarked).length);

  function handleCreateKb() {
    const name = newKbName.trim();
    if (!name) return;
    const entry = createKb(name);
    switchToKb(entry.id); // triggers reload
  }

  function handleSwitch(id: string) {
    if (id === currentKbId) return;
    switchToKb(id);
  }

  function handleDeleteKb(id: string) {
    if (!confirm('Remove this KB from the list? Its IndexedDB data will remain but the entry will be unlinked.')) return;
    removeKbFromRegistry(id);
    localKbs = getRegistry();
  }

  function handleBookmark(id: string) {
    toggleBookmark(id);
    localKbs = getRegistry();
  }

  function startRename(kb: KbEntry) {
    editingKbId = kb.id;
    editingName = kb.name;
  }

  function commitRename() {
    if (editingKbId && editingName.trim()) {
      updateKbName(editingKbId, editingName.trim());
      localKbs = getRegistry();
    }
    editingKbId = null;
  }

  function toggleCompareSelect(id: string) {
    const next = new Set(compareSelection);
    if (next.has(id)) next.delete(id);
    else if (next.size < 2) next.add(id);
    compareSelection = next;
  }

  // ── GDrive files ───────────────────────────────────────────────────────────
  let driveFiles = $state<DriveFile[]>([]);
  let driveLoading = $state(false);
  let driveError = $state('');
  let driveLoaded = $state(false);

  async function loadDriveFiles() {
    driveLoading = true;
    driveError = '';
    try {
      await ensureAuth(settings().googleClientId ?? '');
      driveFiles = await listTurtleFiles();
      driveLoaded = true;
    } catch (e) {
      driveError = e instanceof Error ? e.message : String(e);
    } finally {
      driveLoading = false;
    }
  }

  // ── Drive export ──────────────────────────────────────────────────────────
  let driveUploading = $state(false);
  let driveUploadMsg = $state('');

  async function saveToDrive() {
    driveUploading = true;
    driveUploadMsg = '';
    try {
      await ensureAuth(settings().googleClientId ?? '');
      const content = toTurtle(confirmedStatements(), { header: 'full KB export' });
      const filename = `kb_${new Date().toISOString().split('T')[0]}.ttl`;
      await uploadTurtle(filename, content);
      driveUploadMsg = `saved to Drive: ${filename}`;
    } catch (e) {
      driveUploadMsg = e instanceof Error ? e.message : String(e);
    } finally {
      driveUploading = false;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function download(name: string, content: string, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportTurtle() {
    download(`kbase-${Date.now()}.ttl`, toTurtle(confirmedStatements(), { header: 'full KB export' }), 'text/turtle');
  }
  function exportNQuads() {
    download(`kbase-${Date.now()}.nq`, toNQuads(confirmedStatements()), 'application/n-quads');
  }
  function exportClosure() {
    download(`kbase-closure-${Date.now()}.ttl`, toTurtle(closure(confirmedStatements()), { header: 'KB + RDFS/OWL closure' }), 'text/turtle');
  }

  let exportingGifZip = $state(false);
  async function exportGifPackage() {
    exportingGifZip = true;
    try {
      const gifRows = await db.entityGifs.toArray();
      const glbRows = await db.glbOverrides.toArray();
      const zipBytes = await buildGifPackage(confirmedStatements(), gifRows, glbRows);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kb-export-${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      exportingGifZip = false;
    }
  }

  // ── Merge / split ────────────────────────────────────────────────────────
  let mergePreview = $state('');
  let mergeReport = $state('');
  let splitSeed = $state('');
  let showPredicates = $state(false);

  // ── KB Story editor ─────────────────────────────────────────────────────
  let showStoryEditor = $state(false);
  let storySteps = $state<KbStoryStep[]>(settings().kbStory ?? []);
  let storySaving = $state(false);

  $effect(() => {
    const s = settings();
    if (!showStoryEditor && s.kbStory) storySteps = s.kbStory;
  });

  function addStoryStep() {
    storySteps = [...storySteps, { title: '', content: '' }];
  }

  function removeStoryStep(idx: number) {
    storySteps = storySteps.filter((_, i) => i !== idx);
  }

  function moveStoryStep(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= storySteps.length) return;
    const next = [...storySteps];
    [next[idx], next[target]] = [next[target], next[idx]];
    storySteps = next;
  }

  async function saveStory() {
    storySaving = true;
    const clean = storySteps.filter(s => s.title.trim() || s.content.trim());
    await updateSettings({ kbStory: clean.length > 0 ? clean : undefined });
    storySaving = false;
  }

  async function importMerge() {
    if (!mergePreview.trim()) return;
    const parsed = parseNQuads(mergePreview);
    const now = Date.now();
    const incoming: Statement[] = parsed.map((q) => ({
      id: uuid(), s: q.s, p: q.p, o: q.o, g: q.g,
      sourceId: 'import', confidence: 0.9, status: 'pending',
      createdAt: now, updatedAt: now
    }));
    const report = merge(statements(), incoming);
    mergeReport = `merged: +${report.added} statements, ${report.collapsedDuplicates} duplicates collapsed, ${report.conflicts.length} conflicts surfaced.`;
    await addStatements(incoming);
  }

  function exportSplit() {
    const seeds = splitSeed.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.includes(':') ? s : `urn:kbase:concept/${s}`));
    if (seeds.length === 0) return;
    const subset = splitByConcept(confirmedStatements(), seeds);
    download(`kbase-subset-${Date.now()}.ttl`, toTurtle(subset, { header: `subset around ${seeds.join(', ')}` }), 'text/turtle');
  }

  // ── Workspace folder sync ─────────────────────────────────────────────────
  let wsSyncing = $state(false);
  let wsSyncMsg = $state('');

  async function handlePickWorkspace() {
    const ok = await pickWorkspace();
    if (ok) {
      wsSyncing = true;
      const count = await syncAllKbs();
      wsSyncMsg = `Synced ${count} KB${count !== 1 ? 's' : ''} to folder.`;
      wsSyncing = false;
      setTimeout(() => { wsSyncMsg = ''; }, 5000);
    }
  }

  async function handleSyncAllKbs() {
    wsSyncing = true;
    wsSyncMsg = '';
    const count = await syncAllKbs();
    wsSyncMsg = `Synced ${count} KB${count !== 1 ? 's' : ''} to folder.`;
    wsSyncing = false;
    setTimeout(() => { wsSyncMsg = ''; }, 5000);
  }

  const googleReady = $derived(!!settings().googleClientId);

  // ── Source filters ────────────────────────────────────────────────────────
  let filterKind = $state<string | null>(null);
  let filterSearch = $state('');
  let tripleSearchMap = $state<Record<string, string>>({});
  let expandedSources = $state<Set<string>>(new Set());

  const availableKinds = $derived([...new Set(nonAnalysisSources.map((s) => s.kind))]);

  const filteredSources = $derived(
    nonAnalysisSources
      .filter((src) => {
        if (filterKind && src.kind !== filterKind) return false;
        if (filterSearch && !src.title.toLowerCase().includes(filterSearch.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => sourceConfirmed(b.id) - sourceConfirmed(a.id))
  );

  function toggleExpanded(id: string) {
    const next = new Set(expandedSources);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedSources = next;
  }

  function getTripleSearch(id: string) { return tripleSearchMap[id] ?? ''; }
  function setTripleSearch(id: string, val: string) { tripleSearchMap = { ...tripleSearchMap, [id]: val }; }

  function filteredTriples(sourceId: string) {
    const stmts = statementsForSource(sourceId).filter(
      (s) => s.status === 'confirmed' || s.status === 'refined'
    );
    const q = getTripleSearch(sourceId).toLowerCase().trim();
    if (!q) return stmts;
    return stmts.filter(
      (s) =>
        s.s.value.toLowerCase().includes(q) ||
        s.p.value.toLowerCase().includes(q) ||
        s.o.value.toLowerCase().includes(q)
    );
  }

  function shortUri(uri: string): string {
    const hash = uri.lastIndexOf('#');
    const slash = uri.lastIndexOf('/');
    const cut = Math.max(hash, slash);
    return cut >= 0 ? uri.slice(cut + 1) : uri;
  }

  function isLongLiteral(st: { o: { kind: string; value: string } }): boolean {
    return st.o.kind === 'literal' && st.o.value.length > 100;
  }

  function kindIcon(kind: string) {
    return kind === 'text' ? '📄' : kind === 'analysis' ? '🔬' : kind === 'url' ? '🔗' : kind === 'turtle' ? '' : '📦';
  }

  function kindLabel(kind: string) {
    if (kind === 'turtle') return 'Turtle';
    if (kind === 'text') return 'Text';
    if (kind === 'url') return 'URL';
    if (kind === 'analysis') return 'Analysis';
    return kind;
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

<!-- ── KB Identity ─────────────────────────────────────────────────────────── -->
<div class="kb-identity">
  <div class="kb-id-row">
    <span class="kb-badge mono">{currentKbId}</span>
  </div>
  <div class="kb-title-row">
    <input
      class="kb-title-input"
      bind:value={kbTitleLocal}
      onblur={saveTitle}
      onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      placeholder="knowledge base title…"
      spellcheck="false"
    />
    {#if titleSaving}<span class="saving mono">saving…</span>{/if}
  </div>
  <textarea
    class="kb-desc-input"
    bind:value={kbDescLocal}
    onblur={saveDesc}
    placeholder="what is this KB about? (guides re-analysis prompts)"
    rows="2"
  ></textarea>

  <div class="kb-stats mono">
    <span class="stat">{entityCount} entities</span>
    <span class="sep">·</span>
    <span class="stat">{confirmedStatements().length} statements</span>
    <span class="sep">·</span>
    <span class="stat">{nonAnalysisSources.length} sources</span>
    {#if pendingTotal > 0}
      <span class="sep">·</span>
      <a href="/review" class="stat stat-pending">{pendingTotal} pending review →</a>
    {/if}
  </div>
</div>

<!-- ── Sources ────────────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>sources</h3>
    <a href="/ingest" class="ingest-cta mono">+ ingest new →</a>
  </div>

  {#if nonAnalysisSources.length === 0}
    <div class="empty-card">
      no sources yet. <a href="/ingest">ingest a file or URL →</a>
    </div>
  {:else}
    <!-- Filter bar -->
    <div class="filter-bar">
      <div class="filter-chips">
        <button class="chip" class:active={filterKind === null} onclick={() => (filterKind = null)}>all</button>
        {#each availableKinds as k (k)}
          <button class="chip" class:active={filterKind === k} onclick={() => (filterKind = k)}>
            {#if k === 'turtle'}<img src="/svg/head1.svg" alt="" class="kind-head" />{:else}{kindIcon(k)}{/if} {kindLabel(k)}
          </button>
        {/each}
      </div>
      <input
        class="filter-search mono"
        type="search"
        placeholder="search sources…"
        bind:value={filterSearch}
      />
    </div>

    {#if filteredSources.length === 0}
      <p class="filter-empty mono">no sources match filter.</p>
    {:else}
      <div class="src-list">
        {#each filteredSources as src (src.id)}
          {@const pending = sourcePending(src.id)}
          {@const confirmed = sourceConfirmed(src.id)}
          {@const isExpanded = expandedSources.has(src.id)}
          {@const maxConfirmed = Math.max(...filteredSources.map((s) => sourceConfirmed(s.id)), 1)}
          <div class="src-card" class:has-pending={pending > 0} class:expanded={isExpanded}>
            <div class="src-top">
              <div class="src-meta">
                <div class="src-meta-top">
                  <span class="src-kind mono">{#if src.kind === 'turtle'}<img src="/svg/head1.svg" alt="" class="kind-head" />{:else}{kindIcon(src.kind)}{/if} {kindLabel(src.kind)}</span>
                  {#if src.trustLevel}
                    <span class="trust trust-{src.trustLevel}">{src.trustLevel}</span>
                  {/if}
                  <span class="src-age mono">{relativeTime(src.ingestedAt)}</span>
                </div>
                <h4 class="src-title">{src.title}</h4>
              </div>

              <div class="src-count-block">
                <span class="count-big mono">{confirmed}</span>
                <span class="count-label mono">triples</span>
                {#if pending > 0}
                  <span class="count-pending-badge">{pending} pending</span>
                {/if}
              </div>
            </div>

            <!-- Triple count bar -->
            <div class="count-bar-track">
              <div class="count-bar-fill" style="width: {Math.round((confirmed / maxConfirmed) * 100)}%"></div>
            </div>

            <div class="src-actions">
              {#if pending > 0}
                <a href={`/review?source=${src.id}`}>
                  <button class="primary sm">review {pending}</button>
                </a>
                <a href={`/compare?source=${src.id}`}>
                  <button class="sm">compare</button>
                </a>
              {/if}
              <button class="sm" onclick={() => toggleExpanded(src.id)}>
                {isExpanded ? 'hide triples ▲' : 'view triples ▼'}
              </button>
              <button class="sm danger" onclick={() => deleteSource(src.id)}>delete</button>
            </div>

            {#if isExpanded}
              {@const stmts = filteredTriples(src.id)}
              {@const allStmts = statementsForSource(src.id).filter((s) => s.status === 'confirmed' || s.status === 'refined')}
              <div class="triple-panel">
                <div class="triple-toolbar">
                  <input
                    class="triple-search-input mono"
                    type="search"
                    placeholder="filter triples…"
                    value={getTripleSearch(src.id)}
                    oninput={(e) => setTripleSearch(src.id, (e.target as HTMLInputElement).value)}
                  />
                  <span class="triple-count-label mono">
                    {stmts.length}{stmts.length < allStmts.length ? ` / ${allStmts.length}` : ''} triples
                  </span>
                </div>

                {#if stmts.length === 0}
                  <p class="triple-empty">
                    {allStmts.length === 0 ? 'no confirmed triples yet.' : 'no triples match search.'}
                  </p>
                {:else}
                  <div class="triple-list">
                    {#each stmts.slice(0, 200) as st (st.id)}
                      {#if isLongLiteral(st)}
                        <div class="triple-block">
                          <div class="triple-block-head mono">
                            <span class="triple-s">{shortUri(st.s.value)}</span>
                            <span class="triple-p">{shortUri(st.p.value)}</span>
                          </div>
                          <p class="triple-block-text">{st.o.value}</p>
                        </div>
                      {:else}
                        <div class="triple-row mono">
                          <span class="triple-s">{shortUri(st.s.value)}</span>
                          <span class="triple-p">{shortUri(st.p.value)}</span>
                          <span class="triple-o">{st.o.value}</span>
                        </div>
                      {/if}
                    {/each}
                    {#if stmts.length > 200}
                      <p class="triple-more">{stmts.length - 200} more — refine search to narrow results</p>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<!-- ── Predicate Manager ──────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>predicates</h3>
    <button class="ghost sm mono" onclick={() => (showPredicates = !showPredicates)}>
      {showPredicates ? 'hide ▲' : 'show ▼'}
    </button>
  </div>
  {#if showPredicates}
    <PredicateManager />
  {:else}
    <p class="section-hint">view, rename, and merge predicates used in your knowledge base.</p>
  {/if}
</section>

<!-- ── KB Story ──────────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>guided story</h3>
    <button class="ghost sm mono" onclick={() => (showStoryEditor = !showStoryEditor)}>
      {showStoryEditor ? 'hide ▲' : storySteps.length > 0 ? `edit (${storySteps.length} steps)` : '+ create'}
    </button>
  </div>
  {#if showStoryEditor}
    <div class="story-editor">
      <p class="section-hint">define a guided tour for this KB. Shelly will walk visitors through these steps in the explore tab.</p>
      {#each storySteps as step, i}
        <div class="story-step-card">
          <div class="story-step-head">
            <span class="story-step-num mono">{i + 1}</span>
            <input
              class="story-step-title"
              type="text"
              bind:value={step.title}
              placeholder="step title…"
              spellcheck="false"
            />
            <div class="story-step-actions">
              <button class="ghost sm" onclick={() => moveStoryStep(i, -1)} disabled={i === 0} title="Move up">↑</button>
              <button class="ghost sm" onclick={() => moveStoryStep(i, 1)} disabled={i === storySteps.length - 1} title="Move down">↓</button>
              <button class="ghost sm danger" onclick={() => removeStoryStep(i)} title="Remove step">×</button>
            </div>
          </div>
          <textarea
            class="story-step-content"
            bind:value={step.content}
            placeholder="what Shelly says at this step… (supports **markdown**)"
            rows="3"
          ></textarea>
          <input
            class="story-step-highlights mono"
            type="text"
            value={step.highlights?.join(', ') ?? ''}
            oninput={(e) => { step.highlights = (e.currentTarget as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean); }}
            placeholder="entity IRIs to highlight (comma-separated, optional)"
            spellcheck="false"
          />
        </div>
      {/each}
      <div class="story-actions">
        <button class="ghost sm mono" onclick={addStoryStep}>+ add step</button>
        <button class="primary sm" onclick={saveStory} disabled={storySaving}>
          {storySaving ? 'saving…' : 'save story'}
        </button>
      </div>
    </div>
  {:else if storySteps.length === 0}
    <p class="section-hint">no story defined yet. create one to guide visitors through your KB.</p>
  {:else}
    <div class="story-preview">
      {#each storySteps as step, i}
        <span class="story-chip mono">{i + 1}. {step.title || '(untitled)'}</span>
      {/each}
    </div>
  {/if}
</section>

<!-- ── Knowledge Bases ────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>knowledge bases</h3>
    <div class="section-head-actions">
      <button class="ghost sm mono" onclick={() => (showNewKbForm = !showNewKbForm)}>+ new</button>
    </div>
  </div>

  <!-- Filter tabs -->
  <div class="kb-filter-tabs" role="tablist" aria-label="KB filter">
    <button
      role="tab"
      aria-selected={kbFilter === 'all'}
      class="kb-tab"
      class:active={kbFilter === 'all'}
      onclick={() => (kbFilter = 'all')}
    >all ({localKbs.length})</button>
    <button
      role="tab"
      aria-selected={kbFilter === 'bookmarked'}
      class="kb-tab"
      class:active={kbFilter === 'bookmarked'}
      onclick={() => (kbFilter = 'bookmarked')}
      disabled={bookmarkedCount === 0}
    >bookmarked ({bookmarkedCount})</button>
  </div>

  {#if showNewKbForm}
    <div class="new-kb-form">
      <input
        type="text"
        bind:value={newKbName}
        placeholder="new KB name…"
        aria-label="New knowledge base name"
        onkeydown={(e) => { if (e.key === 'Enter') handleCreateKb(); if (e.key === 'Escape') showNewKbForm = false; }}
        autofocus
      />
      <button class="primary sm" onclick={handleCreateKb} disabled={!newKbName.trim()}>create &amp; switch</button>
      <button class="sm" onclick={() => (showNewKbForm = false)}>cancel</button>
    </div>
  {/if}

  <!-- Compare toolbar (shows when 2 KBs selected) -->
  {#if compareSelection.size > 0}
    <div class="compare-toolbar">
      <span class="mono compare-label">
        {compareSelection.size}/2 selected for comparison
      </span>
      {#if compareSelection.size === 2}
        <span class="mono compare-hint">cross-KB comparison coming soon</span>
      {/if}
      <button class="sm" onclick={() => (compareSelection = new Set())}>clear</button>
    </div>
  {/if}

  <div class="kb-list">
    {#each sortedKbs as kb (kb.id)}
      {@const isCurrent = kb.id === currentKbId}
      {@const isCompareSelected = compareSelection.has(kb.id)}
      <div
        class="kb-entry"
        class:current={isCurrent}
        class:compare-selected={isCompareSelected}
      >
        <div class="kb-entry-left">
          <button
            class="bookmark-btn"
            class:bookmarked={kb.bookmarked}
            onclick={() => handleBookmark(kb.id)}
            aria-label={kb.bookmarked ? `Remove ${kb.name} from bookmarks` : `Bookmark ${kb.name}`}
            title={kb.bookmarked ? 'Remove bookmark' : 'Bookmark'}
          >
            {kb.bookmarked ? '★' : '☆'}
          </button>
          <div class="kb-entry-meta">
            {#if editingKbId === kb.id}
              <input
                class="kb-rename-input"
                bind:value={editingName}
                onblur={commitRename}
                onkeydown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { editingKbId = null; } }}
                autofocus
                aria-label="Rename knowledge base"
              />
            {:else}
              <span
                class="kb-entry-name"
                ondblclick={() => startRename(kb)}
                title="Double-click to rename"
              >{kb.name}</span>
            {/if}
            <div class="kb-entry-sub">
              <span class="kb-entry-id mono">{kb.id}</span>
              {#if kb.lastModified}
                <span class="kb-entry-date mono">{relativeTime(kb.lastModified)}</span>
              {/if}
            </div>
            {#if kb.description}
              <span class="kb-entry-desc">{kb.description}</span>
            {/if}
          </div>
        </div>
        <div class="kb-entry-actions">
          {#if isCurrent}
            <span class="current-badge mono">current</span>
          {:else}
            <button class="sm primary" onclick={() => handleSwitch(kb.id)}>switch</button>
            <a
              href={kbUrl(kb.id)}
              target="_blank"
              rel="noopener"
              class="sm-link"
              title="Open in new tab"
              aria-label="Open {kb.name} in a new browser tab"
            >tab</a>
          {/if}
          <button
            class="sm compare-toggle"
            class:active={isCompareSelected}
            onclick={() => toggleCompareSelect(kb.id)}
            disabled={!isCompareSelected && compareSelection.size >= 2}
            aria-label={isCompareSelected ? 'Deselect for comparison' : 'Select for comparison'}
            title="Select for comparison"
          >
            {isCompareSelected ? '☑' : '☐'}
          </button>
          {#if !isCurrent && kb.id !== 'kbase'}
            <button class="sm danger" onclick={() => handleDeleteKb(kb.id)}>remove</button>
          {/if}
        </div>
      </div>
    {/each}
    {#if sortedKbs.length === 0}
      <p class="filter-empty mono">no bookmarked KBs yet. star a KB to bookmark it.</p>
    {/if}
  </div>

  <!-- GDrive files -->
  <div class="drive-section">
    <div class="drive-head">
      <span class="mono" style="font-size:0.75rem; color:var(--muted);">google drive .ttl files</span>
      {#if googleReady}
        <button class="ghost sm mono" onclick={loadDriveFiles} disabled={driveLoading}>
          {driveLoading ? 'loading…' : driveLoaded ? 'refresh' : 'browse drive'}
        </button>
      {:else}
        <a href="/settings" class="hint-link mono">connect Google →</a>
      {/if}
    </div>

    {#if driveError}
      <p class="err mono">{driveError}</p>
    {/if}

    {#if driveLoaded}
      {#if driveFiles.length === 0}
        <p class="hint">no .ttl files found in Drive.</p>
      {:else}
        <div class="drive-list">
          {#each driveFiles as f (f.id)}
            <div class="drive-file">
              <div class="drive-file-meta">
                <span class="drive-file-name">{f.name}</span>
                <span class="drive-file-date mono">{new Date(f.modifiedTime).toLocaleDateString()}</span>
              </div>
              <a href="/ingest">
                <button class="sm">import →</button>
              </a>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>

<!-- ── Entity Types ────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>entity types</h3>
    <a href="/settings/entity-types" class="ghost sm mono nav-cta">manage types →</a>
  </div>
  <p class="section-hint">customize type icons, colors, geometries, and 3D models for graph nodes.</p>
</section>

<!-- ── Export ─────────────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>export</h3>
  </div>
  <p class="section-hint">turtle files transfer cleanly between any rdf-aware tool.</p>
  <div class="row" style="margin-top: 0.5rem;">
    <button onclick={exportTurtle}>turtle (.ttl)</button>
    <button onclick={exportNQuads}>n-quads (.nq)</button>
    <button onclick={exportClosure}>turtle + inferred</button>
    {#if gifOverrides().size > 0}
      <button onclick={exportGifPackage} disabled={exportingGifZip}>
        {exportingGifZip ? 'zipping…' : `zip with gifs (${gifOverrides().size})`}
      </button>
    {/if}
  </div>
  {#if googleReady}
    <div class="row" style="margin-top: 0.5rem;">
      <button onclick={saveToDrive} disabled={driveUploading}>
        {driveUploading ? 'uploading…' : '↑ save to google drive'}
      </button>
    </div>
    {#if driveUploadMsg}<p class="hint">{driveUploadMsg}</p>{/if}
  {/if}
</section>

<!-- ── Split by Concept ──────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>split by concept</h3>
  </div>
  <p class="section-hint">extract a topical subset around one or more seed concepts.</p>
  <div class="split-row">
    <input type="text" bind:value={splitSeed} placeholder="coffee-bean, morning-routine" />
    <button onclick={exportSplit}>export subset</button>
  </div>
</section>

<!-- ── Merge ──────────────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>merge from n-quads</h3>
  </div>
  <p class="section-hint">paste another KB export; conflicts surface in review.</p>
  <textarea bind:value={mergePreview} rows="4" placeholder="<urn:...> <urn:...> ... ."></textarea>
  <div class="row" style="margin-top: 0.4rem;">
    <button onclick={importMerge}>merge</button>
  </div>
  {#if mergeReport}<pre class="report mono">{mergeReport}</pre>{/if}
</section>

<!-- ── Local Folder Sync ──────────────────────────────────────────────────── -->
<section class="section" id="local-folder-sync">
  <div class="section-head">
    <h3>local folder sync</h3>
  </div>
  <p class="section-hint">link a local folder to automatically back up all KBs. your data survives browser cache clears.</p>

  <div class="files-card">
    <div class="files-row">
      <span class="files-label mono">browser storage</span>
      <span class="files-value mono">{currentKbId}</span>
    </div>

    <!-- Workspace folder -->
    <div class="files-row">
      <span class="files-label mono">sync folder</span>
      {#if workspaceState() === 'connected'}
        <span class="files-value mono files-connected">{workspaceName()}/</span>
        <button class="ghost sm" onclick={clearWorkspace}>unlink</button>
      {:else if workspaceState() === 'disconnected'}
        <span class="files-value mono files-disconnected">{workspaceName()}/ (disconnected)</span>
        <button class="sm" onclick={reconnectWorkspace}>reconnect</button>
      {:else if supportsWorkspace()}
        <button class="sm" onclick={handlePickWorkspace}>link folder</button>
      {:else}
        <span class="files-value mono files-na">not supported (Chrome/Edge only)</span>
      {/if}
    </div>

    {#if workspaceState() === 'connected'}
      <div class="files-sub">
        <div class="files-row files-indent">
          <span class="files-label mono">kbs synced</span>
          <span class="files-value mono">{syncedKbCount() > 0 ? `${syncedKbCount()} KB${syncedKbCount() !== 1 ? 's' : ''}` : 'none yet'}</span>
        </div>
        {#if lastSyncTime()}
          <div class="files-row files-indent">
            <span class="files-label mono">last sync</span>
            <span class="files-value mono">{new Date(lastSyncTime()!).toLocaleTimeString()}</span>
          </div>
        {/if}
        <div class="files-row files-indent">
          <span class="files-label mono">folder structure</span>
          <span class="files-value mono">{workspaceName()}/kbs/*/kb.ttl</span>
        </div>
        <div class="files-row" style="margin-top:0.4rem">
          <button class="sm" onclick={handleSyncAllKbs} disabled={wsSyncing}>
            {wsSyncing ? 'syncing...' : 'sync all KBs now'}
          </button>
        </div>
        {#if wsSyncMsg}
          <p class="files-msg">{wsSyncMsg}</p>
        {/if}
      </div>
    {/if}

    <!-- Auto-save file -->
    <div class="files-row">
      <span class="files-label mono">auto-save file</span>
      {#if hasAutoSaveFile()}
        <span class="files-value mono files-connected">{getAutoSaveFileName()}</span>
        <button class="ghost sm" onclick={clearAutoSaveFile}>unlink</button>
      {:else if isAutoSaveSupported()}
        <button class="sm" onclick={pickAutoSaveFile}>pick file</button>
      {:else}
        <span class="files-value mono files-na">not supported</span>
      {/if}
    </div>
  </div>
</section>

<style>
  /* ── KB Identity ── */
  .kb-identity {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.25rem 1.4rem;
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .kb-id-row { display: flex; align-items: center; gap: 0.6rem; }
  .kb-badge {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--muted); background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 4px; padding: 0.1rem 0.4rem;
  }

  .kb-title-row { display: flex; align-items: center; gap: 0.5rem; }
  .kb-title-input {
    flex: 1; font-size: 1.25rem; font-weight: 700; font-family: var(--font-display);
    background: none; border: none; outline: none; color: var(--ink);
    padding: 0; border-bottom: 1px solid transparent;
  }
  .kb-title-input:focus { border-bottom-color: var(--accent); }
  .kb-title-input::placeholder { color: var(--muted); font-weight: 400; }

  .saving { font-size: 0.65rem; color: var(--muted); }

  .kb-desc-input {
    width: 100%; resize: vertical; font-size: 0.82rem;
    background: none; border: none; outline: none; border-bottom: 1px solid transparent;
    color: var(--ink-2); font-family: inherit; line-height: 1.5;
    padding: 0; min-height: 2.5rem;
  }
  .kb-desc-input:focus { border-bottom-color: var(--line); }
  .kb-desc-input::placeholder { color: var(--muted); }

  .kb-stats {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem;
    font-size: 0.72rem; color: var(--muted);
  }
  .stat { color: var(--ink-2); }
  .stat-pending { color: var(--accent); text-decoration: none; font-weight: 600; }
  .stat-pending:hover { text-decoration: underline; }
  .sep { color: var(--muted); }

  /* ── Sections ── */
  .section { margin-bottom: 1.5rem; }

  .section-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 0.7rem;
  }
  .section-head h3 {
    font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.15em;
    color: var(--accent); margin: 0;
  }

  .ingest-cta {
    font-size: 0.7rem; color: var(--accent); text-decoration: none;
  }
  .ingest-cta:hover { text-decoration: underline; }

  .section-hint { color: var(--muted); font-size: 0.8rem; margin: 0; }

  /* ── Filter bar ── */
  .filter-bar {
    display: flex; align-items: center; gap: 0.75rem;
    margin-bottom: 0.85rem; flex-wrap: wrap;
  }
  .filter-chips { display: flex; gap: 0.35rem; flex-wrap: wrap; }
  .chip {
    font-size: 0.72rem; padding: 0.22rem 0.65rem; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface-2);
    color: var(--muted); cursor: pointer; transition: background 0.15s, color 0.15s;
    font-family: var(--font-mono);
  }
  .chip:hover { color: var(--ink-2); border-color: var(--ink-2); }
  .chip.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
  .filter-search {
    flex: 1; min-width: 140px; max-width: 260px;
    font-size: 0.75rem; padding: 0.28rem 0.6rem;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); color: var(--ink);
    outline: none;
  }
  .filter-search:focus { border-color: var(--accent); }
  .filter-empty { color: var(--muted); font-size: 0.78rem; margin: 0.4rem 0; }

  /* ── Source cards ── */
  .src-list { display: flex; flex-direction: column; gap: 0.7rem; }

  .src-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.9rem 1rem;
    display: flex; flex-direction: column; gap: 0.55rem;
    transition: border-color 0.15s;
  }
  .src-card.has-pending { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .src-card.expanded { border-color: var(--accent); }

  .src-top {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem;
  }
  .src-meta { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 0; }
  .src-meta-top {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  }
  .src-kind {
    font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--accent);
    display: inline-flex; align-items: center; gap: 0.25rem;
  }
  .kind-head {
    height: 0.85em; width: auto; vertical-align: middle;
  }
  .src-title {
    font-size: 0.95rem; margin: 0; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .src-age { font-size: 0.65rem; color: var(--muted); white-space: nowrap; margin-left: auto; }

  .src-count-block {
    display: flex; flex-direction: column; align-items: flex-end;
    gap: 0.1rem; flex-shrink: 0;
  }
  .count-big {
    font-size: 1.4rem; font-weight: 700; line-height: 1;
    color: var(--ink);
  }
  .count-label { font-size: 0.58rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
  .count-pending-badge {
    font-size: 0.58rem; font-family: var(--font-mono);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent); border-radius: 999px; padding: 0.05rem 0.4rem;
  }

  .count-bar-track {
    height: 3px; background: var(--surface-3); border-radius: 2px; overflow: hidden;
  }
  .count-bar-fill {
    height: 100%; background: var(--accent); border-radius: 2px;
    transition: width 0.3s ease;
  }

  .trust { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.1em; font-family: var(--font-mono); }
  .trust-trusted { color: var(--data); }
  .trust-review { color: var(--muted); }

  .src-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; align-items: center; }
  .src-actions a { text-decoration: none; }

  /* ── Triple panel ── */
  .triple-panel {
    border-top: 1px solid var(--line);
    padding-top: 0.6rem;
    display: flex; flex-direction: column; gap: 0.4rem;
  }
  .triple-toolbar {
    display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  }
  .triple-search-input {
    flex: 1; min-width: 120px; max-width: 260px;
    font-size: 0.72rem; padding: 0.22rem 0.5rem;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); color: var(--ink); outline: none;
  }
  .triple-search-input:focus { border-color: var(--accent); }
  .triple-count-label { font-size: 0.65rem; color: var(--muted); margin-left: auto; white-space: nowrap; }

  .triple-list {
    display: flex; flex-direction: column; gap: 0.15rem;
    max-height: 380px; overflow-y: auto;
  }
  .triple-row {
    display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr) minmax(0,2fr); gap: 0.5rem;
    font-size: 0.68rem; padding: 0.18rem 0.1rem;
    border-radius: 3px;
  }
  .triple-row:hover { background: var(--surface-2); }
  .triple-s { color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .triple-p { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .triple-o { color: var(--data); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Long literal block (descriptions, paragraphs) */
  .triple-block {
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.5rem 0.65rem;
    display: flex; flex-direction: column; gap: 0.25rem;
  }
  .triple-block-head {
    display: flex; align-items: center; gap: 0.5rem; font-size: 0.65rem;
  }
  .triple-block-text {
    font-size: 0.8rem; color: var(--ink-2); line-height: 1.55;
    margin: 0; white-space: pre-wrap; word-break: break-word;
  }

  .triple-empty { color: var(--muted); font-size: 0.75rem; margin: 0; padding: 0.3rem 0; }
  .triple-more {
    color: var(--muted); font-size: 0.68rem; margin: 0;
    text-align: center; padding: 0.4rem; font-style: italic;
  }

  /* ── KB filter tabs ── */
  .kb-filter-tabs {
    display: flex; gap: 0.25rem; margin-bottom: 0.65rem;
  }
  .kb-tab {
    font-family: var(--font-mono); font-size: 0.68rem;
    padding: 0.25rem 0.65rem; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface-2);
    color: var(--muted); cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .kb-tab:hover:not(:disabled) { color: var(--ink-2); border-color: var(--ink-2); }
  .kb-tab.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
  .kb-tab:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Compare toolbar ── */
  .compare-toolbar {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.45rem 0.7rem;
    margin-bottom: 0.5rem;
  }
  .compare-label { font-size: 0.7rem; color: var(--accent); }
  .compare-hint { font-size: 0.65rem; color: var(--muted); }

  /* ── KB list ── */
  .kb-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.75rem; }

  .kb-entry {
    display: flex; align-items: center; justify-content: space-between;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.6rem 0.85rem;
    gap: 0.5rem; transition: border-color 0.15s;
  }
  .kb-entry.current { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--surface)); }
  .kb-entry.compare-selected { border-color: var(--data); background: color-mix(in srgb, var(--data) 5%, var(--surface)); }

  .kb-entry-left { display: flex; align-items: center; gap: 0.55rem; flex: 1; min-width: 0; }

  .bookmark-btn {
    background: none; border: none; cursor: pointer;
    font-size: 1rem; line-height: 1; padding: 0.1rem;
    color: var(--muted); transition: color 0.15s;
    flex-shrink: 0;
  }
  .bookmark-btn:hover { color: var(--accent); }
  .bookmark-btn.bookmarked { color: var(--accent); }

  .kb-entry-meta { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .kb-entry-name {
    font-size: 0.85rem; font-weight: 600; cursor: default;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .kb-entry-sub { display: flex; align-items: center; gap: 0.4rem; }
  .kb-entry-id { font-size: 0.6rem; color: var(--muted); }
  .kb-entry-date { font-size: 0.58rem; color: var(--muted-2); }
  .kb-entry-desc {
    font-size: 0.7rem; color: var(--muted); margin-top: 0.15rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .kb-rename-input {
    font-size: 0.85rem; font-weight: 600; padding: 0.1rem 0.3rem;
    background: var(--surface-2); border: 1px solid var(--accent);
    border-radius: 4px; color: var(--ink); outline: none;
    width: 100%;
  }

  .kb-entry-actions { display: flex; gap: 0.3rem; align-items: center; flex-shrink: 0; }
  .current-badge {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--accent); border: 1px solid var(--accent); border-radius: 4px;
    padding: 0.1rem 0.4rem;
  }

  .sm-link {
    font-family: var(--font-mono); font-size: 0.72rem;
    padding: 0.25rem 0.5rem; border-radius: var(--rad-sm);
    background: var(--surface-2); border: 1px solid var(--line);
    color: var(--muted); text-decoration: none;
    transition: color 0.15s, border-color 0.15s;
  }
  .sm-link:hover { color: var(--accent); border-color: var(--accent); }

  .compare-toggle {
    font-size: 0.85rem; padding: 0.2rem 0.4rem;
    background: var(--surface-2); border: 1px solid var(--line);
    color: var(--muted); cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    border-radius: var(--rad-sm);
  }
  .compare-toggle:hover:not(:disabled) { color: var(--data); border-color: var(--data); }
  .compare-toggle.active { color: var(--data); border-color: var(--data); background: var(--data-soft); }
  .compare-toggle:disabled { opacity: 0.3; cursor: not-allowed; }

  .section-head-actions { display: flex; gap: 0.35rem; align-items: center; }

  .new-kb-form {
    display: flex; gap: 0.4rem; margin-bottom: 0.6rem; flex-wrap: wrap;
  }
  .new-kb-form input { flex: 1; min-width: 160px; }

  /* ── Drive section ── */
  .drive-section {
    border-top: 1px solid var(--line);
    padding-top: 0.75rem;
    margin-top: 0.5rem;
  }
  .drive-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .hint-link { font-size: 0.72rem; color: var(--accent); text-decoration: none; }
  .hint-link:hover { text-decoration: underline; }

  .drive-list { display: flex; flex-direction: column; gap: 0.35rem; }
  .drive-file {
    display: flex; align-items: center; justify-content: space-between;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.5rem 0.75rem;
  }
  .drive-file a { text-decoration: none; }
  .drive-file-meta { display: flex; flex-direction: column; gap: 0.1rem; }
  .drive-file-name { font-size: 0.82rem; }
  .drive-file-date { font-size: 0.62rem; color: var(--muted); }

  .err { color: var(--danger); font-size: 0.78rem; margin: 0; }
  .hint { color: var(--muted); font-size: 0.78rem; margin: 0.3rem 0 0; }

  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; }

  .split-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
  .split-row input { flex: 1; }

  .nav-cta {
    font-size: 0.72rem; color: var(--accent); text-decoration: none;
    padding: 0.2rem 0.5rem; border: 1px solid var(--line); border-radius: var(--rad-sm);
  }
  .nav-cta:hover { border-color: var(--accent); background: var(--accent-soft); }

  /* ── Story editor ── */
  .story-editor {
    display: flex; flex-direction: column; gap: 0.7rem;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad); padding: 1rem;
  }
  .story-step-card {
    display: flex; flex-direction: column; gap: 0.4rem;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.7rem 0.85rem;
  }
  .story-step-head {
    display: flex; align-items: center; gap: 0.5rem;
  }
  .story-step-num {
    font-size: 0.65rem; color: var(--accent); font-weight: 700;
    min-width: 1.2rem; text-align: center;
  }
  .story-step-title {
    flex: 1; font-size: 0.88rem; font-weight: 600;
    background: none; border: none; outline: none; color: var(--ink);
    padding: 0; border-bottom: 1px solid transparent;
  }
  .story-step-title:focus { border-bottom-color: var(--accent); }
  .story-step-title::placeholder { color: var(--muted); font-weight: 400; }
  .story-step-actions { display: flex; gap: 0.2rem; flex-shrink: 0; }
  .story-step-content {
    width: 100%; resize: vertical; font-size: 0.8rem;
    background: none; border: none; outline: none;
    border-bottom: 1px solid transparent;
    color: var(--ink-2); font-family: inherit; line-height: 1.5;
    padding: 0; min-height: 2.5rem;
  }
  .story-step-content:focus { border-bottom-color: var(--line); }
  .story-step-content::placeholder { color: var(--muted); }
  .story-step-highlights {
    font-size: 0.68rem; color: var(--muted);
    background: none; border: none; outline: none;
    border-bottom: 1px solid transparent; padding: 0;
  }
  .story-step-highlights:focus { border-bottom-color: var(--line); color: var(--data); }
  .story-step-highlights::placeholder { color: var(--muted); }
  .story-actions {
    display: flex; gap: 0.5rem; justify-content: space-between; align-items: center;
  }
  .story-preview {
    display: flex; flex-wrap: wrap; gap: 0.35rem;
  }
  .story-chip {
    font-size: 0.68rem; padding: 0.18rem 0.55rem; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--line); color: var(--muted);
  }

  /* ── Local files card ── */
  .files-card {
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad); padding: 0.85rem 1rem;
    display: flex; flex-direction: column; gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .files-row {
    display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  }
  .files-indent { padding-left: 1.2rem; }
  .files-sub {
    display: flex; flex-direction: column; gap: 0.35rem;
    border-left: 2px solid var(--line); margin-left: 0.5rem; padding-left: 0.5rem;
  }
  .files-label {
    font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted); min-width: 8rem; flex-shrink: 0;
  }
  .files-value { font-size: 0.72rem; color: var(--ink-2); }
  .files-connected { color: var(--data); }
  .files-disconnected { color: var(--accent); }
  .files-na { color: var(--muted); font-style: italic; }
  .files-msg { font-size: 0.72rem; color: var(--accent); margin: 0; padding-left: 1.2rem; }

  .empty-card {
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad);
    padding: 2rem 1rem; text-align: center; color: var(--muted); font-size: 0.85rem;
  }
  .empty-card a { color: var(--accent); }

  .report {
    padding: 0.6rem; background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad-sm); color: var(--data); font-size: 0.75rem;
    white-space: pre-wrap; margin: 0;
  }

  button.sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }
  button.ghost.sm { padding: 0.2rem 0.5rem; font-size: 0.72rem; }

  /* ── Mobile ── */
  @media (max-width: 500px) {
    .new-kb-form { flex-direction: column; }
    .new-kb-form input { min-width: 0; }
    .section-head-actions { flex-wrap: wrap; }
  }
</style>
