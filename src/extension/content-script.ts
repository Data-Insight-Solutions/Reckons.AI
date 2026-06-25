/**
 * Content script — injected into every web page.
 *
 * Responsibilities:
 *  1. Return page text to the background on request.
 *  2. Apply / clear green-red triple highlights with always-visible labels.
 *  3. On the Reckons.AI origin, read window.__reckonsKB and return a snapshot.
 */
import type { ContentCommand, ContentResponse, ExtractedTriple, KBSnapshot, HighlightSettings, LiveClaim } from './types';

// Guard against double-injection (Chrome re-injects into existing tabs when the
// extension reloads; the second run would throw "already declared" for every const).
if (!(window as any).__reckonsCS) {
(window as any).__reckonsCS = true;

const MARK_CLASS  = 'reckons-ext-mark';
const LABEL_CLASS = 'reckons-ext-label';
const VARS_ID     = 'reckons-hl-vars';

// ── Dynamic style injection ───────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const n = hex.replace('#', '');
  const full = n.length === 3
    ? n.split('').map(c => c + c).join('')
    : n;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

function applyHighlightVars(hs: HighlightSettings) {
  const sat = Math.max(0, Math.min(100, hs.saturation)) / 100;
  const bg  = 0.22 * sat;
  const bdr = 0.65 * sat;
  const css = `:root {
    --reckons-conflict-bg:      ${hexToRgba(hs.conflictColor,  bg)};
    --reckons-conflict-border:  ${hexToRgba(hs.conflictColor,  bdr)};
    --reckons-reinforce-bg:     ${hexToRgba(hs.reinforceColor, bg)};
    --reckons-reinforce-border: ${hexToRgba(hs.reinforceColor, bdr)};
    --reckons-new-bg:           ${hexToRgba(hs.newColor,       bg)};
    --reckons-new-border:       ${hexToRgba(hs.newColor,       bdr)};
    --reckons-label-size:       ${hs.labelFontSize}px;
    --reckons-label-scale:      ${hs.labelHoverScale};
    --reckons-label-font:       ${hs.labelFontFamily}, monospace;
  }`;
  let el = document.getElementById(VARS_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = VARS_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// Load highlight settings from extension storage and apply
async function loadHighlightSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    const hs: HighlightSettings = {
      conflictColor:   '#ef4444',
      reinforceColor:  '#22c55e',
      newColor:        '#63b3ed',
      saturation:      100,
      labelFontSize:   10,
      labelHoverScale: 1.6,
      labelFontFamily: 'monospace',
      ...(stored.settings?.highlight ?? {}),
    };
    applyHighlightVars(hs);
  } catch { /* storage not available */ }
}

// Re-apply when settings are changed from the options page
chrome.storage.onChanged.addListener((changes: any) => {
  if (changes.settings?.newValue?.highlight) {
    const hs: HighlightSettings = {
      conflictColor: '#ef4444', reinforceColor: '#22c55e', newColor: '#63b3ed',
      saturation: 100, labelFontSize: 10, labelHoverScale: 1.6, labelFontFamily: 'monospace',
      ...changes.settings.newValue.highlight,
    };
    applyHighlightVars(hs);
  }
});

loadHighlightSettings();

// ── Page text extraction ──────────────────────────────────────────────────────

function getPageText(): string {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'HEADER', 'ASIDE']);
  const parts: string[] = [];
  function walk(node: Node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (skip.has(el.tagName)) return;
      for (const child of el.childNodes) walk(child);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text && text.length > 1) parts.push(text);
    }
  }
  const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  walk(root);
  return parts.join(' ');
}

// ── Highlighting ──────────────────────────────────────────────────────────────

function highlightSpan(
  span: string,
  kind: ExtractedTriple['kind'],
  tooltip: string,
  labelText: string,
): boolean {
  if (!span || span.length < 4) return false;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) return NodeFilter.FILTER_REJECT;
      if (el.closest(`.${MARK_CLASS}`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const lowerSpan = span.toLowerCase();
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent ?? '';
    const idx = text.toLowerCase().indexOf(lowerSpan);
    if (idx === -1) continue;

    const mark = document.createElement('mark');
    mark.className = `${MARK_CLASS} reckons-${kind}`;
    mark.dataset.tooltip = tooltip;

    // Always-visible label
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = labelText;
    mark.appendChild(label);

    // Matched text node
    mark.appendChild(document.createTextNode(text.slice(idx, idx + span.length)));

    const parent = node.parentNode!;
    if (idx > 0) parent.insertBefore(document.createTextNode(text.slice(0, idx)), node);
    parent.insertBefore(mark, node);
    const after = text.slice(idx + span.length);
    if (after) parent.insertBefore(document.createTextNode(after), node);
    parent.removeChild(node);

    return true;
  }
  return false;
}

