<script lang="ts">
  import { goto } from '$app/navigation';
  import { ingest, buildIngestionPrompt, type IngestInput, type IngestProgress } from '$lib/stores/ingest.svelte';
  import { addSource, addStatements, sources, statements } from '$lib/stores/kb.svelte';
  import type { Source } from '$lib/rdf/types';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { requestManualLLM } from '$lib/stores/manual-llm.svelte';
  import { parseTriplesJSON, triplesToStatements } from '$lib/integrations/llm/extractor';
  import { computeDiff } from '$lib/rdf/diff';
  import { onWasmProgress } from '$lib/integrations/llm/wasm';
  import { ensureAuth, isSignedIn } from '$lib/integrations/google/auth';
  import { listTurtleFiles, downloadFile, type DriveFile } from '$lib/integrations/google/drive';
  import {
    listCalendars,
    findOrCreateKBCalendar,
    listEvents,
    type CalendarListEntry,
    type CalendarEvent,
    KB_CALENDAR_NAME
  } from '$lib/integrations/google/calendar';
  import { eventsToStatements } from '$lib/integrations/google/calendar-rdf';
  import { importTurtleFull } from '$lib/rdf/import-ttl';
  import { v4 as uuid } from 'uuid';
  import { extractGifPackage, parseGifPreviewTriples, parseGlbModelTriples } from '$lib/storage/gif-package';
  import { setGif } from '$lib/stores/gif-overrides.svelte';
  import { setGlb } from '$lib/stores/glb-overrides.svelte';
  import { KBaseDB, DEFAULT_SETTINGS } from '$lib/storage/db';
  import { createKb, registerStableId, switchToKb } from '$lib/storage/kb-registry';

  type Mode = 'note' | 'url' | 'document' | 'reminder' | 'triples' | 'drive' | 'calendar' | 'kb' | 'vault' | 'folder' | 'repo';
  let mode = $state<Mode>('note');

  // Standard ingest fields
  let title = $state('');
  let body = $state('');
  let url = $state('');
  let dueAt = $state('');
  let docText = $state('');
  let docName = $state('');

  let busy = $state(false);
  let phase = $state<string>('');
  let wasmStatus = $state('');
  let error = $state<string | null>(null);

  // Manual triples entry
  let manualTriples = $state<Array<{ subject: string; predicate: string; object: string }>>([
    { subject: '', predicate: '', object: '' },
  ]);

  function addTripleRow() {
    manualTriples = [...manualTriples, { subject: '', predicate: '', object: '' }];
  }
  function removeTripleRow(i: number) {
    manualTriples = manualTriples.filter((_, idx) => idx !== i);
  }

  async function submitManualTriples() {
    const filled = manualTriples.filter(t => t.subject.trim() && t.predicate.trim() && t.object.trim());
    if (!filled.length || !title.trim()) return;
    error = null;
    busy = true;
    try {
      const source = {
        id: uuid(),
        title: title.trim(),
        uri: `manual://${uuid()}`,
        kind: 'note' as const,
        trustLevel: 'review' as const,
        trustScore: 0.5,
        ingestedAt: Date.now(),
      };
      const extracted = filled.map(t => ({
        subject: t.subject.trim(),
        predicate: t.predicate.trim(),
        object: t.object.trim(),
        gloss: `${t.subject.trim()} — ${t.predicate.trim()} — ${t.object.trim()}`,
        confidence: 0.7,
      }));
      const stmts = triplesToStatements(extracted, source);
      await addSource(source);
      await addStatements(stmts);
      goto(`/compare?source=${source.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // Copy prompt / paste response (any LLM)
  let copyBusy = $state(false);

  async function copyPromptAndPaste() {
    if (!canSubmit) return;
    copyBusy = true;
    error = null;
    try {
      let input: IngestInput;
      if (mode === 'url') input = { kind: 'url', url };
      else if (mode === 'document') input = { kind: 'document', title: title || docName, text: docText, filename: docName };
      else if (mode === 'note') input = { kind: 'note', title, body };
      else input = { kind: 'reminder', title, body, dueAt: dueAt ? new Date(dueAt).getTime() : undefined };

      const { prompt, title: sourceTitle } = await buildIngestionPrompt(input);
      const raw = await requestManualLLM(prompt);  // opens modal
      const triples = parseTriplesJSON(raw);

      const source = {
        id: uuid(),
        title: sourceTitle,
        uri: mode === 'url' ? url : `manual://${uuid()}`,
        kind: (mode === 'url' ? 'url' : mode === 'document' ? 'document' : 'note') as any,
        trustLevel: 'review' as const,
        trustScore: 0.5,
        ingestedAt: Date.now(),
      };
      const stmts = triplesToStatements(triples, source);
      await addSource(source);
      await addStatements(stmts);
      goto(`/compare?source=${source.id}`);
    } catch (e) {
      if (e instanceof Error && e.message === 'Cancelled') return;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      copyBusy = false;
    }
  }

  let unsubWasm: (() => void) | null = null;
  $effect(() => {
    unsubWasm = onWasmProgress((status, p) => {
      wasmStatus = p != null ? `${status} ${(p * 100).toFixed(0)}%` : status;
    });
    return () => unsubWasm?.();
  });

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    docName = file.name;
    error = null;

    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');
    const mistralKey = settings().mistralApiKey;

    if ((isPdf || isImage) && mistralKey) {
      busy = true;
      phase = 'parsing with mistral ocr…';
      try {
        const { parsePdfWithMistralOCR } = await import('$lib/integrations/parsers/mistral-ocr');
        docText = await parsePdfWithMistralOCR(file, mistralKey);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        busy = false;
        phase = '';
        return;
      }
      busy = false;
      phase = '';
    } else {
      docText = await file.text();
    }

    if (!title) title = file.name.replace(/\.[^.]+$/, '');
  }

  async function submit() {
    error = null;
    busy = true;
    try {
      let input: IngestInput;
      if (mode === 'url') input = { kind: 'url', url };
      else if (mode === 'document')
        input = { kind: 'document', title: title || docName, text: docText, filename: docName };
      else if (mode === 'note') input = { kind: 'note', title, body };
      else
        input = {
          kind: 'reminder',
          title,
          body,
          dueAt: dueAt ? new Date(dueAt).getTime() : undefined
        };
      const result = await ingest(input, (p: IngestProgress) => {
        phase = p.phase;
      });
      goto(`/compare?source=${result.source.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const canSubmit = $derived.by(() => {
    if (busy) return false;
    if (mode === 'vault' || mode === 'folder' || mode === 'repo') return false; // these have their own submit flow
    if (mode === 'url') return url.trim().length > 0;
    if (mode === 'document') return docText.trim().length > 0;
    if (mode === 'triples') return title.trim().length > 0 && manualTriples.some(t => t.subject.trim() && t.predicate.trim() && t.object.trim());
    return title.trim().length > 0 && (mode === 'note' ? body.trim().length > 0 : true);
  });

  // For "use any LLM" button — needs content but not a backend key
  const canCopyPrompt = $derived(
    !busy && !copyBusy && mode !== 'triples' && mode !== 'drive' && mode !== 'calendar' && mode !== 'repo' &&
    (mode === 'url' ? url.trim().length > 0 : title.trim().length > 0)
  );

  // ── KB file import ────────────────────────────────────────────────────────────
  let kbFile = $state<File | null>(null);
  let kbPreview = $state<{ stmts: number; isAnnotated: boolean } | null>(null);
  let kbParsing = $state(false);

  // GIF/GLB blobs extracted from a .zip import — applied on importKb()
  let pendingGifImports = $state<Map<string, { blob: Blob; filename: string }>>(new Map());
  let pendingGlbImports = $state<Map<string, string>>(new Map()); // IRI → object URL or remote URL

  async function onKbFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    kbFile = file;
    kbPreview = null;
    kbParsing = true;
    error = null;
    pendingGifImports = new Map();
    pendingGlbImports = new Map();
    try {
      let ttlText: string;

      if (file.name.endsWith('.zip') || file.type === 'application/zip') {
        const zipBytes = new Uint8Array(await file.arrayBuffer());
        const { ttl, gifs, glbs } = extractGifPackage(zipBytes);
        ttlText = ttl;

        // Parse gifPreview triples to build IRI → gif mapping
        const previews = parseGifPreviewTriples(ttl);
        const pending = new Map<string, { blob: Blob; filename: string }>();
        for (const [iri, relPath] of previews) {
          const blob = gifs.get(relPath);
          if (blob) {
            const filename = relPath.replace(/^media\//, '');
            pending.set(iri, { blob, filename });
          }
        }
        pendingGifImports = pending;

        // Parse glbModel triples to build IRI → URL mapping
        const glbRefs = parseGlbModelTriples(ttl);
        const pendingGlbs = new Map<string, string>();
        for (const [iri, refValue] of glbRefs) {
          if (refValue.startsWith('models/')) {
            const blob = glbs.get(refValue);
            if (blob) pendingGlbs.set(iri, URL.createObjectURL(blob));
          } else {
            // Remote URL — store as-is
            pendingGlbs.set(iri, refValue);
          }
        }
        pendingGlbImports = pendingGlbs;
      } else {
        ttlText = await file.text();
      }

      const { statements: rawStmts, cleanImportCount } = await importTurtleFull(ttlText);
      const active = rawStmts.filter(
        (s) => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending'
      );
      kbPreview = { stmts: active.length, isAnnotated: cleanImportCount === 0 };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      kbFile = null;
    } finally {
      kbParsing = false;
    }
  }

  async function importKb() {
    if (!kbFile || !kbPreview) return;
    busy = true;
    error = null;
    try {
      let ttlText: string;
      if (kbFile.name.endsWith('.zip') || kbFile.type === 'application/zip') {
        const zipBytes = new Uint8Array(await kbFile.arrayBuffer());
        const { ttl } = extractGifPackage(zipBytes);
        ttlText = ttl;
      } else {
        ttlText = await kbFile.text();
      }
      const { statements: rawStmts, shellyPersona } = await importTurtleFull(ttlText);

      const now = Date.now();
      const sourceId = uuid();
      const source = {
        id: sourceId,
        title: kbFile.name.replace(/\.(ttl|turtle|n3|nq)$/i, ''),
        uri: `file://${kbFile.name}`,
        kind: 'document' as const,
        trustLevel: 'review' as const,
        trustScore: 0.5,
        ingestedAt: now,
      };

      // Only import active statements; re-ID them to avoid primary-key conflicts
      const toImport = rawStmts
        .filter((s) => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending')
        .map((s) => ({
          ...s,
          id: uuid(),
          sourceId,
          g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
          status: 'pending' as const,
          createdAt: now,
          updatedAt: now,
        }));

      await addSource(source);
      await addStatements(toImport);

      // Apply Shelly persona overrides from the TTL file
      if (shellyPersona) {
        const { updateTurtleSettings } = await import('$lib/stores/turtle-settings.svelte');
        const patch: Record<string, unknown> = {};
        // Identity & prompting
        if (shellyPersona.name) patch.name = shellyPersona.name;
        if (shellyPersona.greeting) patch.greeting = shellyPersona.greeting;
        if (shellyPersona.personality) patch.personality = shellyPersona.personality;
        if (shellyPersona.systemPrompt) patch.systemPrompt = shellyPersona.systemPrompt;
        if (shellyPersona.responseStyle) patch.responseStyle = shellyPersona.responseStyle;
        if (shellyPersona.maxWords) patch.maxResponseWords = shellyPersona.maxWords;
        if (shellyPersona.patienceLevel != null) patch.patienceLevel = shellyPersona.patienceLevel;
        if (shellyPersona.engagement) patch.engagement = shellyPersona.engagement;
        // Voice
        if (shellyPersona.voiceEnabled != null) patch.voiceEnabled = shellyPersona.voiceEnabled;
        if (shellyPersona.voiceType) patch.voiceType = shellyPersona.voiceType;
        if (shellyPersona.speechRate != null) patch.speechRate = shellyPersona.speechRate;
        if (shellyPersona.volume != null) patch.volume = shellyPersona.volume;
        // Visual
        if (shellyPersona.animationSpeed) patch.animationSpeed = shellyPersona.animationSpeed;
        if (shellyPersona.opacity != null) patch.opacity = shellyPersona.opacity;
        if (shellyPersona.size) patch.size = shellyPersona.size;
        if (shellyPersona.glowEffect != null) patch.glowEffect = shellyPersona.glowEffect;
        if (shellyPersona.wanderRange != null) patch.wanderRange = shellyPersona.wanderRange;
        // Interaction
        if (shellyPersona.proactiveHelp) patch.proactiveHelp = shellyPersona.proactiveHelp;
        if (shellyPersona.showTutorialHints != null) patch.showTutorialHints = shellyPersona.showTutorialHints;
        if (shellyPersona.responseFrequency != null) patch.responseFrequency = shellyPersona.responseFrequency;
        if (Object.keys(patch).length > 0) await updateTurtleSettings(patch);
      }

      // Restore any GIFs bundled in the zip
      for (const [iri, { blob, filename }] of pendingGifImports) {
        await setGif(iri, blob, filename);
      }
      pendingGifImports = new Map();

      // Restore any GLB model overrides bundled in the zip
      for (const [iri, url] of pendingGlbImports) {
        await setGlb(iri, url);
      }
      pendingGlbImports = new Map();

      goto(`/compare?source=${sourceId}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** Import a TTL/zip into a brand-new, separate KB (for KB Leap interop). */
  async function importAsNewKb() {
    if (!kbFile || !kbPreview) return;
    busy = true;
    error = null;
    try {
      let ttlText: string;
      if (kbFile.name.endsWith('.zip') || kbFile.type === 'application/zip') {
        ttlText = extractGifPackage(new Uint8Array(await kbFile.arrayBuffer())).ttl;
      } else {
        ttlText = await kbFile.text();
      }
      const { statements: rawStmts } = await importTurtleFull(ttlText);
      const kbName = kbFile.name.replace(/\.(ttl|turtle|zip|n3|nq)$/i, '');
      const newKb = createKb(kbName);

      // Open a temporary Dexie instance for the new KB
      const tempDb = new KBaseDB(newKb.id);
      await tempDb.open();
      await tempDb.settings.put({ ...DEFAULT_SETTINGS, kbTitle: kbName });

      const now = Date.now();
      const sourceId = uuid();
      await tempDb.sources.put({
        id: sourceId,
        title: kbName,
        uri: `file://${kbFile.name}`,
        kind: 'document',
        trustLevel: 'trusted',
        ingestedAt: now,
      });

      const stmts = rawStmts
        .filter(s => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending')
        .map(s => ({
          ...s,
          id: uuid(),
          sourceId,
          g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
          status: 'confirmed' as const,
          createdAt: now,
          updatedAt: now,
        }));
      await tempDb.statements.bulkPut(stmts);

      // Extract stable ID from the imported KB's settings triple (if present)
      const stableIdStmt = rawStmts.find(
        s => s.p.value === 'urn:kbase:predicate/kbStableId' || s.p.value === 'urn:reckons:meta/kbStableId'
      );
      if (stableIdStmt?.o.kind === 'literal') {
        await tempDb.settings.update('main', { kbStableId: stableIdStmt.o.value });
        registerStableId(newKb.id, stableIdStmt.o.value, stmts.length);
      }

      tempDb.close();

      if (confirm(`Created "${kbName}" with ${stmts.length} facts.\n\nSwitch to it now?`)) {
        switchToKb(newKb.id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ── Google Drive ─────────────────────────────────────────────────────────────
  let driveFiles = $state<DriveFile[]>([]);
  let driveLoading = $state(false);
  let driveSelected = $state<DriveFile | null>(null);

  async function loadDriveFiles() {
    driveLoading = true;
    error = null;
    try {
      await ensureAuth(settings().googleClientId ?? '');
      driveFiles = await listTurtleFiles();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      driveLoading = false;
    }
  }

  async function importFromDrive() {
    if (!driveSelected) return;
    busy = true;
    error = null;
    try {
      const content = await downloadFile(driveSelected.id);
      const input: IngestInput = {
        kind: 'document',
        title: driveSelected.name.replace(/\.ttl$/, ''),
        text: content,
        filename: driveSelected.name
      };
      const result = await ingest(input, (p) => { phase = p.phase; });
      goto(`/compare?source=${result.source.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ── Google Calendar ───────────────────────────────────────────────────────────
  let calendars = $state<CalendarListEntry[]>([]);
  let calLoading = $state(false);
  let selectedCalendarIds = $state<Set<string>>(new Set());
  let calDateFrom = $state((() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().split('T')[0];
  })());
  let calDateTo = $state(new Date().toISOString().split('T')[0]);
  let calImporting = $state(false);
  let calImportCount = $state(0);

  async function loadCalendars() {
    calLoading = true;
    error = null;
    try {
      await ensureAuth(settings().googleClientId ?? '');
      calendars = await listCalendars();
      // Pre-select the Reckons.AI KB calendar if present
      const kb = calendars.find(c => c.summary === KB_CALENDAR_NAME);
      if (kb) selectedCalendarIds = new Set([kb.id]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      calLoading = false;
    }
  }

  function toggleCalendar(id: string) {
    if (selectedCalendarIds.has(id)) {
      selectedCalendarIds.delete(id);
    } else {
      selectedCalendarIds.add(id);
    }
    selectedCalendarIds = new Set(selectedCalendarIds);
  }

  async function importCalendarEvents() {
    if (selectedCalendarIds.size === 0) return;
    calImporting = true;
    error = null;
    calImportCount = 0;
    try {
      const timeMin = new Date(calDateFrom);
      const timeMax = new Date(calDateTo);
      timeMax.setHours(23, 59, 59);

      const allStmts = [];
      for (const calId of selectedCalendarIds) {
        const events = await listEvents(calId, timeMin, timeMax);
        const sourceId = `gcal-${calId.replace(/[^a-z0-9]/gi, '-')}`;
        const stmts = eventsToStatements(events, sourceId, calId, statements());
        allStmts.push(...stmts);
        calImportCount += events.length;
      }

      if (allStmts.length > 0) {
        const firstSourceId = `gcal-${[...selectedCalendarIds][0].replace(/[^a-z0-9]/gi, '-')}`;
        await addStatements(allStmts);
        goto(`/compare?source=${firstSourceId}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      calImporting = false;
    }
  }

  const googleReady = $derived(!!settings().googleClientId);

  // ── Calendar sub-source tabs (Google / Indico / iCal) ───────────────────────
  type CalSource = 'google' | 'indico' | 'ical';
  let calSource = $state<CalSource>('google');

  // Indico import
  let indicoImporting = $state(false);
  let indicoImportResult = $state<string | null>(null);

  async function importIndicoEvents() {
    const serverUrl = settings().indicoServerUrl;
    if (!serverUrl) return;
    indicoImporting = true;
    indicoImportResult = null;
    error = null;
    try {
      const { createIndicoClient } = await import('$lib/integrations/indico/client');
      const { indicoEventsToStatements } = await import('$lib/integrations/indico/indico-rdf');
      const client = createIndicoClient(serverUrl, settings().indicoApiToken);
      if (!client) throw new Error('Invalid Indico server URL');
      const resp = await client.fetchEvents(settings().indicoCategoryId);
      const events = resp.results;
      const sourceId = `indico-${Date.now()}`;
      const stmts = indicoEventsToStatements(events, sourceId, serverUrl, statements());
      if (stmts.length > 0) {
        await addSource({
          id: sourceId,
          title: `Indico — ${events.length} events`,
          uri: serverUrl,
          kind: 'calendar',
          trustLevel: 'review',
          trustScore: 0.5,
          ingestedAt: Date.now()
        });
        await addStatements(stmts);
        indicoImportResult = `Imported ${events.length} events (${stmts.length} facts)`;
      } else {
        indicoImportResult = 'No events found.';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      indicoImporting = false;
    }
  }

  // iCal import
  let icalUrl = $state('');
  let icalImporting = $state(false);
  let icalImportResult = $state<string | null>(null);

  async function importICalEvents() {
    if (!icalUrl.trim()) return;
    icalImporting = true;
    icalImportResult = null;
    error = null;
    try {
      const { fetchICalEvents } = await import('$lib/integrations/indico/ical-parse');
      const { eventsToStatements: icalToStatements } = await import('$lib/integrations/google/calendar-rdf');
      const events = await fetchICalEvents(icalUrl.trim());
      const sourceId = `ical-${Date.now()}`;
      // Convert ICalEvent to CalendarEvent shape for reuse of eventsToStatements
      const calEvents = events.map(ev => ({
        id: ev.uid,
        summary: ev.summary,
        start: { dateTime: ev.start.toISOString() },
        end: ev.end ? { dateTime: ev.end.toISOString() } : undefined,
        description: ev.description,
        location: ev.location,
        recurrence: ev.rrule ? [`RRULE:${ev.rrule}`] : undefined,
      }));
      const stmts = icalToStatements(calEvents as any, sourceId, icalUrl.trim(), statements());
      if (stmts.length > 0) {
        await addSource({
          id: sourceId,
          title: `iCal — ${events.length} events`,
          uri: icalUrl.trim(),
          kind: 'calendar',
          trustLevel: 'review',
          trustScore: 0.5,
          ingestedAt: Date.now()
        });
        await addStatements(stmts);
        icalImportResult = `Imported ${events.length} events (${stmts.length} facts)`;
      } else {
        icalImportResult = 'No events found in feed.';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      icalImporting = false;
    }
  }

  // ── Vault / batch markdown ingestion ────────────────────────────────────────
  type VaultItem = {
    file: File;
    status: 'queued' | 'parsing' | 'extracting' | 'done' | 'error';
    error?: string;
    sourceId?: string;
    wikilinks: string[];
  };

  let vaultQueue = $state<VaultItem[]>([]);
  let vaultRunning = $state(false);
  let vaultDone = $state(0);

  function extractWikilinks(text: string): string[] {
    const matches = text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    return [...new Set([...matches].map(m => m[1].trim()))];
  }

  async function onVaultFiles(e: Event) {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    const items: VaultItem[] = files
      .filter(f => /\.(md|markdown|txt)$/i.test(f.name))
      .map(f => ({ file: f, status: 'queued' as const, wikilinks: [] }));
    vaultQueue = items;
    vaultDone = 0;
  }

  async function runVault() {
    vaultRunning = true;
    vaultDone = 0;

    for (let i = 0; i < vaultQueue.length; i++) {
      const item = vaultQueue[i];
      if (item.status === 'done') { vaultDone++; continue; }

      try {
        item.status = 'parsing';
        vaultQueue = [...vaultQueue]; // trigger reactivity

        let text = await item.file.text();
        const wikilinks = extractWikilinks(text);
        item.wikilinks = wikilinks;

        // Prepend wikilink hints for better entity extraction
        if (wikilinks.length > 0) {
          text = `[Entities mentioned in this note: ${wikilinks.join(', ')}]\n\n${text}`;
        }

        // Strip YAML frontmatter — pass as context hint instead
        const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
        const fmText = fmMatch ? `[Frontmatter: ${fmMatch[1].replace(/\n/g, ' | ')}]\n\n` : '';
        if (fmMatch) text = fmText + text.slice(fmMatch[0].length);

        item.status = 'extracting';
        vaultQueue = [...vaultQueue];

        const itemTitle = item.file.name.replace(/\.[^.]+$/, '');
        const result = await ingest(
          { kind: 'document', title: itemTitle, text, filename: item.file.name },
          () => {}
        );
        item.status = 'done';
        item.sourceId = result.source.id;
      } catch (err) {
        item.status = 'error';
        item.error = err instanceof Error ? err.message : String(err);
      }

      vaultDone++;
      vaultQueue = [...vaultQueue];

      // Throttle between files to avoid LLM rate limits
      if (i < vaultQueue.length - 1) await new Promise(r => setTimeout(r, 600));
    }

    vaultRunning = false;
  }

  function clearVault() {
    vaultQueue = [];
    vaultDone = 0;
    vaultRunning = false;
  }

  const vaultProgress = $derived(
    vaultQueue.length > 0 ? Math.round((vaultDone / vaultQueue.length) * 100) : 0
  );

  // ── Folder ingest ──────────────────────────────────────────────────────────
  import { scanFolder, folderToStatements, type FolderScanResult } from '$lib/ingest/folder-scan';

  let folderScanResult = $state<FolderScanResult | null>(null);
  let folderScanning = $state(false);
  let folderIngesting = $state(false);
  let folderProgress = $state('');
  let folderDone = $state(false);
  let folderStmtCount = $state(0);

  async function pickFolder() {
    if (!('showDirectoryPicker' in window)) {
      alert('Your browser does not support folder selection. Use Chrome or Edge.');
      return;
    }
    folderScanning = true;
    folderDone = false;
    try {
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
      folderScanResult = await scanFolder(dirHandle, (msg) => { folderProgress = msg; });
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        alert(`Scan failed: ${e?.message ?? e}`);
      }
    } finally {
      folderScanning = false;
      folderProgress = '';
    }
  }

  async function ingestFolder() {
    if (!folderScanResult) return;
    folderIngesting = true;
    folderDone = false;
    try {
      const sourceId = `folder-${Date.now()}`;
      const stmts = folderToStatements(folderScanResult, sourceId);
      await addSource({
        id: sourceId,
        title: `Folder — ${folderScanResult.rootName}/ (${folderScanResult.files.length} files)`,
        uri: `local-folder://${folderScanResult.rootName}`,
        kind: 'document',
        trustLevel: 'review',
        ingestedAt: Date.now()
      });
      await addStatements(stmts, sourceId);
      folderStmtCount = stmts.length;
      folderDone = true;
    } catch (e: any) {
      alert(`Ingest failed: ${e?.message ?? e}`);
    } finally {
      folderIngesting = false;
    }
  }

  function formatFolderSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ── Repo ingest ───────────────────────────────────────────────────────────
  import type { RepoMeta, RepoIngestProgress } from '$lib/integrations/github/repo-ingest';

  let repoUrl = $state('');
  let repoMeta = $state<RepoMeta | null>(null);
  let repoFetching = $state(false);
  let repoProgress = $state('');
  let repoDone = $state(false);

  async function fetchRepoPreview() {
    if (!repoUrl.trim()) return;
    error = null;
    repoFetching = true;
    repoMeta = null;
    repoProgress = 'fetching repo info…';
    try {
      const { parseRepoUrl, fetchRepoMeta } = await import('$lib/integrations/github/repo-ingest');
      const ref = parseRepoUrl(repoUrl.trim());
      if (!ref) { error = 'Invalid repo URL. Use "owner/repo" or a GitHub URL.'; return; }
      const token = settings().githubToken;
      repoMeta = await fetchRepoMeta(ref, token || undefined);
      repoProgress = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      repoFetching = false;
    }
  }

  async function submitRepo() {
    if (!repoUrl.trim()) return;
    error = null;
    busy = true;
    repoDone = false;
    try {
      const token = settings().githubToken;
      const result = await ingest(
        { kind: 'repository', repoUrl: repoUrl.trim(), token: token || undefined },
        (p: IngestProgress) => {
          phase = p.phase;
          if (p.phase === 'fetching') repoProgress = 'fetching files…';
          else if (p.phase === 'extracting') repoProgress = `extracting facts (${p.backend})…`;
          else if (p.phase === 'normalizing') repoProgress = 'normalising entities…';
          else if (p.phase === 'diffing') repoProgress = 'computing diff…';
          else if (p.phase === 'semantic') repoProgress = 'semantic enrichment…';
          else repoProgress = '';
        },
      );
      repoDone = true;
      goto(`/compare?source=${result.source.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** Check if an existing source is a repo and can be updated */
  function findExistingRepoSource(owner: string, repo: string): Source | undefined {
    return sources().find(s =>
      s.kind === 'repository' && s.repoOwner === owner && s.repoName === repo
    );
  }
</script>

<header class="head">
  <p class="kicker mono">add</p>
  <h1>add to the base.</h1>
  <p class="sub">
    a single document, note, url or reminder. it will be parsed into atomic
    facts for you to review.
  </p>
</header>

<div class="tabs mono">
  {#each [{ k: 'note', l: 'note' }, { k: 'reminder', l: 'reminder' }, { k: 'url', l: 'url' }, { k: 'document', l: 'document' }, { k: 'vault', l: 'vault ⟁' }, { k: 'triples', l: 'facts ✎' }] as t}
    <button class:active={mode === t.k} onclick={() => (mode = t.k as Mode)}>{t.l}</button>
  {/each}
  <button class:active={mode === 'kb'} onclick={() => (mode = 'kb')}><svg class="tab-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="4" y1="4" x2="10" y2="4"/><line x1="4" y1="4" x2="7" y2="10"/><line x1="10" y1="4" x2="7" y2="10"/><circle cx="4" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="7" cy="10" r="1.5" fill="currentColor" stroke="none"/></svg> graph</button>
  <button
    class:active={mode === 'drive'}
    onclick={() => { mode = 'drive'; loadDriveFiles(); }}
    title={googleReady ? 'Import from Google Drive' : 'Set a Google Client ID in Settings first'}
  >drive</button>
  <button
    class:active={mode === 'calendar'}
    onclick={() => { mode = 'calendar'; loadCalendars(); }}
    title={googleReady ? 'Import from Google Calendar' : 'Set a Google Client ID in Settings first'}
  >calendar</button>
  <button class:active={mode === 'folder'} onclick={() => (mode = 'folder')}>folder</button>
  <button class:active={mode === 'repo'} onclick={() => (mode = 'repo')}>repo</button>
</div>

{#if mode !== 'kb' && mode !== 'drive' && mode !== 'calendar'}
<div class="card form">
  {#if mode === 'url'}
    <label>
      <span class="lbl mono">source url</span>
      <input type="url" bind:value={url} placeholder="https://..." />
    </label>
  {:else if mode === 'document'}
    <label>
      <span class="lbl mono">title</span>
      <input type="text" bind:value={title} placeholder="document title" />
    </label>
    <label>
      <span class="lbl mono">upload file</span>
      <input type="file" accept=".txt,.md,.markdown,.json,.csv,.pdf,text/*,image/*,application/pdf" onchange={onFile} />
      {#if !settings().mistralApiKey}
        <p class="hint">PDFs and images require a Mistral API key — set it in <a href="/settings/integrations">Settings → Integrations</a>.</p>
      {/if}
    </label>
    {#if docText}
      <p class="hint mono">{docText.length.toLocaleString()} chars loaded from {docName}</p>
    {/if}
  {:else if mode === 'vault'}
    <p class="hint" style="margin-bottom:0.5rem">Drop a folder of <code>.md</code> / <code>.txt</code> files — each file becomes its own sourced batch of facts. Wikilinks are extracted as entity hints.</p>
    {#if vaultQueue.length === 0}
      <label>
        <span class="lbl mono">select files</span>
        <input type="file" accept=".md,.markdown,.txt" multiple onchange={onVaultFiles} />
      </label>
    {:else}
      <!-- Progress bar -->
      {#if vaultRunning || vaultDone > 0}
        <div class="vault-progress-bar">
          <div class="vault-progress-fill" style="width: {vaultProgress}%"></div>
        </div>
        <p class="hint mono">{vaultDone} / {vaultQueue.length} processed</p>
      {/if}

      <!-- Queue list -->
      <div class="vault-queue">
        {#each vaultQueue as item}
          <div class="vault-item vault-{item.status}">
            <span class="vault-icon">
              {#if item.status === 'queued'}   ○
              {:else if item.status === 'parsing'}   ◌
              {:else if item.status === 'extracting'} ◎
              {:else if item.status === 'done'}      ✓
              {:else}                                ✕
              {/if}
            </span>
            <div class="vault-item-body">
              <span class="vault-filename mono">{item.file.name}</span>
              {#if item.wikilinks.length > 0}
                <span class="vault-links mono">{item.wikilinks.slice(0, 5).join(', ')}{item.wikilinks.length > 5 ? ` +${item.wikilinks.length - 5}` : ''}</span>
              {/if}
              {#if item.error}
                <span class="vault-error">{item.error}</span>
              {/if}
              {#if item.sourceId}
                <a class="vault-review" href="/compare?source={item.sourceId}">review →</a>
              {/if}
            </div>
            <span class="vault-status mono">{item.status}</span>
          </div>
        {/each}
      </div>

      <div class="vault-actions">
        {#if !vaultRunning && vaultDone < vaultQueue.length}
          <button class="btn-primary" onclick={runVault}>
            Process {vaultQueue.filter(i => i.status === 'queued').length} file{vaultQueue.filter(i => i.status === 'queued').length !== 1 ? 's' : ''}
          </button>
        {/if}
        {#if vaultRunning}
          <span class="hint mono">processing… do not close this tab</span>
        {/if}
        {#if !vaultRunning && vaultDone === vaultQueue.length && vaultDone > 0}
          <a href="/review" class="btn-primary">Review all →</a>
        {/if}
        <button class="btn-secondary" onclick={clearVault}>clear</button>
      </div>
    {/if}

  {:else if mode === 'folder'}
    <p class="hint" style="margin-bottom:0.5rem">Select a folder — its structure (file names, extensions, paths) and readable text content will be ingested into the graph.</p>
    {#if !folderScanResult}
      <button class="btn-primary" onclick={pickFolder} disabled={folderScanning}>
        {folderScanning ? folderProgress : 'Choose Folder'}
      </button>
    {:else}
      <div class="folder-summary">
        <p class="hint mono">{folderScanResult.rootName}/ — {folderScanResult.files.length} files, {folderScanResult.directories.length} dirs</p>
        <p class="hint mono">{folderScanResult.files.filter(f => f.isReadable).length} readable, {formatFolderSize(folderScanResult.totalSize)} total</p>
      </div>
      <div class="vault-actions">
        <button class="btn-primary" onclick={ingestFolder} disabled={folderIngesting}>
          {folderIngesting ? 'Ingesting...' : `Ingest ${folderScanResult.files.length} files`}
        </button>
        <button class="btn-secondary" onclick={() => { folderScanResult = null; }}>clear</button>
      </div>
      {#if folderDone}
        <p class="hint mono ok">Done — {folderStmtCount} facts created. <a href="/review">Review →</a></p>
      {/if}
    {/if}

  {:else if mode === 'repo'}
    <p class="hint" style="margin-bottom:0.5rem">Ingest a GitHub repository — code, docs, and configs are analyzed for knowledge extraction. Use <code>owner/repo</code> or a full GitHub URL.</p>
    <label>
      <span class="lbl mono">repository</span>
      <div class="repo-input-row">
        <input type="text" bind:value={repoUrl} placeholder="owner/repo or https://github.com/..." onkeydown={(e) => e.key === 'Enter' && fetchRepoPreview()} />
        <button class="btn-secondary" onclick={fetchRepoPreview} disabled={repoFetching || !repoUrl.trim()}>
          {repoFetching ? 'loading…' : 'preview'}
        </button>
      </div>
    </label>
    {#if !settings().githubToken}
      <p class="hint">For private repos and higher rate limits, add a GitHub token in <a href="/settings/integrations">Settings → Integrations</a>.</p>
    {/if}
    {#if repoMeta}
      {@const existing = findExistingRepoSource(repoMeta.owner, repoMeta.repo)}
      <div class="repo-preview">
        <p class="mono"><strong>{repoMeta.owner}/{repoMeta.repo}</strong> on <code>{repoMeta.branch}</code></p>
        {#if repoMeta.description}<p class="hint">{repoMeta.description}</p>{/if}
        <p class="hint mono">{repoMeta.language ?? 'unknown'} — {repoMeta.stars} stars — HEAD: {repoMeta.headSha.slice(0, 8)}</p>
        {#if existing}
          <p class="hint ok">Previously ingested at {existing.repoHeadSha?.slice(0, 8) ?? '???'}. This will update with changes.</p>
        {/if}
        <button class="btn-primary" onclick={submitRepo} disabled={busy}>
          {busy ? repoProgress || 'ingesting…' : existing ? 'update repo' : 'ingest repo'}
        </button>
      </div>
    {/if}
    {#if repoProgress && !repoMeta}
      <p class="hint mono">{repoProgress}</p>
    {/if}

  {:else if mode === 'note'}
    <label>
      <span class="lbl mono">title</span>
      <input type="text" bind:value={title} placeholder="what is this about" />
    </label>
    <label>
      <span class="lbl mono">body</span>
      <textarea bind:value={body} rows="9" placeholder="write a note in your own words. it will be decomposed into facts."></textarea>
    </label>
  {:else if mode === 'triples'}
    <p class="hint" style="margin-bottom: 0.25rem;">Add facts directly — no AI needed. Great for structured notes.</p>
    <label>
      <span class="lbl mono">source title</span>
      <input type="text" bind:value={title} placeholder="name for this set of notes" />
    </label>
    <div class="triples-list">
      {#each manualTriples as t, i (i)}
        <div class="triple-entry">
          <input class="te-sub" bind:value={t.subject}   placeholder="subject" />
          <input class="te-pre" bind:value={t.predicate} placeholder="predicate" />
          <input class="te-obj" bind:value={t.object}    placeholder="object" />
          <button class="te-del" onclick={() => removeTripleRow(i)} title="remove">✕</button>
        </div>
      {/each}
    </div>
    <button class="add-triple-btn" onclick={addTripleRow}>+ add row</button>
  {:else}
    <label>
      <span class="lbl mono">reminder</span>
      <input type="text" bind:value={title} placeholder="what to remember" />
    </label>
    <label>
      <span class="lbl mono">context</span>
      <textarea bind:value={body} rows="4" placeholder="why, who, where"></textarea>
    </label>
    <label>
      <span class="lbl mono">due</span>
      <input type="text" bind:value={dueAt} placeholder="2026-06-01T09:00" />
    </label>
  {/if}

  {#if mode === 'triples'}
    <div class="row">
      <span></span>
      <button class="primary" onclick={submitManualTriples} disabled={!canSubmit || busy}>
        {busy ? 'saving…' : 'add to graph →'}
      </button>
    </div>
  {:else}
    <div class="row">
      <span class="backend mono">ingest: <strong>{settings().ingestBackend ?? settings().preferredBackend}</strong></span>
      <div class="action-group">
        <button
          class="paste-btn mono"
          onclick={copyPromptAndPaste}
          disabled={!canCopyPrompt}
          title="Build the prompt and paste the response from any LLM — no API key needed"
        >use any LLM</button>
        <button class="primary" onclick={submit} disabled={!canSubmit}>
          {busy ? phase || 'working…' : 'extract facts →'}
        </button>
      </div>
    </div>
  {/if}

  {#if busy && wasmStatus && settings().preferredBackend === 'wasm'}
    <p class="hint mono">{wasmStatus}</p>
  {/if}
  {#if copyBusy && mode === 'url'}
    <p class="hint mono">fetching page…</p>
  {/if}
  {#if error}
    <p class="err">{error}</p>
  {/if}
</div>
{/if}

{#if mode === 'kb'}
  <div class="card gcard">
    <p class="sub" style="margin-bottom: 0.75rem;">
      upload a <code>.ttl</code> file or a <code>.zip</code> export bundle (includes GIFs, GLB models, stories) —
      exported from this graph or any other Turtle source.
      facts will be imported as <em>pending</em> for you to review and confirm.
    </p>
    <label class="kb-file-label">
      <span class="lbl mono">turtle file</span>
      <input
        type="file"
        accept=".ttl,.turtle,.n3,.nq,.zip,text/turtle,application/n-quads,application/zip"
        onchange={onKbFile}
      />
    </label>
    {#if kbParsing}
      <p class="hint mono">parsing…</p>
    {:else if kbPreview}
      <div class="kb-preview">
        <span class="kb-count mono">{kbPreview.stmts} fact{kbPreview.stmts !== 1 ? 's' : ''}</span>
        <span class="kb-badge mono">{kbPreview.isAnnotated ? 'annotated export' : 'plain turtle'}</span>
        {#if pendingGifImports.size > 0}
          <span class="kb-badge mono">{pendingGifImports.size} gif{pendingGifImports.size !== 1 ? 's' : ''}</span>
        {/if}
        {#if pendingGlbImports.size > 0}
          <span class="kb-badge mono">{pendingGlbImports.size} glb{pendingGlbImports.size !== 1 ? 's' : ''}</span>
        {/if}
      </div>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
    <div class="row" style="margin-top: 0.75rem; gap: 0.5rem;">
      <button class="secondary" onclick={importAsNewKb} disabled={!kbPreview || busy} title="Create a separate graph (enables Jump navigation)">
        {busy ? 'importing…' : 'as new graph'}
      </button>
      <button class="primary" onclick={importKb} disabled={!kbPreview || busy}>
        {busy ? 'importing…' : 'import →'}
      </button>
    </div>
  </div>
{/if}

{#if mode === 'drive'}
  <div class="card gcard">
    {#if !googleReady}
      <p class="hint">set a Google OAuth client ID in <a href="/settings">settings</a> first.</p>
    {:else if driveLoading}
      <p class="hint mono">loading files…</p>
    {:else if driveFiles.length === 0}
      <p class="hint">no .ttl files found in your drive. export your graph first.</p>
      <button onclick={loadDriveFiles} style="margin-top: 0.5rem;">refresh</button>
    {:else}
      <p class="sub" style="margin-bottom: 0.75rem;">select a .ttl file to import:</p>
      <div class="drive-list">
        {#each driveFiles as f (f.id)}
          <button
            class="drive-item"
            class:selected={driveSelected?.id === f.id}
            onclick={() => (driveSelected = f)}
          >
            <span class="drive-name">{f.name}</span>
            <span class="drive-meta mono">{new Date(f.modifiedTime).toLocaleDateString()}</span>
          </button>
        {/each}
      </div>
      <div class="row" style="margin-top: 0.75rem;">
        <button onclick={loadDriveFiles}>refresh</button>
        <button class="primary" onclick={importFromDrive} disabled={!driveSelected || busy}>
          {busy ? phase || 'importing…' : 'import selected →'}
        </button>
      </div>
      {#if error}<p class="err">{error}</p>{/if}
    {/if}
  </div>
{/if}

{#if mode === 'calendar'}
  <div class="card gcard">
    <!-- Sub-tabs for calendar sources -->
    <div class="cal-source-tabs">
      <button class:active={calSource === 'google'} onclick={() => calSource = 'google'}>Google</button>
      <button class:active={calSource === 'indico'} onclick={() => calSource = 'indico'}>Indico</button>
      <button class:active={calSource === 'ical'} onclick={() => calSource = 'ical'}>iCal Link</button>
    </div>

    {#if calSource === 'google'}
      {#if !googleReady}
        <p class="hint">set a Google OAuth client ID in <a href="/settings">settings</a> first.</p>
      {:else if calLoading}
        <p class="hint mono">loading calendars…</p>
      {:else}
        <p class="sub" style="margin-bottom: 0.75rem;">select calendars and date range to import:</p>

        <div class="cal-list">
          {#each calendars as cal (cal.id)}
            <label class="cal-item">
              <input
                type="checkbox"
                checked={selectedCalendarIds.has(cal.id)}
                onchange={() => toggleCalendar(cal.id)}
              />
              <span
                class="cal-dot"
                style="background: {cal.backgroundColor ?? 'var(--accent)'};"
              ></span>
              <span class="cal-name">{cal.summary}</span>
              {#if cal.summary === KB_CALENDAR_NAME}
                <span class="cal-badge mono">Reckons.AI</span>
              {/if}
            </label>
          {/each}
        </div>

        <div class="date-range">
          <label class="field">
            <span class="lbl mono">from</span>
            <input type="date" bind:value={calDateFrom} />
          </label>
          <label class="field">
            <span class="lbl mono">to</span>
            <input type="date" bind:value={calDateTo} />
          </label>
        </div>

        <div class="row" style="margin-top: 0.75rem;">
          <button onclick={loadCalendars}>refresh</button>
          <button
            class="primary"
            onclick={importCalendarEvents}
            disabled={selectedCalendarIds.size === 0 || calImporting}
          >
            {calImporting ? `importing ${calImportCount} events…` : 'import events →'}
          </button>
        </div>
        {#if error}<p class="err">{error}</p>{/if}
      {/if}

    {:else if calSource === 'indico'}
      <p class="sub" style="margin-bottom: 0.75rem;">
        Fetch community events from your Indico server.
        {#if !settings().indicoServerUrl}
          <a href="/settings">Configure server in Settings →</a>
        {/if}
      </p>
      {#if settings().indicoServerUrl}
        <p class="hint mono">{settings().indicoServerUrl}</p>
        <div class="row" style="margin-top: 0.75rem;">
          <button
            class="primary"
            onclick={importIndicoEvents}
            disabled={indicoImporting}
          >
            {indicoImporting ? `importing…` : 'fetch & import events →'}
          </button>
        </div>
        {#if indicoImportResult}
          <p class="hint mono ok">{indicoImportResult}</p>
        {/if}
      {:else}
        <p class="hint">No Indico server configured. Add your server URL in <a href="/settings">Settings</a>.</p>
      {/if}
      {#if error}<p class="err">{error}</p>{/if}

    {:else if calSource === 'ical'}
      <p class="sub" style="margin-bottom: 0.75rem;">
        Import events from any public iCal (.ics) URL — Google Calendar, Outlook, etc.
      </p>
      <label class="field">
        <span class="lbl mono">iCal URL</span>
        <input type="url" bind:value={icalUrl} placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" />
      </label>
      <div class="row" style="margin-top: 0.75rem;">
        <button
          class="primary"
          onclick={importICalEvents}
          disabled={!icalUrl.trim() || icalImporting}
        >
          {icalImporting ? 'importing…' : 'import from iCal →'}
        </button>
      </div>
      {#if icalImportResult}
        <p class="hint mono ok">{icalImportResult}</p>
      {/if}
      {#if error}<p class="err">{error}</p>{/if}
    {/if}
  </div>
{/if}

<style>
  .head { margin-bottom: 1.25rem; }
  .kicker {
    color: var(--accent);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .sub { color: var(--muted); margin-top: 0.5rem; }
  .tabs {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .tabs button {
    padding: 0.45rem 0.95rem;
    font-size: 0.75rem;
    text-transform: lowercase;
    letter-spacing: 0.05em;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .tabs button.active {
    background: var(--accent);
    color: #0a0a0b;
    border-color: var(--accent);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .lbl {
    color: var(--muted);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .backend { color: var(--muted); font-size: 0.75rem; }
  .backend strong { color: var(--ink); }
  .action-group { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .paste-btn {
    font-size: 0.72rem;
    padding: 0.45rem 0.85rem;
    border-radius: 999px;
    color: var(--muted);
    border: 1px solid var(--line);
    background: var(--surface);
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .paste-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .paste-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Manual triples form */
  .triples-list { display: flex; flex-direction: column; gap: 0.45rem; }
  .triple-entry {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr auto;
    gap: 0.4rem;
    align-items: center;
  }
  .triple-entry input { font-size: 0.82rem; }
  .te-del {
    background: none; border: none; color: var(--muted);
    cursor: pointer; font-size: 0.85rem; padding: 0.2rem 0.4rem;
    border-radius: var(--rad-sm); transition: color 0.12s;
  }
  .te-del:hover { color: var(--danger); }
  .add-triple-btn {
    align-self: flex-start;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    padding: 0.35rem 0.8rem;
    border-radius: 999px;
    color: var(--accent);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    cursor: pointer;
    transition: background 0.12s;
  }
  .add-triple-btn:hover { background: var(--accent); color: #fff; }
  .hint { color: var(--muted); font-size: 0.75rem; margin: 0; }
  .err { color: var(--danger); font-family: var(--font-mono); font-size: 0.85rem; }

  /* KB file panel */
  .kb-file-label { display: flex; flex-direction: column; gap: 0.35rem; }
  .kb-preview {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.5rem;
    padding: 0.55rem 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .kb-count { font-size: 0.85rem; color: var(--fg); }
  .kb-badge {
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--accent);
  }

  /* Google panels */
  .gcard { margin-top: 1rem; }
  .drive-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 280px;
    overflow-y: auto;
  }
  .drive-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.85rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    cursor: pointer;
    text-align: left;
    gap: 1rem;
    transition: border-color 0.15s;
  }
  .drive-item.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .drive-name { font-family: var(--font-mono); font-size: 0.82rem; }
  .drive-meta { color: var(--muted); font-size: 0.7rem; white-space: nowrap; }

  .cal-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
  }
  .cal-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    cursor: pointer;
  }
  .cal-item:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
  .cal-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .cal-name { flex: 1; font-size: 0.85rem; }
  .cal-badge {
    font-size: 0.65rem;
    padding: 0.15rem 0.4rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
  }
  .date-range {
    display: flex;
    gap: 1rem;
  }
  .date-range .field { flex: 1; }
  input[type='date'] {
    font-family: var(--font-mono);
    font-size: 0.82rem;
  }

  /* ── Vault batch mode ───────────────────────────────────────────────────── */
  .vault-progress-bar {
    height: 4px;
    background: var(--line);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 0.4rem;
  }
  .vault-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
    border-radius: 2px;
  }

  .vault-queue {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    overflow: hidden;
    margin-bottom: 0.75rem;
  }

  .vault-item {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    font-size: 0.82rem;
  }
  .vault-item:last-child { border-bottom: none; }
  .vault-item.vault-done       { background: #6ab68a0a; }
  .vault-item.vault-error      { background: #d4726d0a; }
  .vault-item.vault-parsing,
  .vault-item.vault-extracting { background: var(--accent-soft); }

  .vault-icon {
    font-size: 0.75rem;
    width: 14px;
    flex-shrink: 0;
    margin-top: 0.1rem;
    color: var(--muted);
  }
  .vault-done   .vault-icon { color: var(--ok); }
  .vault-error  .vault-icon { color: var(--danger); }
  .vault-parsing .vault-icon,
  .vault-extracting .vault-icon { color: var(--accent); }

  .vault-item-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .vault-filename { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.78rem; }
  .vault-links    { color: var(--muted); font-size: 0.68rem; }
  .vault-error    { color: var(--danger); font-size: 0.72rem; }
  .vault-review   { color: var(--accent); font-size: 0.72rem; text-decoration: none; }
  .vault-review:hover { text-decoration: underline; }

  .vault-status { font-size: 0.65rem; color: var(--muted); flex-shrink: 0; align-self: center; }
  .vault-done .vault-status     { color: var(--ok); }
  .vault-error .vault-status    { color: var(--danger); }

  .vault-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .btn-primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--rad-sm);
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
  }
  .btn-primary:hover { opacity: 0.85; }
  .btn-secondary {
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.85rem;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .btn-secondary:hover { color: var(--ink-2); }

  /* ── Calendar source sub-tabs ──────────────────────────────────────────── */
  .cal-source-tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--line);
    padding-bottom: 0.5rem;
  }
  .cal-source-tabs button {
    padding: 0.35rem 0.75rem;
    font-size: 0.72rem;
    font-family: var(--font-mono);
    text-transform: lowercase;
    border-radius: var(--rad-sm);
    background: none;
    border: 1px solid transparent;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
  }
  .cal-source-tabs button:hover { color: var(--ink); }
  .cal-source-tabs button.active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .ok { color: var(--ok); }

  /* ── Repo ── */
  .repo-input-row {
    display: flex;
    gap: 0.5rem;
  }
  .repo-input-row input { flex: 1; }
  .repo-input-row button { white-space: nowrap; }
  .repo-preview {
    margin-top: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--line);
    border-radius: var(--rad);
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .repo-preview .btn-primary { margin-top: 0.5rem; align-self: flex-start; }

  /* ── Mobile ── */
  @media (max-width: 500px) {
    .tabs { gap: 0.2rem; }
    .tabs button { padding: 0.35rem 0.65rem; font-size: 0.68rem; }
    .triple-entry { grid-template-columns: 1fr; }
    .row { flex-direction: column; align-items: stretch; gap: 0.5rem; }
    .action-group { justify-content: stretch; }
    .action-group > * { flex: 1; text-align: center; }
  }
</style>
