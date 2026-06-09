/**
 * Side panel — Compare + Ingest views.
 */
import type {
  ExtensionState, ExtractedTriple, DiffSummary, PopupRequest, BackgroundEvent,
} from './types';

let state: ExtensionState | null = null;
let error: string | null = null;
let currentTab: chrome.tabs.Tab | null = null;
let view: 'compare' | 'ingest' = 'compare';
let focusPrompt = '';
let ingestStatus: { kind: 'ok' | 'err'; msg: string } | null = null;
let ingestBusy = false;
let pasteOpen = false;
let pasteResponse = '';
let pasteCopied = false;

const collapsed = new Set<string>();

function send(msg: PopupRequest): Promise<BackgroundEvent> {
  return chrome.runtime.sendMessage(msg);
}

chrome.runtime.onMessage.addListener((event: BackgroundEvent) => {
  if (event.type === 'STATE') {
    state = event.state;
    // Only clear error when a fresh analysis is starting, not when it ends.
    // (The finally-broadcast after a failed analysis would otherwise wipe the error.)
    if (event.state.analyzing) error = null;
  }
  if (event.type === 'ERROR') { error = event.message; }
  if (event.type === 'INGEST_RESULT') {
    ingestBusy = false;
    const ok = event.status === 'started' || event.status === 'opened';
    ingestStatus = {
      kind: ok ? 'ok' : 'err',
      msg: event.message ?? (event.status === 'started' ? 'Ingestion started in Reckons.AI.' : event.status === 'opened' ? 'Ingest page opened in background tab.' : 'Error.'),
    };
  }
  render();
});

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  document.getElementById('root')!.innerHTML = buildHTML();
  attachHandlers();
}

function buildHTML(): string {
  if (!state) return `<div class="empty"><strong>Loading…</strong></div>`;

  if (!state.settings.apiKey) {
    return `<div class="nokey">No API key set.<br><a id="lnk-settings">Open settings →</a><br><small>Or use <strong>use any LLM</strong> in the Compare tab to copy the prompt and paste a response — no key needed.</small></div>`;
  }

  let html = '';

  // Page bar
  if (currentTab?.url) {
    html += `<div class="page-bar">
      <div class="page-bar-title">${esc(currentTab.title ?? 'Untitled')}</div>
      <div class="page-bar-url">${esc(currentTab.url)}</div>
    </div>`;
  }

  // Tab switcher
  html += `<div class="tab-bar">
    <button class="tab-btn ${view === 'compare' ? 'active' : ''}" data-view="compare">Compare</button>
    <button class="tab-btn ${view === 'ingest'  ? 'active' : ''}" data-view="ingest">Ingest</button>
  </div>`;

  html += view === 'ingest' ? buildIngestView() : buildCompareView();
  return html;
}

// ── Paste-response inline section ────────────────────────────────────────────

function buildPasteArea(): string {
  if (!pasteOpen) {
    return `<button class="paste-toggle" id="btn-paste-open">use any LLM ▾</button>`;
  }
  return `
    <div class="paste-area">
      <div class="paste-header">
        <span class="paste-lbl">Prompt copied to clipboard.</span>
        <span class="paste-lbl">Paste it into Claude.ai, ChatGPT, Gemini, etc. — then paste the JSON response below.</span>
        <button class="paste-copy-again ${pasteCopied ? 'copied' : ''}" id="btn-paste-copy-again">
          ${pasteCopied ? '✓ copied' : 'copy again'}
        </button>
      </div>
      <textarea id="paste-response" class="paste-response-area"
        placeholder='[{"subject":"...","predicate":"...","object":"...",...}]'
        rows="6">${esc(pasteResponse)}</textarea>
      <div class="paste-actions">
        <button class="paste-submit-btn" id="btn-paste-submit" ${pasteResponse.trim() ? '' : 'disabled'}>
          Process Response
        </button>
        <button class="paste-cancel" id="btn-paste-close">cancel</button>
      </div>
    </div>`;
}

// ── Compare ───────────────────────────────────────────────────────────────────