function applyHighlights(triples: ExtractedTriple[]): number {
  let count = 0;
  for (const t of triples) {
    if (!t.textSpan) continue;
    const tooltip  = `${t.subject} · ${t.predicate} · ${t.object}` +
      (t.conflictNote ? `\nConflict: ${t.conflictNote}` : '');
    const labelText = `${t.subject} · ${t.predicate}`.slice(0, 36);
    if (highlightSpan(t.textSpan, t.kind, tooltip, labelText)) count++;
  }
  return count;
}

function clearHighlights() {
  document.querySelectorAll(`.${MARK_CLASS}`).forEach(mark => {
    const parent = mark.parentNode!;
    // Remove label child first, then unwrap text
    mark.querySelectorAll(`.${LABEL_CLASS}`).forEach(l => l.remove());
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

// ── Tooltip (hover detail) ────────────────────────────────────────────────────

let tooltipEl: HTMLElement | null = null;

function ensureTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'reckons-ext-tooltip';
  tooltipEl.style.cssText = `
    position: fixed; z-index: 2147483647; pointer-events: none;
    background: rgba(10,10,14,0.95); color: #e8eaf0;
    font: 12px/1.45 monospace; padding: 6px 10px;
    border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
    max-width: 320px; white-space: pre-wrap; word-break: break-word;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4); display: none;
  `;
  document.body.appendChild(tooltipEl);
}

document.addEventListener('mouseover', (e) => {
  const mark = (e.target as Element).closest(`.${MARK_CLASS}`) as HTMLElement | null;
  if (!mark?.dataset.tooltip) return;
  ensureTooltip();
  tooltipEl!.textContent = mark.dataset.tooltip;
  tooltipEl!.style.display = 'block';
}, { passive: true });

document.addEventListener('mousemove', (e) => {
  if (!tooltipEl || tooltipEl.style.display === 'none') return;
  tooltipEl.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 340)}px`;
  tooltipEl.style.top  = `${Math.min(e.clientY + 16, window.innerHeight - 120)}px`;
}, { passive: true });

document.addEventListener('mouseout', (e) => {
  if (!(e.target as Element).closest(`.${MARK_CLASS}`) || !tooltipEl) return;
  tooltipEl.style.display = 'none';
}, { passive: true });

// ── KB bridge ────────────────────────────────────────────────────────────────

function readKBSnapshot(): KBSnapshot | null {
  try {
    const bridge = (window as any).__reckonsKB as { getSnapshot?: () => KBSnapshot } | undefined;
    if (bridge?.getSnapshot) return bridge.getSnapshot();
  } catch { /* cross-origin */ }
  return null;
}

// ── Live stream overlay panel ────────────────────────────────────────────────

let fcPanel: HTMLElement | null = null;
let fcTranscriptFeed: HTMLElement | null = null;
let fcInterimEl: HTMLElement | null = null;
let fcVerdictList: HTMLElement | null = null;
let fcTranscriptCollapsed = false;
let fcSpeakers: string[] = [];

const FC_SPEAKER_COLORS = ['#3b82f6','#ef4444','#f59e0b','#10b981','#8b5cf6','#f97316'];
const fcSpeakerColorMap = new Map<string, string>();
function fcSpeakerColor(name: string): string {
  if (!fcSpeakerColorMap.has(name)) {
    fcSpeakerColorMap.set(name, FC_SPEAKER_COLORS[fcSpeakerColorMap.size % FC_SPEAKER_COLORS.length]);
  }
  return fcSpeakerColorMap.get(name)!;
}

const fcConfirmedMap: Record<number, string | null> = {};
const fcPendingSpeakers = new Set<number>();
const fcSessionLog: LiveClaim[] = [];

function verdictColor(v: string): string {
  if (v === 'KB_CONFIRMED') return 'green';
  if (v === 'KB_CONFLICT')  return 'red';
  if (v === 'KB_NEW')       return 'blue';
  return 'grey';
}

function createFCPanel() {
  if (fcPanel) return;
  fcPanel = document.createElement('div');
  fcPanel.id = 'reckons-fc-panel';
  fcPanel.innerHTML = [
    '<div id="reckons-fc-header">',
      '<span class="rfc-dot"></span>',
      '<span class="rfc-title">Reckons.AI Live</span>',
      '<div class="rfc-header-actions">',
        '<button class="rfc-header-btn" id="rfc-export" title="Export session">Export</button>',
        '<button class="rfc-header-btn" id="rfc-close" title="Stop and close">Stop</button>',
      '</div>',
    '</div>',
    '<div id="reckons-fc-body">',
      '<div class="rfc-section-header">',
        '<span class="rfc-section-label">Transcript</span>',
        '<button class="rfc-toggle-btn" id="rfc-transcript-toggle">&#x25BE;</button>',
      '</div>',
      '<div id="reckons-fc-transcript-feed"></div>',
      '<p id="reckons-fc-interim"></p>',
      '<div class="rfc-section-header">',
        '<span class="rfc-section-label">KB Verdicts</span>',
        '<div class="rfc-speaker-editor" id="rfc-speaker-editor"></div>',
      '</div>',
      '<div id="reckons-fc-verdicts">',
        '<p class="rfc-empty">Verdicts will appear here as statements are analyzed against your KB...</p>',
      '</div>',
    '</div>',
  ].join('');
  document.body.appendChild(fcPanel);

  fcTranscriptFeed = fcPanel.querySelector('#reckons-fc-transcript-feed');
  fcInterimEl = fcPanel.querySelector('#reckons-fc-interim');
  fcVerdictList = fcPanel.querySelector('#reckons-fc-verdicts');

  fcPanel.querySelector('#rfc-close')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_LIVE' });
    removeFCPanel();
  });
  fcPanel.querySelector('#rfc-export')!.addEventListener('click', () => exportFCSession());
  fcPanel.querySelector('#rfc-transcript-toggle')!.addEventListener('click', () => {
    fcTranscriptCollapsed = !fcTranscriptCollapsed;
    if (fcTranscriptFeed) fcTranscriptFeed.style.display = fcTranscriptCollapsed ? 'none' : '';
    if (fcInterimEl) fcInterimEl.style.display = fcTranscriptCollapsed ? 'none' : '';
    const btn = fcPanel?.querySelector('#rfc-transcript-toggle');
    if (btn) btn.textContent = fcTranscriptCollapsed ? '\u25B8' : '\u25BE';
  });

  makeFCDraggable(fcPanel);
  renderFCSpeakerEditor();
}

function removeFCPanel() {
  fcPanel?.remove();
  fcPanel = null;
  fcTranscriptFeed = null;
  fcInterimEl = null;
  fcVerdictList = null;
  fcTranscriptCollapsed = false;
  fcSpeakers = [];
  fcSpeakerColorMap.clear();
  Object.keys(fcConfirmedMap).forEach(k => delete fcConfirmedMap[+k]);
  fcPendingSpeakers.clear();
  fcSessionLog.length = 0;
}

function renderFCSpeakerEditor() {
  const el = fcPanel?.querySelector('#rfc-speaker-editor');
  if (!el || !fcSpeakers.length) return;
  el.innerHTML = fcSpeakers.map((name, i) => {
    const color = fcSpeakerColor(name);
    return `<span class="rfc-speaker-chip" style="border-color:${color};color:${color}">` +
      `<input class="rfc-speaker-chip-input" value="${name}" data-idx="${i}" style="color:${color}" />` +
    `</span>`;
  }).join('');
  el.querySelectorAll('.rfc-speaker-chip-input').forEach(input => {
    (input as HTMLInputElement).addEventListener('change', (e) => {
      const idx = parseInt((e.target as HTMLInputElement).dataset.idx!);
      const newName = (e.target as HTMLInputElement).value.trim() || fcSpeakers[idx];
      fcSpeakers[idx] = newName;
      chrome.runtime.sendMessage({ type: 'CONFIRM_LIVE_SPEAKER', speakerId: idx, name: newName });
    });
    (input as HTMLInputElement).addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
  });
}

function addFCTranscript(text: string) {
  if (!fcTranscriptFeed) return;
  const displayText = text.replace(/^\[.*?\]\s*/, '');
  const span = document.createElement('span');
  span.textContent = displayText + ' ';
  span.className = 'rfc-transcript-word';
  fcTranscriptFeed.appendChild(span);
  fcTranscriptFeed.scrollTop = fcTranscriptFeed.scrollHeight;
}

function updateFCInterim(text: string) {
  if (fcInterimEl) fcInterimEl.textContent = text;
}

function buildFCCard(claim: LiveClaim): HTMLElement {
  const color = verdictColor(claim.verdict);
  const convColor = claim.speakerConfidence === 'HIGH' ? 'green'
                  : claim.speakerConfidence === 'LOW'  ? 'red' : 'yellow';
  const card = document.createElement('div');
  card.className = `rfc-verdict rfc-verdict--${color}${claim.pending ? ' rfc-verdict--pending' : ''}`;

  const speakerName = claim.speaker && !/^Speaker\s*\d+$/i.test(claim.speaker) ? claim.speaker : null;
  const speakerTag = speakerName
    ? `<div class="rfc-speaker-tag" style="background:${fcSpeakerColor(speakerName)}">${speakerName}</div>`
    : '';

  const verdictLabel = claim.verdict.replace('KB_', '').replace('_', ' ');

  card.innerHTML = [
    speakerTag,
    `<div class="rfc-verdict-header">`,
      `<span class="rfc-badge rfc-badge--${color}">${verdictLabel}</span>`,
      claim.pending ? '<span class="rfc-verifying">verifying...</span>' : '',
      `<span class="rfc-confidence-right">${claim.confidence} certainty</span>`,
      claim.timestamp ? `<span class="rfc-timestamp">${claim.timestamp}</span>` : '',
    `</div>`,
    `<p class="rfc-claim">"${escFC(claim.claim)}"</p>`,
    `<p class="rfc-explanation">${escFC(claim.explanation)}</p>`,
    claim.conflictNote ? `<p class="rfc-conflict-note">Conflicts with: ${escFC(claim.conflictNote)}</p>` : '',
    `<div class="rfc-triple-row"><strong>${escFC(claim.triple.subject)}</strong> &middot; ${escFC(claim.triple.predicate)} &middot; <strong>${escFC(claim.triple.object)}</strong></div>`,
    `<div class="rfc-speaker-confidence">`,
      `<button class="rfc-speaker-toggle">`,
        `<span class="rfc-speaker-dot rfc-speaker-dot--${convColor}"></span>`,
        `Speaker conviction: ${claim.speakerConfidence || 'N/A'}`,
        `<span class="rfc-speaker-arrow">&#x25BE;</span>`,
      `</button>`,
      `<div class="rfc-speaker-explanation" style="display:none"></div>`,
    `</div>`,
  ].join('');

  const toggle = card.querySelector('.rfc-speaker-toggle');
  const reasons = card.querySelector('.rfc-speaker-explanation') as HTMLElement;
  const arrow = card.querySelector('.rfc-speaker-arrow');
  if (toggle && reasons && arrow && claim.lexical) {
    const r = claim.lexical.rates;
    let rows = '';
    if (r.hedging > 0)       rows += `<div class="rfc-conviction-row"><span class="rfc-conviction-label">Hedging:</span> ${r.hedging}%</div>`;
    if (r.certainty > 0)     rows += `<div class="rfc-conviction-row"><span class="rfc-conviction-label">Certainty:</span> ${r.certainty}%</div>`;
    if (r.filler > 0)        rows += `<div class="rfc-conviction-row"><span class="rfc-conviction-label">Filler:</span> ${r.filler}%</div>`;
    if (r.emotional > 0)     rows += `<div class="rfc-conviction-row"><span class="rfc-conviction-label">Emotional:</span> ${r.emotional}%</div>`;
    if (claim.lexical.wordsPerSecond != null) {
      const pace = claim.lexical.wordsPerSecond > 3.5 ? 'fast' : claim.lexical.wordsPerSecond < 2 ? 'slow' : 'moderate';
      rows += `<div class="rfc-conviction-row"><span class="rfc-conviction-label">Speech rate:</span> ${claim.lexical.wordsPerSecond} w/s (${pace})</div>`;
    }
    reasons.innerHTML = rows || '<div class="rfc-conviction-row">No strong signals detected</div>';
    toggle.addEventListener('click', () => {
      const open = reasons.style.display === 'none';
      reasons.style.display = open ? 'block' : 'none';
      arrow!.textContent = open ? '\u25B4' : '\u25BE';
    });
  }

  return card;
}

