/**
 * Extension background service worker.
 * Handles LLM calls, KB sync, and coordinates popup ↔ content script.
 */
import type {
  ExtSettings, KBSnapshot, AnalysisResult, ExtractedTriple, DiffSummary,
  ExtensionState, PopupRequest, BackgroundEvent, ContentCommand, ContentResponse,
} from './types';
import { DEFAULT_SETTINGS } from './types';

// ── In-memory state (lost on service worker restart, backed by storage) ──────

let settings: ExtSettings = { ...DEFAULT_SETTINGS };
let snapshot: KBSnapshot | null = null;
let result: AnalysisResult | null = null;
let analyzing = false;
let highlightsActive = false;
let currentTabId: number | null = null;

// ── Persistence ───────────────────────────────────────────────────────────────

async function loadState() {
  const stored = await chrome.storage.local.get(['settings', 'snapshot', 'result']);
  if (stored.settings) settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  if (stored.snapshot) snapshot = stored.snapshot;
  if (stored.result) result = stored.result;
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

async function saveSnapshot() {
  await chrome.storage.local.set({ snapshot });
}

async function saveResult() {
  await chrome.storage.local.set({ result });
}

function getState(): ExtensionState {
  return { settings, snapshot, result, analyzing, highlightsActive, currentTabId };
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

function broadcast(event: BackgroundEvent) {
  chrome.runtime.sendMessage(event).catch(() => {/* popup may be closed */});
}

async function sendToTab(tabId: number, cmd: ContentCommand): Promise<ContentResponse | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, cmd) as ContentResponse;
  } catch {
    return null;
  }
}

// ── Get page text from active tab ─────────────────────────────────────────────

async function getActiveTabText(): Promise<{ text: string; title: string; url: string; tabId: number } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
    return null;
  }
  currentTabId = tab.id;

  // Ping the content script first — it may already be running fine.
  let resp = await sendToTab(tab.id, { type: 'GET_TEXT' });

  if (!resp || resp.type !== 'TEXT') {
    // Content script not responding. Happens when:
    //  (a) tab was open before extension installed, or
    //  (b) extension was reloaded in dev mode — the __reckonsCS guard flag
    //      persists in window but the old listener is dead.
    // Fix: delete the guard flag, then inject a fresh copy.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { delete (window as any).__reckonsCS; },
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js'],
    }).catch(() => {});
    resp = await sendToTab(tab.id, { type: 'GET_TEXT' });
  }

  if (!resp || resp.type !== 'TEXT') return null;
  return { ...resp, tabId: tab.id };
}

// ── LLM call ─────────────────────────────────────────────────────────────────

function buildPrompt(text: string, url: string, snapshot: KBSnapshot | null, focus?: string): string {
  const pageContent = text.slice(0, 5000);
  const entityList = snapshot
    ? snapshot.entities.slice(0, 40)
        .map(e => `  • ${e.label}${e.type ? ` [${e.type}]` : ''}: ${e.predicates.slice(0, 3).join(', ')}`)
        .join('\n')
    : '  (no KB snapshot — all triples will be marked "new")';

  const focusSection = focus?.trim()
    ? `\nFOCUS (prioritise this aspect of the page):\n${focus.trim()}\n`
    : '';

  return `You are analyzing a web page to extract knowledge triples and compare them with an existing knowledge base.

PAGE URL: ${url}
${focusSection}
PAGE CONTENT (truncated):
${pageContent}

KNOWLEDGE BASE (${snapshot?.entityCount ?? 0} entities):
${entityList}

TASK:
1. Extract up to 15 key factual triples from the page.${focus?.trim() ? ' Prioritise the focus area above.' : ''}
2. For each triple find a short verbatim text span from the page that supports it.
3. Classify each triple:
   - "reinforce": a claim that matches or supports something already in the KB
   - "conflict":  a claim that contradicts something in the KB
   - "new":       relevant new knowledge not in the KB

Output only valid JSON — no markdown, no prose:
{
  "triples": [
    {
      "subject": "...",
      "predicate": "...",
      "object": "...",
      "textSpan": "verbatim excerpt from page, max 120 chars",
      "kind": "reinforce" | "conflict" | "new",
      "conflictNote": "optional: what it conflicts with"
    }
  ],
  "summary": {
    "new": "1-2 sentences summarizing new information this page adds",
    "reinforcing": "1-2 sentences summarizing what this page confirms",
    "conflicting": "1-2 sentences summarizing contradictions or refinements"
  }
}`;
}