function buildCompareView(): string {
  const { result, analyzing } = state!;
  let html = '';

  // Error banner (persists until next analysis attempt)
  if (error) {
    html += `<div class="error-box">
      <strong>Error</strong><br>${esc(error)}
    </div>`;
  }

  if (analyzing) {
    html += `<div class="analyze-busy">
      <span class="spinner"></span> Analyzing page…
    </div>`;
    return html;
  }

  if (!result) {
    // No analysis — show focus input + big CTA
    html += `<div class="cta-area">
      <div class="cta-text">Compare this page against your knowledge base to see what it confirms, contradicts, or adds.</div>
      <div class="focus-field">
        <label class="focus-label" for="focus-input">Focus <span class="focus-optional">(optional)</span></label>
        <textarea id="focus-input" class="focus-textarea" rows="2"
          placeholder="e.g. focus on the Philosophical_alignment section"
        >${esc(focusPrompt)}</textarea>
      </div>
      <button class="cta-btn" id="btn-analyze">&#x1F50D; Analyze Page</button>
      ${buildPasteArea()}
    </div>`;
    return html;
  }

  // Has result — compact toolbar + inline focus for re-analysis
  html += `<div class="toolbar">
    <div class="toolbar-status">Analyzed</div>
    <button class="toolbar-btn" id="btn-refresh">&#x21BA; Re-analyze</button>
    ${state!.highlightsActive
      ? `<button class="toolbar-btn active" id="btn-hl">&#x2713; Highlights</button>`
      : `<button class="toolbar-btn" id="btn-hl">Highlight</button>`
    }
  </div>
  <div class="focus-bar">
    <textarea id="focus-input" class="focus-textarea focus-compact" rows="1"
      placeholder="Focus hint for re-analyze (optional)"
    >${esc(focusPrompt)}</textarea>
  </div>
  <div class="paste-toolbar-wrap">${buildPasteArea()}</div>`;

  if (result.summary) {
    if (typeof result.summary === 'object') {
      const s = result.summary as DiffSummary;
      html += `<div class="summary-cards">`;
      if (s.new)         html += `<div class="summary-card new-card"><div class="sc-head">New Information</div><div class="sc-body">${esc(s.new)}</div></div>`;
      if (s.reinforcing) html += `<div class="summary-card reinforce-card"><div class="sc-head">Reinforcing</div><div class="sc-body">${esc(s.reinforcing)}</div></div>`;
      if (s.conflicting) html += `<div class="summary-card conflict-card"><div class="sc-head">Conflicts &amp; Refinements</div><div class="sc-body">${esc(s.conflicting)}</div></div>`;
      html += `</div>`;
    } else {
      html += `<div class="summary">${esc(result.summary as string)}</div>`;
    }
  }

  const conflicts  = result.triples.filter(t => t.kind === 'conflict');
  const reinforces = result.triples.filter(t => t.kind === 'reinforce');
  const news       = result.triples.filter(t => t.kind === 'new');

  html += `<div class="counts">
    <div class="count-item">
      <div class="count-dot conflict"></div>
      <span class="count-num">${conflicts.length}</span>
      <span class="count-label">conflict${conflicts.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="count-item">
      <div class="count-dot reinforce"></div>
      <span class="count-num">${reinforces.length}</span>
      <span class="count-label">reinforce${reinforces.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="count-item">
      <div class="count-dot new"></div>
      <span class="count-num">${news.length}</span>
      <span class="count-label">new</span>
    </div>
  </div>`;

  if (conflicts.length > 0)  html += buildSection('conflict',  'Conflicts',     conflicts);
  if (reinforces.length > 0) html += buildSection('reinforce', 'Reinforces KB', reinforces);
  if (news.length > 0)       html += buildSection('new',       'New Knowledge', news);

  return html;
}

function buildSection(kind: string, label: string, triples: ExtractedTriple[]): string {
  const collapsed_ = collapsed.has(kind);
  return `
    <div class="section ${kind}">
      <div class="section-head ${collapsed_ ? 'collapsed' : ''}" data-section="${kind}">
        ${label} <span class="section-count">(${triples.length})</span>
        <span class="chevron">▼</span>
      </div>
      <div class="section-body ${collapsed_ ? 'hidden' : ''}">
        ${triples.map(t => `
          <div class="triple-row ${kind}">
            <div class="triple-dot ${kind}"></div>
            <div class="triple-body">
              <div class="triple-spo">
                <strong>${esc(t.subject)}</strong>
                <span class="sep">·</span>${esc(t.predicate)}<span class="sep">·</span>
                <strong>${esc(t.object)}</strong>
              </div>
              ${t.conflictNote ? `<div class="triple-conflict-note">${esc(t.conflictNote)}</div>` : ''}
              ${t.textSpan    ? `<div class="triple-span">${esc(t.textSpan.slice(0, 140))}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

function buildIngestView(): string {
  const pageUrl   = currentTab?.url ?? '';
  const pageTitle = currentTab?.title ?? '';
  const { result } = state!;

  let html = `<div class="ingest-view">`;

  html += `<div class="ingest-field">
    <div class="ingest-label">URL</div>
    <div class="ingest-url-box">${esc(pageUrl)}</div>
  </div>`;

  if (pageTitle) html += `<div class="ingest-field">
    <div class="ingest-label">Title</div>
    <div class="ingest-title-box">${esc(pageTitle)}</div>
  </div>`;

  if (result) {
    const nC = result.triples.filter(t => t.kind === 'conflict').length;
    const nR = result.triples.filter(t => t.kind === 'reinforce').length;
    const nN = result.triples.filter(t => t.kind === 'new').length;
    html += `<div class="ingest-field">
      <div class="ingest-label">Triples from Compare</div>
      <div class="ingest-counts">
        <span class="ic conflict">${nC} conflict${nC !== 1 ? 's' : ''}</span>
        <span class="ic reinforce">${nR} reinforce${nR !== 1 ? 's' : ''}</span>
        <span class="ic new">${nN} new</span>
      </div>
    </div>`;
  } else {
    html += `<div class="ingest-note">Run Compare first to preview triples, or ingest the URL directly.</div>`;
  }

  if (ingestStatus) {
    html += `<div class="ingest-status ${ingestStatus.kind}">${esc(ingestStatus.msg)}</div>`;
  }

  html += `<button class="ingest-action-btn" id="btn-do-ingest" ${ingestBusy || !pageUrl ? 'disabled' : ''}>
    ${ingestBusy ? '<span class="spinner"></span> Ingesting…' : '⬇ Ingest This Page'}
  </button>
  <div class="ingest-hint">Reckons.AI must be open for direct ingest. Otherwise the ingest page opens as a background tab.</div>`;

  html += `</div>`;
  return html;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function attachHandlers() {
  document.getElementById('btn-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('lnk-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Use-any-LLM paste handlers
  async function fetchAndCopyPrompt() {
    const resp = await send({ type: 'BUILD_PROMPT', focus: focusPrompt || undefined });
    if (resp.type === 'ERROR') { error = resp.message; render(); return; }
    if (resp.type === 'PROMPT_READY') {
      const prompt = (resp as { type: 'PROMPT_READY'; prompt: string }).prompt;
      await navigator.clipboard.writeText(prompt).catch(() => {});
      pasteCopied = true;
      pasteOpen = true;
      render();
      setTimeout(() => { pasteCopied = false; render(); }, 2000);
    }
  }

  document.getElementById('btn-paste-open')?.addEventListener('click', fetchAndCopyPrompt);
  document.getElementById('btn-paste-copy-again')?.addEventListener('click', fetchAndCopyPrompt);
  document.getElementById('paste-response')?.addEventListener('input', (e) => {
    pasteResponse = (e.target as HTMLTextAreaElement).value;
    // Re-render to enable/disable submit button
    const btn = document.getElementById('btn-paste-submit') as HTMLButtonElement | null;
    if (btn) btn.disabled = !pasteResponse.trim();
  });
  document.getElementById('btn-paste-submit')?.addEventListener('click', async () => {
    const text = pasteResponse.trim();
    if (!text) return;
    pasteOpen = false;
    pasteResponse = '';
    const resp = await send({ type: 'PARSE_RESPONSE', text });
    if (resp.type === 'STATE') { state = resp.state; }
    render();
  });
  document.getElementById('btn-paste-close')?.addEventListener('click', () => {
    pasteOpen = false;
    pasteResponse = '';
    render();
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      view = (btn as HTMLElement).dataset.view as 'compare' | 'ingest';
      render();
    });
  });

  // Sync textarea value to focusPrompt before triggering analysis
  const syncFocus = () => {
    focusPrompt = (document.getElementById('focus-input') as HTMLTextAreaElement)?.value ?? focusPrompt;
  };
  document.getElementById('focus-input')?.addEventListener('input', syncFocus);

  const runAnalyze = async () => {
    syncFocus();
    error = null;
    const resp = await send({ type: 'ANALYZE_PAGE', focus: focusPrompt || undefined });
    if (resp.type === 'STATE') { state = resp.state; render(); }
  };

  document.getElementById('btn-analyze')?.addEventListener('click', runAnalyze);
  document.getElementById('btn-refresh')?.addEventListener('click', runAnalyze);

  document.getElementById('btn-hl')?.addEventListener('click', async () => {
    const resp = state?.highlightsActive
      ? await send({ type: 'CLEAR_HIGHLIGHTS' })
      : await send({ type: 'HIGHLIGHT_PAGE' });
    if (resp.type === 'STATE') { state = resp.state; render(); }
  });

  document.querySelectorAll('.section-head').forEach(el => {
    el.addEventListener('click', () => {
      const kind = (el as HTMLElement).dataset.section!;
      collapsed.has(kind) ? collapsed.delete(kind) : collapsed.add(kind);
      render();
    });
  });

  document.getElementById('btn-do-ingest')?.addEventListener('click', async () => {
    const url = currentTab?.url ?? '';
    if (!url) return;
    ingestBusy = true;
    ingestStatus = null;
    render();
    const resp = await send({
      type: 'DO_INGEST',
      url,
      title: currentTab?.title ?? '',
      // Pass already-extracted triples so the app doesn't re-analyze
      triples: (state?.result?.triples ?? []).map(t => ({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        kind: t.kind,
      })),
    });
    if (resp.type === 'INGEST_RESULT') {
      ingestBusy = false;
      const ok = resp.status === 'started' || resp.status === 'opened';
      ingestStatus = { kind: ok ? 'ok' : 'err', msg: resp.message ?? resp.status };
      render();
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  const resp = await send({ type: 'GET_STATE' });
  if (resp.type === 'STATE') state = resp.state;
  render();
}

init();
