/**
 * Extension popup — two-button UI: Compare and Ingest.
 * Compare opens the side panel with compare view + page highlights.
 * Ingest opens the Reckons.AI ingest page for the current URL.
 */
import type { ExtensionState, PopupRequest, BackgroundEvent } from './types';

let state: ExtensionState | null = null;
let error: string | null = null;
let currentTab: chrome.tabs.Tab | null = null;

function send(msg: PopupRequest): Promise<BackgroundEvent> {
  return chrome.runtime.sendMessage(msg);
}

chrome.runtime.onMessage.addListener((event: BackgroundEvent) => {
  if (event.type === 'STATE') { state = event.state; error = null; }
  if (event.type === 'ERROR') { error = event.message; }
  render();
});

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  const root = document.getElementById('root')!;
  root.innerHTML = buildHTML();
  attachHandlers();
}

function buildHTML(): string {
  if (!state) {
    return `<div class="body"><div class="loading">Loading&hellip;</div></div>`;
  }

  const { settings, snapshot, analyzing } = state;
  const hasKey = !!settings.apiKey;

  let html = '';

  // Page info
  if (currentTab) {
    const title = currentTab.title ?? 'Untitled';
    const url = currentTab.url ?? '';
    html += `<div class="page-info">
      <div class="page-title">${esc(title.slice(0, 55))}${title.length > 55 ? '&hellip;' : ''}</div>
      <div class="page-url">${esc(url.slice(0, 50))}${url.length > 50 ? '&hellip;' : ''}</div>
    </div>`;
  }

  html += `<div class="body">`;

  if (error) {
    html += `<div class="error-box">${esc(error)}</div>`;
  }

  if (!hasKey) {
    html += `<div class="nokey">No API key set.<br><a id="lnk-settings">Open settings &rarr;</a></div>`;
    html += `</div>`;
    return html;
  }

  // Compare button
  html += `<button class="action-btn primary" id="btn-compare" ${analyzing ? 'disabled' : ''}>
    ${analyzing
      ? '<span class="spinner"></span> Analyzing&hellip;'
      : '<span class="btn-icon">&#x21C6;</span> Compare Page'
    }
  </button>`;

  // Ingest button
  html += `<button class="action-btn" id="btn-ingest">
    <span class="btn-icon">&#x2B07;</span> Ingest Page
  </button>`;

  // Session status
  const sessionCount = state.session.pages.length;
  if (sessionCount > 0) {
    const allTriples = state.session.pages.flatMap(p => p.triples);
    const nC = allTriples.filter(t => t.kind === 'conflict').length;
    const nN = allTriples.filter(t => t.kind === 'new').length;
    html += `<div class="session-row">
      <span class="session-badge">${sessionCount} page${sessionCount !== 1 ? 's' : ''}</span>
      ${nC > 0 ? `<span class="session-stat conflict">${nC} conflicts</span>` : ''}
      ${nN > 0 ? `<span class="session-stat new">${nN} new</span>` : ''}
    </div>`;
  }

  // KB status
  html += `<div class="kb-row">
    <div class="kb-info">
      <div class="kb-title">Knowledge Base</div>
      <div class="kb-sub">${
        snapshot
          ? `${snapshot.entityCount} entities synced`
          : 'Not synced &mdash; open Reckons.AI and click Sync'
      }</div>
    </div>
    <button id="btn-sync">Sync KB</button>
  </div>`;

  html += `</div>`;
  return html;
}

function attachHandlers() {
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('lnk-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('btn-compare')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hasSidePanel = typeof (chrome as any).sidePanel !== 'undefined';
    if (hasSidePanel && tab?.id) {
      // Chrome: open the native side panel (requires user gesture — popup click qualifies)
      try { await (chrome.sidePanel as any).open({ tabId: tab.id }); } catch {}
    } else {
      // Firefox (and any browser without sidePanel API): open as a regular tab
      chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: true });
    }
    send({ type: 'OPEN_COMPARE' });
    window.close();
  });
  document.getElementById('btn-ingest')?.addEventListener('click', async () => {
    await send({ type: 'OPEN_INGEST' });
    window.close();
  });
  document.getElementById('btn-sync')?.addEventListener('click', async () => {
    error = null;
    const resp = await send({ type: 'SYNC_KB' });
    if (resp.type === 'STATE') { state = resp.state; render(); }
    if (resp.type === 'ERROR') { error = resp.message; render(); }
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  const resp = await send({ type: 'GET_STATE' });
  if (resp.type === 'STATE') state = resp.state;
  render();
}

init();
