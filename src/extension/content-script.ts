/**
 * Content script — injected into every web page.
 *
 * Responsibilities:
 *  1. Return page text to the background on request.
 *  2. Apply / clear green-red triple highlights with always-visible labels.
 *  3. On the Reckons.AI origin, read window.__reckonsKB and return a snapshot.
 */
import type { ContentCommand, ContentResponse, ExtractedTriple, KBSnapshot, HighlightSettings } from './types';

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
chrome.storage.onChanged.addListener((changes) => {
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

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((cmd: ContentCommand, _sender, sendResponse) => {
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
  }
  return false;
});

} // end double-injection guard
