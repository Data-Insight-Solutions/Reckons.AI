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
  import GraphPackagePanel from '$lib/components/GraphPackagePanel.svelte';
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
    kbFileSlug,
    type KbEntry
  } from '$lib/storage/kb-registry';
  import { buildGifPackage } from '$lib/storage/gif-package';
  import { gifOverrides } from '$lib/stores/gif-overrides.svelte';
  import { db } from '$lib/storage/db';
  import { readCurrentsSettings, type CurrentsSettings, type CurrentDef } from '$lib/rdf/currents';
  import { replaceCurrentsSettings } from '$lib/rdf/currents-persist';
  import { podViewEnabled, setPodViewEnabled } from '$lib/stores/pod-view.svelte';
  import { allTypes } from '$lib/stores/entity-types.svelte';
  import GraphPreview from '$lib/components/GraphPreview.svelte';

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

  // ── Analyze guidance ───────────────────────────────────────────────────────
  let guidanceLocal = $state(settings().analyzeGuidance ?? '');
  let guidanceSaving = $state(false);
  let showPromptEditor = $state(false);

  $effect(() => {
    const s = settings();
    if (guidanceLocal === '' && s.analyzeGuidance) guidanceLocal = s.analyzeGuidance;
  });

  async function saveGuidance() {
    guidanceSaving = true;
    await updateSettings({ analyzeGuidance: guidanceLocal.trim() || undefined });
    guidanceSaving = false;
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
  /** Free-text filter across name, description and id. */
  let kbQuery = $state('');
  /** How to order the gallery. Recency is the default because it is the question you
   *  actually have when you open this page: "where was I?" — not "what is alphabetically
   *  first". A graph you touched an hour ago matters more than one named 'aardvark'. */
  let kbSort = $state<'recent' | 'name' | 'size'>('recent');

  const matchesQuery = (kb: KbEntry, q: string) => {
    if (!q.trim()) return true;
    const needle = q.trim().toLowerCase();
    return (
      kb.name.toLowerCase().includes(needle) ||
      (kb.description ?? '').toLowerCase().includes(needle) ||
      kb.id.toLowerCase().includes(needle)
    );
  };

  const sortedKbs = $derived(
    localKbs
      .filter(kb => kbFilter === 'all' || kb.bookmarked)
      .filter(kb => matchesQuery(kb, kbQuery))
      .sort((a, b) => {
        // The graph you are IN always comes first — it is the one you are looking at.
        if (a.id === currentKbId) return -1;
        if (b.id === currentKbId) return 1;
        if (a.bookmarked && !b.bookmarked) return -1;
        if (!a.bookmarked && b.bookmarked) return 1;
        if (kbSort === 'name') return a.name.localeCompare(b.name);
        if (kbSort === 'size') return (b.statementCount ?? 0) - (a.statementCount ?? 0);
        // recent: a graph with no lastModified has never been written to — it sorts last,
        // rather than pretending to be from 1970 and jumping to the top.
        return (b.lastModified ?? 0) - (a.lastModified ?? 0);
      })
  );

  const bookmarkedCount = $derived(localKbs.filter(k => k.bookmarked).length);
  const hiddenByQuery = $derived(
    localKbs.filter(kb => (kbFilter === 'all' || kb.bookmarked) && !matchesQuery(kb, kbQuery)).length
  );

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
    if (!confirm('Remove this graph from the list? Its IndexedDB data will remain but the entry will be unlinked.')) return;
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
      const content = toTurtle(confirmedStatements(), { header: 'full graph export' });
      const filename = `${kbFileSlug()}_${new Date().toISOString().split('T')[0]}.ttl`;
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
    download(`${kbFileSlug()}.ttl`, toTurtle(confirmedStatements(), { header: 'full graph export' }), 'text/turtle');
  }
  function exportNQuads() {
    download(`${kbFileSlug()}.nq`, toNQuads(confirmedStatements()), 'application/n-quads');
  }
  function exportClosure() {
    download(`${kbFileSlug()}-closure.ttl`, toTurtle(closure(confirmedStatements()), { header: 'graph + RDFS/OWL closure' }), 'text/turtle');
  }

  let exportingGifZip = $state(false);
  async function exportGifPackage() {
    exportingGifZip = true;
    try {
      const gifRows = await db.entityGifs.toArray();
      const glbRows = await db.glbOverrides.toArray();
      const zipBytes = await buildGifPackage(confirmedStatements(), gifRows, glbRows);
      const blob = new Blob([zipBytes as BlobPart], { type: 'application/zip' });
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

  // ── Currents (F29.3) — graph-level streams + type gate ───────────────────
  let showCurrents = $state(false);
  let podView = $state(podViewEnabled());
  let currentsDraft = $state<CurrentsSettings>(readCurrentsSettings(statements()));
  let currentsSaving = $state(false);

  // Re-hydrate from the graph whenever it changes, but only while the editor is
  // closed (mirrors the guided-story pattern) so live edits aren't clobbered.
  $effect(() => {
    const stmts = statements();
    if (!showCurrents) currentsDraft = readCurrentsSettings(stmts);
  });

  function currentsSlugify(label: string): string {
    return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'current';
  }

  function currentsUniqueSlug(base: string, exceptIndex: number): string {
    const taken = new Set(currentsDraft.currents.filter((_, i) => i !== exceptIndex).map((c) => c.slug));
    let slug = base;
    let n = 2;
    while (taken.has(slug)) { slug = `${base}-${n}`; n++; }
    return slug;
  }

  function toggleAllowedType(iri: string) {
    const set = new Set(currentsDraft.allowedTypes);
    if (set.has(iri)) set.delete(iri); else set.add(iri);
    currentsDraft = { ...currentsDraft, allowedTypes: [...set] };
  }

  function addCurrent() {
    const label = 'new current';
    const next: CurrentDef = {
      slug: currentsUniqueSlug(currentsSlugify(label), -1),
      sourceUrl: '',
      kind: 'rss',
      label,
      cadenceMinutes: 360,
      enabled: true
    };
    currentsDraft = { ...currentsDraft, currents: [...currentsDraft.currents, next] };
  }

  function removeCurrent(idx: number) {
    currentsDraft = { ...currentsDraft, currents: currentsDraft.currents.filter((_, i) => i !== idx) };
  }

  function updateCurrent(idx: number, patch: Partial<CurrentDef>) {
    const next = [...currentsDraft.currents];
    const merged = { ...next[idx], ...patch };
    // Slug auto-follows the label unless the user is mid-editing an empty label.
    if (patch.label !== undefined) merged.slug = currentsUniqueSlug(currentsSlugify(patch.label), idx);
    next[idx] = merged;
    currentsDraft = { ...currentsDraft, currents: next };
  }

  async function saveCurrents() {
    currentsSaving = true;
    try {
      const next: CurrentsSettings = {
        allowedTypes: currentsDraft.allowedTypes,
        location: currentsDraft.location?.trim() || undefined,
        currents: currentsDraft.currents.filter((c) => c.sourceUrl.trim() && c.slug.trim())
      };
      await replaceCurrentsSettings(next);
      currentsDraft = readCurrentsSettings(statements());
    } finally {
      currentsSaving = false;
    }
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
    mergeReport = `merged: +${report.added} facts, ${report.collapsedDuplicates} duplicates collapsed, ${report.conflicts.length} conflicts surfaced.`;
    await addStatements(incoming);
  }

  function exportSplit() {
    const seeds = splitSeed.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.includes(':') ? s : `urn:kbase:concept/${s}`));
    if (seeds.length === 0) return;
    const subset = splitByConcept(confirmedStatements(), seeds);
    download(`${kbFileSlug()}-subset.ttl`, toTurtle(subset, { header: `subset around ${seeds.join(', ')}` }), 'text/turtle');
  }

  // ── Workspace folder sync ─────────────────────────────────────────────────
  let wsSyncing = $state(false);
  let wsSyncMsg = $state('');

  async function handlePickWorkspace() {
    const ok = await pickWorkspace();
    if (ok) {
      wsSyncing = true;
      const count = await syncAllKbs();
      wsSyncMsg = `Synced ${count} graph${count !== 1 ? 's' : ''} to folder.`;
      wsSyncing = false;
      setTimeout(() => { wsSyncMsg = ''; }, 5000);
    }
  }

  async function handleSyncAllKbs() {
    wsSyncing = true;
    wsSyncMsg = '';
    const count = await syncAllKbs();
    wsSyncMsg = `Synced ${count} graph${count !== 1 ? 's' : ''} to folder.`;
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

  // ── Source refresh ──────────────────────────────────────────────────────
  let refreshing = $state(false);
  let refreshProgress = $state('');

  async function refreshAllSources() {
    refreshing = true;
    refreshProgress = 'checking sources…';
    try {
      const { refreshAllSources: doRefresh, refreshableSources } = await import('$lib/stores/source-refresh');
      const count = refreshableSources().length;
      if (count === 0) { refreshProgress = 'no refreshable sources'; return; }
      const results = await doRefresh((p) => {
        refreshProgress = `refreshing ${p.current + 1}/${p.total}: ${p.currentTitle}`;
      });
      const refreshed = results.filter(r => r.status === 'refreshed').length;
      const errors = results.filter(r => r.status === 'error').length;
      refreshProgress = refreshed > 0
        ? `${refreshed} refreshed${errors > 0 ? `, ${errors} errors` : ''}`
        : errors > 0 ? `${errors} error(s)` : 'all sources up to date';
    } catch (e) {
      refreshProgress = e instanceof Error ? e.message : String(e);
    } finally {
      refreshing = false;
    }
  }

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
    return kind === 'text' ? '📄' : kind === 'analysis' ? '🔬' : kind === 'url' ? '🔗' : kind === 'repository' ? '📂' : kind === 'turtle' ? '' : '📦';
  }

  function kindLabel(kind: string) {
    if (kind === 'turtle') return 'Turtle';
    if (kind === 'text') return 'Text';
    if (kind === 'url') return 'URL';
    if (kind === 'analysis') return 'Analysis';
    if (kind === 'repository') return 'Repo';
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
      placeholder="graph title…"
      spellcheck="false"
    />
    {#if titleSaving}<span class="saving mono">saving…</span>{/if}
  </div>
  <textarea
    class="kb-desc-input"
    bind:value={kbDescLocal}
    onblur={saveDesc}
    placeholder="what is this graph about? (guides re-analysis prompts)"
    rows="2"
  ></textarea>

  <div class="kb-stats mono">
    <span class="stat">{entityCount} entities</span>
    <span class="sep">·</span>
    <span class="stat">{confirmedStatements().length} facts</span>
    <span class="sep">·</span>
    <span class="stat">{nonAnalysisSources.length} sources</span>
    {#if pendingTotal > 0}
      <span class="sep">·</span>
      <a href="/review" class="stat stat-pending">{pendingTotal} pending review →</a>
    {/if}
  </div>
  <textarea
    class="kb-guidance-input"
    bind:value={guidanceLocal}
    onblur={saveGuidance}
    placeholder="analyze guidance — shared context for enrich, types, prune, and align operations"
    rows="2"
  ></textarea>
  {#if guidanceSaving}<span class="saving mono" style="font-size:0.7rem">saving…</span>{/if}
</div>

<section class="section">
  <div class="section-head">
    <h3>other graphs</h3>
    <div class="section-head-actions">
      <button class="ghost sm mono" onclick={() => (showNewKbForm = !showNewKbForm)}>+ new</button>
    </div>
  </div>
  <p class="section-hint">switch to another graph, compare two, or start a new one. The section above edits the one you are in now.</p>

  <!-- Filter tabs -->
  <div class="kb-filter-tabs" role="tablist" aria-label="Graph filter">
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

  <!-- Search + sort. The question you have when you open this page is "where was I?", so the
       default order is RECENCY, not the alphabet. -->
  <div class="kb-gallery-controls">
    <input
      type="search"
      class="kb-search mono"
      bind:value={kbQuery}
      placeholder="filter graphs…"
      aria-label="Filter graphs by name, description or id"
    />
    <div class="kb-sort" role="group" aria-label="Sort graphs">
      <button class="kb-sort-btn mono" class:active={kbSort === 'recent'} onclick={() => (kbSort = 'recent')}
        title="Most recently edited first">recent</button>
      <button class="kb-sort-btn mono" class:active={kbSort === 'size'} onclick={() => (kbSort = 'size')}
        title="Largest graph first">size</button>
      <button class="kb-sort-btn mono" class:active={kbSort === 'name'} onclick={() => (kbSort = 'name')}
        title="Alphabetical">name</button>
    </div>
  </div>
  {#if kbQuery.trim() && hiddenByQuery > 0}
    <p class="kb-hidden-note mono">{hiddenByQuery} hidden by filter</p>
  {/if}

  {#if showNewKbForm}
    <div class="new-kb-form">
      <input
        type="text"
        bind:value={newKbName}
        placeholder="new graph name…"
        aria-label="New graph name"
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
        <a
          href="/review?align={[...compareSelection].join(',')}"
          class="sm compare-link"
        >
          align these graphs
        </a>
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
          <!-- Lazy fingerprint: loads only when the card is on screen AND the browser is idle,
               so the gallery paints first and previews trickle in behind it. -->
          <GraphPreview kbId={kb.id} width={72} height={48} />
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
                aria-label="Rename graph"
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
              <!-- Size, and the honest absence of it. A graph with no count has never been
                   written to; saying "empty" is a claim we cannot support, so it says
                   "not opened yet" instead. -->
              {#if kb.statementCount != null}
                <span class="kb-entry-size mono" title="{kb.statementCount} confirmed statements">
                  {kb.statementCount.toLocaleString()} facts
                </span>
              {:else}
                <span class="kb-entry-size mono muted-size" title="No statement count recorded — this graph has not been opened or saved yet">
                  not opened yet
                </span>
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
      <p class="filter-empty mono">no bookmarked graphs yet. star a graph to bookmark it.</p>
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

<!-- ── Sources ────────────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>sources</h3>
    <div class="section-actions">
      <button class="refresh-btn mono" onclick={refreshAllSources} disabled={refreshing}>
        {refreshing ? refreshProgress : '↻ refresh'}
      </button>
      <a href="/ingest" class="ingest-cta mono">+ ingest new →</a>
    </div>
  </div>
  {#if refreshProgress && !refreshing}
    <p class="refresh-status mono">{refreshProgress}</p>
  {/if}

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
                <span class="count-label mono">facts</span>
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
                {isExpanded ? 'hide facts ▲' : 'view facts ▼'}
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
                    placeholder="filter facts…"
                    value={getTripleSearch(src.id)}
                    oninput={(e) => setTripleSearch(src.id, (e.target as HTMLInputElement).value)}
                  />
                  <span class="triple-count-label mono">
                    {stmts.length}{stmts.length < allStmts.length ? ` / ${allStmts.length}` : ''} facts
                  </span>
                </div>

                {#if stmts.length === 0}
                  <p class="triple-empty">
                    {allStmts.length === 0 ? 'no confirmed facts yet.' : 'no facts match search.'}
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
    <p class="section-hint">view, rename, and merge predicates used in your graph.</p>
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
      <p class="section-hint">define a guided tour for this graph. Shelly will walk visitors through these steps in the explore tab.</p>
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
    <p class="section-hint">no story defined yet. create one to guide visitors through your graph.</p>
  {:else}
    <div class="story-preview">
      {#each storySteps as step, i}
        <span class="story-chip mono">{i + 1}. {step.title || '(untitled)'}</span>
      {/each}
    </div>
  {/if}
</section>

<!-- ── Currents ───────────────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-head">
    <h3>currents</h3>
    <button class="ghost sm mono" onclick={() => (showCurrents = !showCurrents)}>
      {showCurrents ? 'hide ▲' : currentsDraft.currents.length > 0 ? `edit (${currentsDraft.currents.length})` : '+ configure'}
    </button>
  </div>
  {#if showCurrents}
    <div class="currents-editor">
      <p class="section-hint">recurring streams (rss / url / topic) that bring new arrivals into this graph. arrivals always land as pending facts — review them in the pod view.</p>

      <div class="currents-field">
        <label class="pod-toggle-row" for="pod-view-toggle">
          <input
            id="pod-view-toggle"
            type="checkbox"
            checked={podView}
            onchange={(e) => { podView = (e.currentTarget as HTMLInputElement).checked; setPodViewEnabled(podView); }}
          />
          <span class="currents-label mono">🐋 pod view on the graph</span>
        </label>
        <p class="section-hint" style="margin: 0.2rem 0 0;">when on, pending arrivals drift in translucent on the graph view, with accept / dismiss on each node.</p>
      </div>

      <div class="currents-field">
        <label class="currents-label mono" for="currents-location">location</label>
        <input
          id="currents-location"
          type="text"
          value={currentsDraft.location ?? ''}
          oninput={(e) => (currentsDraft = { ...currentsDraft, location: (e.currentTarget as HTMLInputElement).value })}
          placeholder="e.g. Colorado, US — optional, used for context blocks"
        />
      </div>

      <div class="currents-field">
        <span class="currents-label mono">entity types a current may create</span>
        <p class="section-hint" style="margin: 0 0 0.4rem;">empty = every type allowed. gate applies only to brand-new entities; facts on entities already in the graph always flow through.</p>
        <div class="chip-row">
          {#each allTypes() as t (t.iri)}
            <button
              type="button"
              class="chip"
              class:active={currentsDraft.allowedTypes.includes(t.iri)}
              onclick={() => toggleAllowedType(t.iri)}
            >{t.label}</button>
          {/each}
        </div>
      </div>

      <div class="currents-list">
        {#each currentsDraft.currents as cur, i (i)}
          <div class="current-card">
            <div class="current-card-row">
              <input
                class="current-label"
                type="text"
                value={cur.label}
                oninput={(e) => updateCurrent(i, { label: (e.currentTarget as HTMLInputElement).value })}
                placeholder="label"
              />
              <select
                class="current-kind mono"
                value={cur.kind}
                onchange={(e) => updateCurrent(i, { kind: (e.currentTarget as HTMLSelectElement).value as CurrentDef['kind'] })}
              >
                <option value="rss">rss</option>
                <option value="url">url</option>
                <option value="topic">topic</option>
              </select>
              <button
                type="button"
                class="chip enabled-chip"
                class:active={cur.enabled}
                onclick={() => updateCurrent(i, { enabled: !cur.enabled })}
              >{cur.enabled ? 'enabled' : 'disabled'}</button>
              <button type="button" class="ghost sm danger" onclick={() => removeCurrent(i)}>remove</button>
            </div>
            <input
              class="current-source mono"
              type="text"
              value={cur.sourceUrl}
              oninput={(e) => updateCurrent(i, { sourceUrl: (e.currentTarget as HTMLInputElement).value })}
              placeholder={cur.kind === 'topic' ? 'topic query' : 'source url'}
              spellcheck="false"
            />
            <div class="current-card-row">
              <label class="currents-label mono" for={`current-cadence-${i}`}>cadence</label>
              <input
                id={`current-cadence-${i}`}
                class="current-cadence"
                type="number"
                min="5"
                value={cur.cadenceMinutes}
                oninput={(e) => updateCurrent(i, { cadenceMinutes: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0 })}
              />
              <span class="currents-label mono">min</span>
              <span class="currents-slug mono">urn:reckons:currents/{cur.slug}</span>
            </div>
          </div>
        {/each}
        {#if currentsDraft.currents.length === 0}
          <p class="filter-empty mono">no currents configured yet.</p>
        {/if}
      </div>

      <div class="story-actions">
        <button class="ghost sm mono" onclick={addCurrent}>+ add current</button>
        <button class="primary sm" onclick={saveCurrents} disabled={currentsSaving}>
          {currentsSaving ? 'saving…' : 'save currents'}
        </button>
      </div>
    </div>
  {:else}
    <p class="section-hint">
      {currentsDraft.currents.length > 0
        ? `${currentsDraft.currents.length} current${currentsDraft.currents.length !== 1 ? 's' : ''} configured, feeding arrivals into the pod view.`
        : 'define recurring streams (rss / url / topic) that bring new arrivals into this graph.'}
    </p>
  {/if}
</section>

<!-- ── Knowledge Bases ────────────────────────────────────────────────────── -->
<!-- GRAPH PACKAGE & SYNC — this graph's .ttl, sidecars, story, currents & folder sync.
     Belongs HERE, in the Graphs tab, not buried in the canvas's filter panel: this tab
     exists as its own top-level tab precisely because graph management matters. -->
<section class="section">
  <div class="section-head">
    <h3>graph package &amp; sync</h3>
  </div>
  <GraphPackagePanel statementCount={statements().length} />
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
  <p class="section-hint">paste another graph export; conflicts surface in review.</p>
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
  <p class="section-hint">link a local folder to automatically back up all graphs. your data survives browser cache clears.</p>

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
          <span class="files-label mono">graphs synced</span>
          <span class="files-value mono">{syncedKbCount() > 0 ? `${syncedKbCount()} graph${syncedKbCount() !== 1 ? 's' : ''}` : 'none yet'}</span>
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
            {wsSyncing ? 'syncing...' : 'sync all graphs now'}
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

  .kb-guidance-input {
    width: 100%; resize: vertical; font-size: 0.78rem;
    background: var(--surface-2); border: 1px solid var(--line); outline: none;
    border-radius: var(--rad-sm); color: var(--ink-2); font-family: var(--font-mono);
    line-height: 1.5; padding: 0.5rem; min-height: 2rem; margin-top: 0.5rem;
  }
  .kb-guidance-input:focus { border-color: var(--accent); }
  .kb-guidance-input::placeholder { color: var(--muted); font-family: inherit; }

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

  .section-actions { display: flex; align-items: center; gap: 0.75rem; }
  .ingest-cta {
    font-size: 0.7rem; color: var(--accent); text-decoration: none;
  }
  .ingest-cta:hover { text-decoration: underline; }
  .refresh-btn {
    font-size: 0.68rem; color: var(--muted); background: none; border: 1px solid var(--line);
    padding: 0.25rem 0.6rem; border-radius: var(--rad-sm); cursor: pointer;
  }
  .refresh-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .refresh-btn:disabled { opacity: 0.6; cursor: default; }
  .refresh-status { font-size: 0.68rem; color: var(--muted); margin: -0.4rem 0 0.5rem; }

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
  .compare-link {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    text-decoration: none;
    transition: background 0.12s;
  }
  .compare-link:hover { background: var(--accent); color: #fff; }

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

  /* ── Gallery controls (search + sort) ── */
  .kb-gallery-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem 0 0.35rem;
  }
  .kb-search {
    flex: 1;
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--fg);
  }
  .kb-search:focus { outline: none; border-color: var(--accent); }
  .kb-sort { display: flex; gap: 0.2rem; flex-shrink: 0; }
  .kb-sort-btn {
    font-size: 0.6rem;
    padding: 0.3rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .kb-sort-btn:hover { border-color: var(--accent); color: var(--fg); }
  .kb-sort-btn.active {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .kb-hidden-note {
    font-size: 0.6rem;
    color: var(--muted);
    margin: 0 0 0.35rem;
  }
  .kb-entry-size { font-size: 0.6rem; color: var(--muted); }
  /* A graph with no recorded size has never been opened. Say that, rather than "0 facts" —
     which would be a claim about its contents that we have not actually checked. */
  .kb-entry-size.muted-size { opacity: 0.6; font-style: italic; }
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

  /* ── Currents editor (F29.3) — ocean/whale accent for pod chrome ── */
  .currents-editor {
    display: flex; flex-direction: column; gap: 0.7rem;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad); padding: 1rem;
  }
  .currents-field { display: flex; flex-direction: column; gap: 0.35rem; }
  .currents-field input[type="text"] { width: 100%; }
  .currents-label {
    font-size: 0.68rem; color: var(--muted); text-transform: lowercase; letter-spacing: 0.03em;
  }
  .chip-row { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .currents-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .current-card {
    display: flex; flex-direction: column; gap: 0.4rem;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.7rem 0.85rem;
  }
  .current-card-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .current-label {
    flex: 1; min-width: 100px; font-size: 0.85rem; font-weight: 600;
    background: none; border: none; outline: none; color: var(--ink);
    padding: 0; border-bottom: 1px solid transparent;
  }
  .current-label:focus { border-bottom-color: #38bdf8; }
  .current-label::placeholder { color: var(--muted); font-weight: 400; }
  .current-kind {
    font-size: 0.68rem; padding: 0.2rem 0.4rem; border-radius: var(--rad-sm);
    background: var(--surface); border: 1px solid var(--line); color: var(--ink-2);
  }
  .current-source {
    width: 100%; font-size: 0.75rem; color: var(--ink-2);
    background: none; border: none; outline: none;
    border-bottom: 1px solid transparent; padding: 0;
  }
  .current-source:focus { border-bottom-color: var(--line); }
  .current-source::placeholder { color: var(--muted); }
  .current-cadence { width: 4.5rem; font-size: 0.75rem; }
  .currents-slug { font-size: 0.62rem; color: var(--muted); margin-left: auto; }
  .enabled-chip.active { background: #38bdf822; border-color: #38bdf8; color: #38bdf8; }

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