function addFCVerdict(claims: LiveClaim[]) {
  if (!fcVerdictList) return;
  fcVerdictList.querySelector('.rfc-empty')?.remove();
  for (const claim of claims) {
    fcSessionLog.push(claim);
    const card = buildFCCard(claim);
    fcVerdictList.prepend(card);
  }
}

function showFCSpeakerBanner(speakerId: number, sample: string) {
  if (fcPendingSpeakers.has(speakerId) || speakerId in fcConfirmedMap) return;
  if (!fcSpeakers.length) return;
  fcPendingSpeakers.add(speakerId);

  const banner = document.createElement('div');
  banner.className = 'rfc-speaker-banner';
  banner.innerHTML =
    '<div class="rfc-speaker-banner-text">New speaker detected — who is this?</div>' +
    `<div class="rfc-speaker-banner-sample">"${sample}..."</div>` +
    '<div class="rfc-speaker-banner-buttons">' +
      fcSpeakers.map(name =>
        `<button class="rfc-speaker-banner-btn" data-name="${name}" data-id="${speakerId}">${name}</button>`
      ).join('') +
      `<button class="rfc-speaker-banner-btn rfc-speaker-banner-btn--skip" data-id="${speakerId}">Skip</button>` +
    '</div>';

  banner.querySelectorAll('.rfc-speaker-banner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = (btn as HTMLElement).dataset.name;
      const id = parseInt((btn as HTMLElement).dataset.id!);
      if (name) {
        fcConfirmedMap[id] = name;
        chrome.runtime.sendMessage({ type: 'CONFIRM_LIVE_SPEAKER', speakerId: id, name });
      } else {
        fcConfirmedMap[id] = null;
      }
      fcPendingSpeakers.delete(id);
      banner.remove();
    });
  });

  const verdictSection = fcPanel?.querySelector('#reckons-fc-verdicts');
  if (verdictSection) verdictSection.insertAdjacentElement('beforebegin', banner);
}