async function callLLM(prompt: string): Promise<string> {
  const { apiKey, apiProvider, apiModel } = settings;
  if (!apiKey) throw new Error('No API key configured. Open extension settings.');

  if (apiProvider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: apiModel || 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text;

  } else if (apiProvider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: apiModel || 'gpt-4o-mini',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;

  } else {
    // Gemini
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${apiModel || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  }
}

function parseLLMResponse(raw: string): { triples: ExtractedTriple[]; summary: DiffSummary | string } {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  // Accept both structured and legacy string summary
  let summary: DiffSummary | string;
  if (parsed.summary && typeof parsed.summary === 'object') {
    summary = {
      new: parsed.summary.new ?? '',
      reinforcing: parsed.summary.reinforcing ?? '',
      conflicting: parsed.summary.conflicting ?? '',
    };
  } else {
    summary = parsed.summary ?? '';
  }
  return {
    triples: (parsed.triples ?? []) as ExtractedTriple[],
    summary,
  };
}

// ── Analyze page ──────────────────────────────────────────────────────────────

async function analyzePage(autoHighlight = false, focus?: string) {
  if (analyzing) return;
  analyzing = true;
  broadcast({ type: 'STATE', state: getState() });

  try {
    const page = await getActiveTabText();
    if (!page) throw new Error('Cannot read this page. Try a regular web page.');

    const prompt = buildPrompt(page.text, page.url, snapshot, focus);
    const raw = await callLLM(prompt);
    const { triples, summary } = parseLLMResponse(raw);

    result = { url: page.url, title: page.title, triples, summary, analyzedAt: Date.now() };
    await saveResult();

    if (autoHighlight && currentTabId) {
      await highlightPage();
    }
  } catch (e) {
    broadcast({ type: 'ERROR', message: e instanceof Error ? e.message : String(e) });
  } finally {
    analyzing = false;
    broadcast({ type: 'STATE', state: getState() });
  }
}

// ── Apply / clear highlights ─────────────────────────────────────────────────

async function highlightPage() {
  if (!result || !currentTabId) return;
  await sendToTab(currentTabId, { type: 'HIGHLIGHT', triples: result.triples });
  highlightsActive = true;
  broadcast({ type: 'STATE', state: getState() });
}

async function clearHighlights() {
  if (!currentTabId) return;
  await sendToTab(currentTabId, { type: 'CLEAR_HIGHLIGHTS' });
  highlightsActive = false;
  broadcast({ type: 'STATE', state: getState() });
}

// ── KB Sync ───────────────────────────────────────────────────────────────────

async function syncKB() {
  const { reckonsUrl } = settings;

  // Find an open Reckons.AI tab
  const tabs = await chrome.tabs.query({ url: `${reckonsUrl}/*` });
  if (tabs.length === 0) {
    broadcast({ type: 'ERROR', message: `Reckons.AI not open. Open ${reckonsUrl} first.` });
    return;
  }
  const tab = tabs[0];
  if (!tab.id) return;

  // Content scripts run in an isolated JS world and cannot access window.__reckonsKB
  // set by the Svelte app. Use world:'MAIN' to read directly from the page's JS context.
  let snapResults: chrome.scripting.InjectionResult[];
  let hlResults: chrome.scripting.InjectionResult[];
  try {
    [snapResults, hlResults] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          const bridge = (window as any).__reckonsKB as { getSnapshot?: () => unknown } | undefined;
          if (bridge?.getSnapshot) return bridge.getSnapshot();
          return null;
        },
      }),
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          const bridge = (window as any).__reckonsKB as { getHighlightSettings?: () => unknown } | undefined;
          if (bridge?.getHighlightSettings) return bridge.getHighlightSettings();
          return null;
        },
      }),
    ]);
  } catch (e) {
    broadcast({ type: 'ERROR', message: 'Could not read KB. Make sure Reckons.AI is fully loaded.' });
    return;
  }

  const snap = snapResults?.[0]?.result as KBSnapshot | null | undefined;
  if (!snap) {
    broadcast({ type: 'ERROR', message: 'Could not read KB. Make sure Reckons.AI is fully loaded.' });
    return;
  }

  snapshot = snap;
  await saveSnapshot();

  // Sync highlight settings from the main app into extension storage so the
  // content script picks them up via chrome.storage.onChanged.
  const hlSnap = hlResults?.[0]?.result;
  if (hlSnap) {
    const merged = { ...settings, highlight: hlSnap };
    await chrome.storage.local.set({ settings: merged });
    settings = merged as typeof settings;
  }

  broadcast({ type: 'STATE', state: getState() });
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, sendResponse) => {
  (async () => {
    await _ready; // ensure storage loaded before handling any message
    switch (msg.type) {
      case 'GET_STATE':
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      case 'ANALYZE_PAGE': {
        const focus = (msg as { type: 'ANALYZE_PAGE'; focus?: string }).focus;
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        analyzePage(true, focus);
        break;
      }
      case 'HIGHLIGHT_PAGE':
        await highlightPage();
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      case 'CLEAR_HIGHLIGHTS':
        await clearHighlights();
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      case 'SYNC_KB':
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        syncKB();
        break;
      case 'DISCARD_RESULT':
        result = null;
        highlightsActive = false;
        if (currentTabId) sendToTab(currentTabId, { type: 'CLEAR_HIGHLIGHTS' });
        await saveResult();
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;

      case 'BUILD_PROMPT': {
        // Build the extraction prompt from the current page without calling any LLM.
        // The side panel copies it and lets the user paste it into any external LLM.
        const focusStr = (msg as { type: 'BUILD_PROMPT'; focus?: string }).focus;
        const pageData = await getActiveTabText();
        if (!pageData) {
          sendResponse({ type: 'ERROR', message: 'Cannot read this page.' } satisfies BackgroundEvent);
        } else {
          const prompt = buildPrompt(pageData.text, pageData.url, snapshot, focusStr);
          sendResponse({ type: 'PROMPT_READY', prompt } satisfies BackgroundEvent);
        }
        break;
      }

      case 'PARSE_RESPONSE': {
        // Side panel has collected a pasted LLM response — parse it and set as the analysis result.
        try {
          const raw = (msg as { type: 'PARSE_RESPONSE'; text: string }).text;
          const { triples, summary } = parseLLMResponse(raw);
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          result = {
            url: activeTab?.url ?? '',
            title: activeTab?.title ?? '',
            triples,
            summary,
            analyzedAt: Date.now(),
          };
          await saveResult();
          if (currentTabId) await highlightPage();
        } catch (e) {
          broadcast({ type: 'ERROR', message: e instanceof Error ? e.message : String(e) });
        }
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      }

      case 'OPEN_COMPARE': {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          const tabUrl = activeTab.url ?? '';
          if (!result || result.url !== tabUrl) {
            currentTabId = activeTab.id;
            analyzePage(true); // async — auto-highlights on completion, broadcasts STATE
          } else if (!highlightsActive) {
            currentTabId = activeTab.id;
            highlightPage();
          }
        }
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      }

      case 'OPEN_INGEST': {
        // Kept for popup fallback — not used by side panel
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const pageUrl = activeTab?.url ?? '';
        const ingestUrl = `${settings.reckonsUrl}/ingest?url=${encodeURIComponent(pageUrl)}`;
        chrome.tabs.create({ url: ingestUrl, active: false });
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      }

      case 'DO_INGEST': {
        const ingestMsg = msg as { type: 'DO_INGEST'; url: string; title: string; triples: Array<{ subject: string; predicate: string; object: string; kind: string }> };
        const { reckonsUrl } = settings;
        const reckTabs = await chrome.tabs.query({ url: `${reckonsUrl}/*` });

        if (reckTabs.length === 0) {
          // Reckons.AI not open — open ingest page in background tab (no triples lost)
          chrome.tabs.create({
            url: `${reckonsUrl}/ingest?url=${encodeURIComponent(ingestMsg.url)}`,
            active: false,
          });
          sendResponse({ type: 'INGEST_RESULT', status: 'opened',
            message: 'Reckons.AI not open — ingest page opened as background tab.' } satisfies BackgroundEvent);
          break;
        }

        const reckTab = reckTabs[0];
        if (!reckTab.id) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error',
            message: 'Could not access Reckons.AI tab.' } satisfies BackgroundEvent);
          break;
        }

        try {
          if (ingestMsg.triples.length > 0) {
            // Reuse the extension's already-extracted triples — no re-analysis
            await chrome.scripting.executeScript({
              target: { tabId: reckTab.id },
              world: 'MAIN',
              func: (url: string, title: string, triples: typeof ingestMsg.triples) => {
                return (window as any).__reckonsKB?.ingestTriples(url, title, triples);
              },
              args: [ingestMsg.url, ingestMsg.title, ingestMsg.triples],
            });
            sendResponse({ type: 'INGEST_RESULT', status: 'started',
              message: `${ingestMsg.triples.length} triples sent to Reckons.AI — check Review.` } satisfies BackgroundEvent);
          } else {
            // No triples yet — fall back to full ingest pipeline
            chrome.scripting.executeScript({
              target: { tabId: reckTab.id },
              world: 'MAIN',
              func: (u: string) => { (window as any).__reckonsKB?.ingestUrl(u); },
              args: [ingestMsg.url],
            }).catch(() => {});
            sendResponse({ type: 'INGEST_RESULT', status: 'started',
              message: 'Full ingest started in Reckons.AI.' } satisfies BackgroundEvent);
          }
        } catch (e) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error',
            message: e instanceof Error ? e.message : String(e) } satisfies BackgroundEvent);
        }
        break;
      }
    }
  })();
  return true; // keep message channel open for async response
});

// ── Settings sync from options page ──────────────────────────────────────────

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

// MV3 service workers restart frequently. Store the load promise so message
// handlers can await it — prevents stale defaults being returned before
// chrome.storage resolves (the most common cause of "No API key set").
const _ready = loadState();
