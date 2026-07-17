/**
 * Side panel — Compare + Ingest + Session views.
 *
 * Compare: analyze the current page against KB.
 * Session: aggregate findings across multiple pages during research.
 * Ingest: send triples to Reckons.AI.
 */
import type {
  ExtensionState, AnalysisResult, ExtractedTriple, DiffSummary, PopupRequest, BackgroundEvent,
  LiveSession, LiveClaim, LiveVerdict,
} from './types';

let state: ExtensionState | null = null;
let error: string | null = null;
let currentTab: chrome.tabs.Tab | null = null;
let view: 'compare' | 'ingest' | 'session' | 'live' = 'compare';
let focusPrompt = '';
let ingestStatus: { kind: 'ok' | 'err'; msg: string } | null = null;
let ingestBusy = false;
let pasteOpen = false;
let pasteResponse = '';
let pasteCopied = false;

const collapsed = new Set<string>();
const sessionCollapsed = new Set<string>();

function send(msg: PopupRequest): Promise<BackgroundEvent> {
  return chrome.runtime.sendMessage(msg);
}

chrome.runtime.onMessage.addListener((event: BackgroundEvent) => {
  if (event.type === 'STATE') {
    const wasLive = state?.liveStreaming;
    state = event.state;
    if (event.state.analyzing) error = null;
    // Auto-switch to Live tab when streaming starts
    if (!wasLive && event.state.liveStreaming) view = 'live';
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
  // Escape for BOTH text and attribute contexts: this value is interpolated into
  // data-…="${esc(url)}" attributes, so quotes must be escaped too — otherwise a URL
  // containing a quote breaks out of the attribute (js/incomplete-html-attribute-sanitization).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const sessionCount = state.session.pages.length;
  const fcActive = state.liveStreaming;
  const fcClaimCount = state.liveSession?.claims?.length ?? 0;
  html += `<div class="tab-bar">
    <button class="tab-btn ${view === 'compare' ? 'active' : ''}" data-view="compare">Compare</button>
    <button class="tab-btn ${view === 'session' ? 'active' : ''}" data-view="session">Session${sessionCount > 0 ? ` <span class="tab-badge">${sessionCount}</span>` : ''}</button>
    <button class="tab-btn ${view === 'live' ? 'active' : ''}" data-view="live">Live${fcActive ? ' <span class="tab-badge live-badge">ON</span>' : (fcClaimCount > 0 ? ` <span class="tab-badge">${fcClaimCount}</span>` : '')}</button>
    <button class="tab-btn ${view === 'ingest'  ? 'active' : ''}" data-view="ingest">Ingest</button>
  </div>`;

  if (view === 'ingest') html += buildIngestView();
  else if (view === 'session') html += buildSessionView();
  else if (view === 'live') html += buildLiveView();
  else html += buildCompareView();

  return html;
}

// ── At-a-glance bar ─────────────────────────────────────────────────────────

function buildGlanceBar(conflicts: number, reinforces: number, news: number): string {
  const total = conflicts + reinforces + news;
  if (total === 0) return '';
  const cPct = Math.round((conflicts / total) * 100);
  const rPct = Math.round((reinforces / total) * 100);
  const nPct = 100 - cPct - rPct;
  return `<div class="glance-bar" title="${conflicts} conflicts, ${reinforces} reinforcing, ${news} new">
    ${cPct > 0 ? `<div class="glance-seg conflict" style="width:${cPct}%"></div>` : ''}
    ${rPct > 0 ? `<div class="glance-seg reinforce" style="width:${rPct}%"></div>` : ''}
    ${nPct > 0 ? `<div class="glance-seg new" style="width:${nPct}%"></div>` : ''}
  </div>`;
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
    html += `<div class="cta-area">
      <div class="cta-text">Compare this page against your graph to see what it confirms, contradicts, or adds.</div>
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

  // Has result — toolbar
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

  const conflicts  = result.triples.filter(t => t.kind === 'conflict');
  const reinforces = result.triples.filter(t => t.kind === 'reinforce');
  const news       = result.triples.filter(t => t.kind === 'new');

  // At-a-glance bar
  html += buildGlanceBar(conflicts.length, reinforces.length, news.length);

  // Summary cards — hero position
  if (result.summary) {
    if (typeof result.summary === 'object') {
      const s = result.summary as DiffSummary;
      html += `<div class="summary-cards">`;
      if (s.conflicting) html += `<div class="summary-card conflict-card"><div class="sc-head"><span class="sc-dot conflict"></span>Conflicts &amp; Refinements</div><div class="sc-body">${esc(s.conflicting)}</div></div>`;
      if (s.new)         html += `<div class="summary-card new-card"><div class="sc-head"><span class="sc-dot new"></span>New Information</div><div class="sc-body">${esc(s.new)}</div></div>`;
      if (s.reinforcing) html += `<div class="summary-card reinforce-card"><div class="sc-head"><span class="sc-dot reinforce"></span>Reinforcing</div><div class="sc-body">${esc(s.reinforcing)}</div></div>`;
      html += `</div>`;
    } else {
      html += `<div class="summary">${esc(result.summary as string)}</div>`;
    }
  }

  // Counts
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
  if (reinforces.length > 0) html += buildSection('reinforce', 'Reinforces Graph', reinforces);
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

// ── Session ─────────────────────────────────────────────────────────────────

function buildSessionView(): string {
  const { session: sess } = state!;
  let html = '';

  if (sess.pages.length === 0) {
    html += `<div class="session-empty">
      <div class="session-empty-icon">&#x1F4DA;</div>
      <div class="session-empty-title">No pages analyzed yet</div>
      <div class="session-empty-text">Use the <strong>Compare</strong> tab to analyze pages. Each analysis is automatically added to your research session.</div>
    </div>`;
    return html;
  }

  // Aggregate counts
  const allTriples = sess.pages.flatMap(p => p.triples);
  const totalConflicts  = allTriples.filter(t => t.kind === 'conflict').length;
  const totalReinforces = allTriples.filter(t => t.kind === 'reinforce').length;
  const totalNew        = allTriples.filter(t => t.kind === 'new').length;

  // Session header
  html += `<div class="session-header">
    <div class="session-meta">
      <span class="session-pages-count">${sess.pages.length} page${sess.pages.length !== 1 ? 's' : ''}</span>
      <span class="session-sep">·</span>
      <span class="session-triple-count">${allTriples.length} facts</span>
    </div>
    <div class="session-actions">
      <button class="toolbar-btn" id="btn-session-clear" title="Clear session">Clear</button>
    </div>
  </div>`;

  // Aggregate at-a-glance
  html += buildGlanceBar(totalConflicts, totalReinforces, totalNew);

  // Aggregate counts row
  html += `<div class="counts">
    <div class="count-item">
      <div class="count-dot conflict"></div>
      <span class="count-num">${totalConflicts}</span>
      <span class="count-label">conflict${totalConflicts !== 1 ? 's' : ''}</span>
    </div>
    <div class="count-item">
      <div class="count-dot reinforce"></div>
      <span class="count-num">${totalReinforces}</span>
      <span class="count-label">reinforce${totalReinforces !== 1 ? 's' : ''}</span>
    </div>
    <div class="count-item">
      <div class="count-dot new"></div>
      <span class="count-num">${totalNew}</span>
      <span class="count-label">new</span>
    </div>
  </div>`;

  // Aggregate summaries — collect from all pages
  const aggNew: string[] = [];
  const aggReinforcing: string[] = [];
  const aggConflicting: string[] = [];
  for (const page of sess.pages) {
    const title = shortTitle(page.title || page.url);
    if (typeof page.summary === 'object') {
      if (page.summary.new) aggNew.push(`<strong>${esc(title)}</strong>: ${esc(page.summary.new)}`);
      if (page.summary.reinforcing) aggReinforcing.push(`<strong>${esc(title)}</strong>: ${esc(page.summary.reinforcing)}`);
      if (page.summary.conflicting) aggConflicting.push(`<strong>${esc(title)}</strong>: ${esc(page.summary.conflicting)}`);
    }
  }

  if (aggConflicting.length > 0 || aggNew.length > 0 || aggReinforcing.length > 0) {
    html += `<div class="summary-cards">`;
    if (aggConflicting.length > 0) {
      html += `<div class="summary-card conflict-card">
        <div class="sc-head"><span class="sc-dot conflict"></span>Conflicts Across Pages</div>
        <div class="sc-body">${aggConflicting.join('<br>')}</div>
      </div>`;
    }
    if (aggNew.length > 0) {
      html += `<div class="summary-card new-card">
        <div class="sc-head"><span class="sc-dot new"></span>New Information Across Pages</div>
        <div class="sc-body">${aggNew.join('<br>')}</div>
      </div>`;
    }
    if (aggReinforcing.length > 0) {
      html += `<div class="summary-card reinforce-card">
        <div class="sc-head"><span class="sc-dot reinforce"></span>Reinforced Across Pages</div>
        <div class="sc-body">${aggReinforcing.join('<br>')}</div>
      </div>`;
    }
    html += `</div>`;
  }

  // Per-page breakdown
  html += `<div class="session-pages-heading">Pages</div>`;
  for (let i = 0; i < sess.pages.length; i++) {
    const page = sess.pages[i];
    const pConflicts  = page.triples.filter(t => t.kind === 'conflict').length;
    const pReinforces = page.triples.filter(t => t.kind === 'reinforce').length;
    const pNew        = page.triples.filter(t => t.kind === 'new').length;
    const key = `page-${i}`;
    const isCollapsed = sessionCollapsed.has(key);

    html += `<div class="session-page">
      <div class="session-page-head ${isCollapsed ? 'collapsed' : ''}" data-session-page="${key}">
        <div class="session-page-info">
          <div class="session-page-title">${esc(shortTitle(page.title || page.url))}</div>
          <div class="session-page-pills">
            ${pConflicts > 0 ? `<span class="pill conflict">${pConflicts}</span>` : ''}
            ${pReinforces > 0 ? `<span class="pill reinforce">${pReinforces}</span>` : ''}
            ${pNew > 0 ? `<span class="pill new">${pNew}</span>` : ''}
          </div>
        </div>
        <div class="session-page-actions">
          <button class="session-page-remove" data-remove-url="${esc(page.url)}" title="Remove from session">✕</button>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="session-page-body ${isCollapsed ? 'hidden' : ''}">
        ${buildGlanceBar(pConflicts, pReinforces, pNew)}
        ${page.triples.map(t => `
          <div class="triple-row ${t.kind} compact">
            <div class="triple-dot ${t.kind}"></div>
            <div class="triple-body">
              <div class="triple-spo">
                <strong>${esc(t.subject)}</strong>
                <span class="sep">·</span>${esc(t.predicate)}<span class="sep">·</span>
                <strong>${esc(t.object)}</strong>
              </div>
              ${t.conflictNote ? `<div class="triple-conflict-note">${esc(t.conflictNote)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  // Ingest session button
  if (totalNew > 0 || totalConflicts > 0) {
    html += `<div class="session-ingest-bar">
      <button class="ingest-action-btn" id="btn-session-ingest" ${ingestBusy ? 'disabled' : ''}>
        ${ingestBusy ? '<span class="spinner"></span> Ingesting…' : `⬇ Ingest All New (${totalNew} facts)`}
      </button>
    </div>`;
  }

  if (ingestStatus) {
    html += `<div class="ingest-status-wrap"><div class="ingest-status ${ingestStatus.kind}">${esc(ingestStatus.msg)}</div></div>`;
  }

  return html;
}

function shortTitle(title: string): string {
  if (title.length <= 50) return title;
  return title.slice(0, 47) + '…';
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
      <div class="ingest-label">Facts from Compare</div>
      <div class="ingest-counts">
        <span class="ic conflict">${nC} conflict${nC !== 1 ? 's' : ''}</span>
        <span class="ic reinforce">${nR} reinforce${nR !== 1 ? 's' : ''}</span>
        <span class="ic new">${nN} new</span>
      </div>
    </div>`;
  } else {
    html += `<div class="ingest-note">Run Compare first to preview facts, or ingest the URL directly.</div>`;
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

// ── Live view ────────────────────────────────────────────────────────────────

function buildLiveView(): string {
  const { liveStreaming: active, liveSession: sess } = state!;
  let html = '';

  if (error) {
    html += `<div class="error-box"><strong>Error</strong><br>${esc(error)}</div>`;
  }

  if (!active && (!sess || sess.claims.length === 0)) {
    html += `<div class="cta-area">
      <div class="cta-text">Stream audio from the current tab and compare facts against your graph in real-time.</div>
      <div class="cta-text" style="font-size:11px;color:var(--ink3)">Works with YouTube, podcasts, lectures, meetings — any tab with audio. Uses local Whisper model by default, or Deepgram for real-time streaming.</div>
      <button class="cta-btn" id="btn-go-live">&#x1F534; Go Live</button>
    </div>`;
    return html;
  }

  // Active or has session data
  html += `<div class="toolbar">
    <div class="toolbar-status">${active ? '<span class="spinner"></span> Live' : 'Session ended'}</div>
    ${active
      ? `<button class="toolbar-btn" id="btn-stop-live" style="color:var(--conflict);border-color:rgba(239,68,68,0.4)">&#x25A0; Stop</button>`
      : `<button class="toolbar-btn" id="btn-go-live">&#x1F534; Go Live</button>`
    }
  </div>`;

  if (sess) {
    const confirmed  = sess.claims.filter(c => c.verdict === 'KB_CONFIRMED').length;
    const conflicts  = sess.claims.filter(c => c.verdict === 'KB_CONFLICT').length;
    const newClaims  = sess.claims.filter(c => c.verdict === 'KB_NEW').length;
    const unverified = sess.claims.filter(c => c.verdict === 'UNVERIFIABLE').length;

    // At-a-glance bar
    const total = confirmed + conflicts + newClaims + unverified;
    if (total > 0) {
      const cPct = Math.round((conflicts / total) * 100);
      const okPct = Math.round((confirmed / total) * 100);
      const nPct = Math.round((newClaims / total) * 100);
      const uPct = 100 - cPct - okPct - nPct;
      html += `<div class="glance-bar">
        ${cPct > 0 ? `<div class="glance-seg conflict" style="width:${cPct}%"></div>` : ''}
        ${okPct > 0 ? `<div class="glance-seg reinforce" style="width:${okPct}%"></div>` : ''}
        ${nPct > 0 ? `<div class="glance-seg new" style="width:${nPct}%"></div>` : ''}
        ${uPct > 0 ? `<div class="glance-seg" style="width:${uPct}%;background:#6b7280"></div>` : ''}
      </div>`;
    }

    // Counts
    html += `<div class="counts">
      <div class="count-item"><div class="count-dot conflict"></div><span class="count-num">${conflicts}</span><span class="count-label">conflict${conflicts !== 1 ? 's' : ''}</span></div>
      <div class="count-item"><div class="count-dot reinforce"></div><span class="count-num">${confirmed}</span><span class="count-label">confirmed</span></div>
      <div class="count-item"><div class="count-dot new"></div><span class="count-num">${newClaims}</span><span class="count-label">new</span></div>
    </div>`;

    // Claims list
    if (sess.claims.length > 0) {
      const sorted = [...sess.claims].reverse(); // newest first
      html += `<div class="session-pages-heading">Claims (${sorted.length})</div>`;
      for (const claim of sorted) {
        const kind = claim.verdict === 'KB_CONFIRMED' ? 'reinforce' : claim.verdict === 'KB_CONFLICT' ? 'conflict' : claim.verdict === 'KB_NEW' ? 'new' : '';
        const label = claim.verdict.replace('KB_', '').replace('_', ' ');
        html += `<div class="triple-row ${kind}" style="margin:3px 8px">
          <div class="triple-dot ${kind}"></div>
          <div class="triple-body">
            <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;color:var(--ink3);margin-bottom:2px">
              ${esc(label)}${claim.speaker ? ` &middot; ${esc(claim.speaker)}` : ''} &middot; ${claim.confidence}
            </div>
            <div class="triple-spo" style="font-style:italic">"${esc(claim.claim)}"</div>
            <div style="font-size:11px;color:var(--ink2);margin-top:2px">${esc(claim.explanation)}</div>
            ${claim.conflictNote ? `<div class="triple-conflict-note">${esc(claim.conflictNote)}</div>` : ''}
            <div class="triple-span">${esc(claim.triple.subject)} &middot; ${esc(claim.triple.predicate)} &middot; ${esc(claim.triple.object)}</div>
          </div>
        </div>`;
      }
    }

    // Ingest button
    if (newClaims > 0 || conflicts > 0) {
      html += `<div class="session-ingest-bar">
        <button class="ingest-action-btn" id="btn-fc-ingest" ${ingestBusy ? 'disabled' : ''}>
          ${ingestBusy ? '<span class="spinner"></span> Ingesting...' : `&#x2B07; Ingest New Claims (${newClaims})`}
        </button>
      </div>`;
    }
  }

  if (ingestStatus) {
    html += `<div class="ingest-status-wrap"><div class="ingest-status ${ingestStatus.kind}">${esc(ingestStatus.msg)}</div></div>`;
  }

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

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      view = (btn as HTMLElement).dataset.view as 'compare' | 'ingest' | 'session' | 'live';
      render();
    });
  });

  // Live tab handlers
  document.getElementById('btn-go-live')?.addEventListener('click', async () => {
    error = null;
    const resp = await send({ type: 'START_LIVE' });
    if (resp.type === 'STATE') { state = resp.state; }
    if (resp.type === 'ERROR') { error = resp.message; }
    render();
  });
  document.getElementById('btn-stop-live')?.addEventListener('click', async () => {
    const resp = await send({ type: 'STOP_LIVE' });
    if (resp.type === 'STATE') { state = resp.state; }
    render();
  });
  document.getElementById('btn-fc-ingest')?.addEventListener('click', async () => {
    ingestBusy = true;
    ingestStatus = null;
    render();
    const resp = await send({ type: 'INGEST_LIVE_CLAIMS', kinds: ['KB_NEW'] as any });
    if (resp.type === 'INGEST_RESULT') {
      ingestBusy = false;
      const ok = resp.status === 'started' || resp.status === 'opened';
      ingestStatus = { kind: ok ? 'ok' : 'err', msg: resp.message ?? resp.status };
      render();
    }
  });

  // Focus prompt
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

  // Compare section collapse
  document.querySelectorAll('.section-head[data-section]').forEach(el => {
    el.addEventListener('click', () => {
      const kind = (el as HTMLElement).dataset.section!;
      collapsed.has(kind) ? collapsed.delete(kind) : collapsed.add(kind);
      render();
    });
  });

  // Session handlers
  document.getElementById('btn-session-clear')?.addEventListener('click', async () => {
    const resp = await send({ type: 'CLEAR_SESSION' });
    if (resp.type === 'STATE') { state = resp.state; }
    ingestStatus = null;
    render();
  });

  document.querySelectorAll('.session-page-head[data-session-page]').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't toggle if clicking the remove button
      if ((e.target as HTMLElement).closest('.session-page-remove')) return;
      const key = (el as HTMLElement).dataset.sessionPage!;
      sessionCollapsed.has(key) ? sessionCollapsed.delete(key) : sessionCollapsed.add(key);
      render();
    });
  });

  document.querySelectorAll('.session-page-remove[data-remove-url]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = (el as HTMLElement).dataset.removeUrl!;
      const resp = await send({ type: 'REMOVE_SESSION_PAGE', url });
      if (resp.type === 'STATE') { state = resp.state; }
      render();
    });
  });

  document.getElementById('btn-session-ingest')?.addEventListener('click', async () => {
    ingestBusy = true;
    ingestStatus = null;
    render();
    const resp = await send({ type: 'INGEST_SESSION', kinds: ['new'] });
    if (resp.type === 'INGEST_RESULT') {
      ingestBusy = false;
      const ok = resp.status === 'started' || resp.status === 'opened';
      ingestStatus = { kind: ok ? 'ok' : 'err', msg: resp.message ?? resp.status };
      render();
    }
  });

  // Ingest (single page)
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
  if (resp.type === 'STATE') {
    state = resp.state;
    // Auto-show Live tab if streaming is active
    if (state.liveStreaming) view = 'live';
  }
  render();
}

init();