function showFCError(message: string) {
  if (!fcPanel) return;
  const existing = fcPanel.querySelector('.rfc-error-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'rfc-error-toast';
  toast.innerHTML = `<span class="rfc-error-icon">&#x26A0;</span><span class="rfc-error-msg">${escFC(message)}</span><button class="rfc-error-close">&#x2715;</button>`;
  toast.querySelector('.rfc-error-close')!.addEventListener('click', () => toast.remove());
  const header = fcPanel.querySelector('#reckons-fc-header');
  if (header) header.insertAdjacentElement('afterend', toast);
  setTimeout(() => toast.remove(), 8000);
}

function makeFCDraggable(panel: HTMLElement) {
  const header = panel.querySelector('#reckons-fc-header') as HTMLElement;
  let isDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.rfc-header-btn')) return;
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.right = 'unset';
    panel.style.left = Math.max(0, startLeft + e.clientX - startX) + 'px';
    panel.style.top  = Math.max(0, startTop  + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { isDragging = false; header.style.cursor = 'grab'; });
}

function escFC(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function exportFCSession() {
  if (!fcSessionLog.length) return;
  const title = document.title || 'Live Session';
  const date = new Date().toLocaleString();
  const verdictHex = (v: string) => v === 'KB_CONFIRMED' ? '#15803d' : v === 'KB_CONFLICT' ? '#b91c1c' : v === 'KB_NEW' ? '#1d4ed8' : '#6b7280';

  const counts = {
    confirmed: fcSessionLog.filter(c => c.verdict === 'KB_CONFIRMED').length,
    conflict: fcSessionLog.filter(c => c.verdict === 'KB_CONFLICT').length,
    newInfo: fcSessionLog.filter(c => c.verdict === 'KB_NEW').length,
    unverifiable: fcSessionLog.filter(c => c.verdict === 'UNVERIFIABLE').length,
  };

  const claimsHTML = fcSessionLog.map((c, i) => {
    const color = verdictHex(c.verdict);
    const label = c.verdict.replace('KB_', '').replace('_', ' ');
    return `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:14px 16px;margin-bottom:12px;page-break-inside:avoid">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="font-size:10px;color:#aaa;font-weight:600">#${i+1}</span>
        ${c.speaker ? `<span style="font-size:10px;font-weight:700;background:${fcSpeakerColor(c.speaker)};color:#fff;padding:1px 7px;border-radius:3px">${c.speaker}</span>` : ''}
        <span style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase">${label}</span>
        <span style="font-size:10px;color:#888">${c.confidence} certainty</span>
      </div>
      <div style="font-size:13px;font-style:italic;color:#333;margin-bottom:6px">"${c.claim}"</div>
      <div style="font-size:12px;color:#555;margin-bottom:6px">${c.explanation}</div>
      ${c.conflictNote ? `<div style="font-size:11px;color:#b91c1c;margin-bottom:6px">Conflicts with: ${c.conflictNote}</div>` : ''}
      <div style="font-size:10px;color:#888;font-family:monospace;background:#f8f8f8;padding:4px 8px;border-radius:4px">${c.triple.subject} &middot; ${c.triple.predicate} &middot; ${c.triple.object}</div>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reckons.AI Live Report</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;font-size:13px;color:#111;padding:40px;max-width:800px;margin:0 auto;line-height:1.5}
.header{border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:24px}.title{font-size:22px;font-weight:700;margin-bottom:4px}.meta{font-size:11px;color:#666}
.summary{display:flex;gap:16px;margin-bottom:28px;padding:16px;background:#f8f8f8;border-radius:8px}.si{display:flex;flex-direction:column;align-items:center;flex:1}
.si-n{font-size:24px;font-weight:700}.si-l{font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-top:2px}
@media print{body{padding:20px}}</style></head><body>
<div class="header"><div class="title">Reckons.AI Live Report</div>
<div class="meta"><span>${title}</span> &middot; <span>${date}</span> &middot; <span>${fcSessionLog.length} claims</span></div></div>
<div class="summary">
<div class="si"><span class="si-n" style="color:#15803d">${counts.confirmed}</span><span class="si-l">Confirmed</span></div>
<div class="si"><span class="si-n" style="color:#b91c1c">${counts.conflict}</span><span class="si-l">Conflicts</span></div>
<div class="si"><span class="si-n" style="color:#1d4ed8">${counts.newInfo}</span><span class="si-l">New</span></div>
<div class="si"><span class="si-n" style="color:#6b7280">${counts.unverifiable}</span><span class="si-l">Unverifiable</span></div>
</div>${claimsHTML}</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'reckons-live-report.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((cmd: ContentCommand, _sender: any, sendResponse: any) => {
  switch (cmd.type) {
    case 'GET_TEXT':
      sendResponse({ type: 'TEXT', text: getPageText(), title: document.title, url: location.href } satisfies ContentResponse);
      break;
    case 'HIGHLIGHT':
      sendResponse({ type: 'HIGHLIGHTED', count: applyHighlights(cmd.triples) } satisfies ContentResponse);
      break;
    case 'CLEAR_HIGHLIGHTS':
      clearHighlights();
      sendResponse({ type: 'CLEARED' } satisfies ContentResponse);
      break;
    case 'GET_KB_SNAPSHOT':
      sendResponse({ type: 'KB_SNAPSHOT', snapshot: readKBSnapshot() } satisfies ContentResponse);
      break;

    // Live overlay messages
    case 'LIVE_START':
      fcSpeakers = (cmd as any).speakers || [];
      createFCPanel();
      break;
    case 'LIVE_STOP':
      removeFCPanel();
      break;
    case 'LIVE_TRANSCRIPT': {
      const tr = cmd as any;
      if (tr.interim) { updateFCInterim(tr.text); }
      else if (tr.isFinal) {
        if (fcInterimEl) fcInterimEl.textContent = '';
        addFCTranscript(tr.text);
      }
      break;
    }
    case 'LIVE_VERDICT':
      addFCVerdict((cmd as any).claims);
      break;
    case 'LIVE_UPDATE_VERDICT':
      addFCVerdict((cmd as any).claims);
      break;
    case 'LIVE_ERROR':
      showFCError((cmd as any).message);
      break;
    case 'LIVE_SPEAKER':
      showFCSpeakerBanner((cmd as any).speakerId, (cmd as any).sample);
      break;
  }
  return false;
});

} // end double-injection guard
