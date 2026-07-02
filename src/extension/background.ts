/**
 * Extension background service worker.
 * Handles LLM calls, KB sync, and coordinates popup ↔ content script.
 */
import type {
  ExtSettings, KBSnapshot, AnalysisResult, ResearchSession, ExtractedTriple, DiffSummary,
  ExtensionState, PopupRequest, BackgroundEvent, ContentCommand, ContentResponse,
  LiveClaim, LiveSession, LexicalSnapshot, LiveVerdict,
} from './types';
import { DEFAULT_SETTINGS } from './types';

// ── In-memory state (lost on service worker restart, backed by storage) ──────

let settings: ExtSettings = { ...DEFAULT_SETTINGS };
let snapshot: KBSnapshot | null = null;
let result: AnalysisResult | null = null;
let session: ResearchSession = { pages: [], startedAt: Date.now() };
let analyzing = false;
let highlightsActive = false;
let currentTabId: number | null = null;

// ── Live stream state ───────────────────────────────────────────────────────
let liveStreaming = false;
let fcSession: LiveSession | null = null;
let fcTabId: number | null = null;
let fcSpeakerIdToName: Record<number, string> = {};
let fcConfirmedSpeakers = new Set<number>();
let fcSentenceWindow: Array<{ text: string; speakerId: number | null }> = [];
let fcSentenceCount = 0;
let fcWindowLexical: LexicalSnapshot = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
let fcWindowStartTime: number | null = null;
let fcRecentClaims = new Map<string, [number, string]>();
let fcKeepAliveInterval: ReturnType<typeof setInterval> | null = null;
const FC_WINDOW_SIZE = 4;
const FC_WINDOW_KEEP = 15;
const FC_DEDUP_MS = 120000;

// ── Persistence ───────────────────────────────────────────────────────────────

async function loadState() {
  const stored = await chrome.storage.local.get(['settings', 'snapshot', 'result', 'session', 'fcSession']);
  if (stored.settings) settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  if (stored.snapshot) snapshot = stored.snapshot;
  if (stored.result) result = stored.result;
  if (stored.session) session = stored.session;
  if (stored.fcSession) fcSession = stored.fcSession;
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

async function saveSession() {
  await chrome.storage.local.set({ session });
}

function getState(): ExtensionState {
  return { settings, snapshot, result, session, analyzing, highlightsActive, currentTabId, liveStreaming, liveSession: fcSession };
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

    // Accumulate into research session (replace if same URL already analyzed)
    const existingIdx = session.pages.findIndex(p => p.url === result!.url);
    if (existingIdx >= 0) {
      session.pages[existingIdx] = result;
    } else {
      session.pages.push(result);
    }
    await saveSession();

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
    broadcast({ type: 'ERROR', message: 'Could not read graph. Make sure Reckons.AI is fully loaded.' });
    return;
  }

  const snap = snapResults?.[0]?.result as KBSnapshot | null | undefined;
  if (!snap) {
    broadcast({ type: 'ERROR', message: 'Could not read graph. Make sure Reckons.AI is fully loaded.' });
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

chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender: any, sendResponse: any) => {
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
          // Accumulate into session
          const existingIdx = session.pages.findIndex(p => p.url === result!.url);
          if (existingIdx >= 0) session.pages[existingIdx] = result;
          else session.pages.push(result);
          await saveSession();
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

      case 'CLEAR_SESSION':
        session = { pages: [], startedAt: Date.now() };
        await saveSession();
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;

      case 'REMOVE_SESSION_PAGE': {
        const removeUrl = (msg as { type: 'REMOVE_SESSION_PAGE'; url: string }).url;
        session.pages = session.pages.filter(p => p.url !== removeUrl);
        await saveSession();
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      }

      case 'INGEST_SESSION': {
        const ingestKinds = (msg as { type: 'INGEST_SESSION'; kinds: string[] }).kinds;
        const allTriples = session.pages.flatMap(p =>
          p.triples.filter(t => ingestKinds.includes(t.kind))
        );
        if (allTriples.length === 0) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error',
            message: 'No triples matching the selected categories.' } satisfies BackgroundEvent);
          break;
        }
        const { reckonsUrl } = settings;
        const reckTabs = await chrome.tabs.query({ url: `${reckonsUrl}/*` });
        if (reckTabs.length === 0 || !reckTabs[0].id) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error',
            message: `Reckons.AI not open. Open ${reckonsUrl} first.` } satisfies BackgroundEvent);
          break;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: reckTabs[0].id },
            world: 'MAIN',
            func: (url: string, title: string, triples: Array<{ subject: string; predicate: string; object: string; kind: string }>) => {
              return (window as any).__reckonsKB?.ingestTriples(url, title, triples);
            },
            args: [
              'urn:reckons:session:' + session.startedAt,
              `Research Session — ${allTriples.length} triples from ${session.pages.length} pages`,
              allTriples.map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, kind: t.kind })),
            ],
          });
          sendResponse({ type: 'INGEST_RESULT', status: 'started',
            message: `${allTriples.length} triples from ${session.pages.length} pages sent to Reckons.AI.` } satisfies BackgroundEvent);
        } catch (e) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error',
            message: e instanceof Error ? e.message : String(e) } satisfies BackgroundEvent);
        }
        break;
      }

      case 'START_LIVE': {
        try {
          await startLiveStream();
          sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        } catch (e) {
          sendResponse({ type: 'ERROR', message: e instanceof Error ? e.message : String(e) } satisfies BackgroundEvent);
        }
        break;
      }

      case 'STOP_LIVE': {
        stopLiveStream();
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      }

      case 'CONFIRM_LIVE_SPEAKER': {
        const { speakerId, name } = msg as { type: 'CONFIRM_LIVE_SPEAKER'; speakerId: number; name: string };
        if (!fcConfirmedSpeakers.has(speakerId)) {
          fcSpeakerIdToName[speakerId] = name;
          fcConfirmedSpeakers.add(speakerId);
        }
        sendResponse({ type: 'STATE', state: getState() } satisfies BackgroundEvent);
        break;
      }

      case 'INGEST_LIVE_CLAIMS': {
        const kinds = (msg as { type: 'INGEST_LIVE_CLAIMS'; kinds: LiveVerdict[] }).kinds;
        if (!fcSession || fcSession.claims.length === 0) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error', message: 'No claims to ingest.' } satisfies BackgroundEvent);
          break;
        }
        const filtered = fcSession.claims.filter(c => kinds.includes(c.verdict));
        if (filtered.length === 0) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error', message: 'No claims matching selected categories.' } satisfies BackgroundEvent);
          break;
        }
        const { reckonsUrl } = settings;
        const reckTabs = await chrome.tabs.query({ url: `${reckonsUrl}/*` });
        if (reckTabs.length === 0 || !reckTabs[0].id) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error', message: `Reckons.AI not open. Open ${reckonsUrl} first.` } satisfies BackgroundEvent);
          break;
        }
        try {
          const triples = filtered.map(c => ({
            subject: c.triple.subject, predicate: c.triple.predicate, object: c.triple.object,
            kind: c.verdict === 'KB_CONFIRMED' ? 'reinforce' : c.verdict === 'KB_CONFLICT' ? 'conflict' : 'new',
          }));
          await chrome.scripting.executeScript({
            target: { tabId: reckTabs[0].id },
            world: 'MAIN',
            func: (url: string, title: string, t: any[]) => (window as any).__reckonsKB?.ingestTriples(url, title, t),
            args: [fcSession.pageUrl, `Live session — ${filtered.length} claims`, triples],
          });
          sendResponse({ type: 'INGEST_RESULT', status: 'started', message: `${filtered.length} claims sent to Reckons.AI.` } satisfies BackgroundEvent);
        } catch (e) {
          sendResponse({ type: 'INGEST_RESULT', status: 'error', message: e instanceof Error ? e.message : String(e) } satisfies BackgroundEvent);
        }
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

      // ── Messages from offscreen / content script ───────────────────────
      case 'TRANSCRIPT_RESULT' as any: {
        const tr = msg as any;
        if (tr.isFinal) {
          if (tr.speaker !== null && tr.speaker !== undefined) {
            fcCurrentSpeakerId = tr.speaker;
            if (fcTabId && !fcConfirmedSpeakers.has(fcCurrentSpeakerId!) && !fcSpeakerIdToName[fcCurrentSpeakerId!]) {
              chrome.tabs.sendMessage(fcTabId, {
                type: 'LIVE_SPEAKER', speakerId: fcCurrentSpeakerId, sample: tr.text.slice(0, 80),
              } as ContentCommand).catch(() => {});
            }
          }
          onFCSentence(tr.text, fcCurrentSpeakerId);
        }
        if (fcTabId) {
          chrome.tabs.sendMessage(fcTabId, {
            type: 'LIVE_TRANSCRIPT', text: tr.text, isFinal: !!tr.isFinal, interim: !!tr.interim, speaker: tr.speaker,
          } as ContentCommand).catch(() => {});
        }
        sendResponse({});
        break;
      }
      case 'PIPELINE_ERROR' as any: {
        if (fcTabId) {
          chrome.tabs.sendMessage(fcTabId, {
            type: 'LIVE_ERROR', message: (msg as any).message || 'Pipeline error',
          } as ContentCommand).catch(() => {});
        }
        sendResponse({});
        break;
      }
      case 'KEEPALIVE' as any: {
        sendResponse({});
        break;
      }
    }
  })();
  return true; // keep message channel open for async response
});

// ── Live stream: lexical analysis ────────────────────────────────────────────

const HEDGING   = ['think','believe','maybe','perhaps','probably','might','could','seem','appears','guess','suppose','somewhat'];
const CERTAINTY = ['definitely','certainly','absolutely','always','never','clearly','obviously','undoubtedly','exactly','proven'];
const FILLER    = ['um','uh','like','basically','actually','literally','right','okay'];
const EMOTIONAL = ['disaster','terrible','horrible','amazing','incredible','great','awful','fantastic','disgusting','wonderful','worst','best'];
const EXCLUSIVE = ['but','except','however','although','unless','without','exclude'];
const FP_SG     = ['i','me','my','mine','myself'];

function extractLexical(text: string): LexicalSnapshot {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const total = words.length || 1;
  const rate = (list: string[]) => Math.round(words.filter(w => list.some(h => w.includes(h))).length / total * 100);
  return {
    rates: {
      hedging: rate(HEDGING), certainty: rate(CERTAINTY), filler: rate(FILLER),
      emotional: rate(EMOTIONAL), exclusive: rate(EXCLUSIVE),
      firstPersonSg: Math.round(words.filter(w => FP_SG.includes(w)).length / total * 100),
    },
    wordsPerSecond: null, wordCount: total,
  };
}

function buildLexicalSummary(f: LexicalSnapshot): string {
  const r = f.rates;
  const notes: string[] = [];
  if (r.hedging > 8)       notes.push(`hedging language (${r.hedging}%)`);
  if (r.certainty > 8)     notes.push(`certainty markers (${r.certainty}%)`);
  if (r.filler > 8)        notes.push(`filler words (${r.filler}%)`);
  if (r.emotional > 8)     notes.push(`emotional language (${r.emotional}%)`);
  if (r.exclusive > 8)     notes.push(`qualifying words (${r.exclusive}%)`);
  if (r.firstPersonSg > 8) notes.push(`first-person singular (${r.firstPersonSg}%)`);
  if (f.wordsPerSecond) {
    const pace = f.wordsPerSecond > 3.5 ? 'fast' : f.wordsPerSecond < 2 ? 'slow' : 'moderate';
    notes.push(`speech rate ${f.wordsPerSecond} w/s (${pace})`);
  }
  return notes.length ? `Features detected: ${notes.join(', ')}.` : 'Neutral delivery.';
}

// ── Live stream: claim dedup ────────────────────────────────────────────────

function normClaimKey(claim: string): string {
  return claim.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 4).sort().join(' ');
}

function isDuplicateClaim(claim: string): boolean {
  const key = normClaimKey(claim);
  const now = Date.now();
  for (const [k, v] of fcRecentClaims) { if (now - v[0] > FC_DEDUP_MS) fcRecentClaims.delete(k); }
  if (fcRecentClaims.has(key)) return true;
  const keyWords = new Set(key.split(' ').filter(Boolean));
  for (const [k] of fcRecentClaims) {
    const kWords = k.split(' ').filter(Boolean);
    if (kWords.filter(w => keyWords.has(w)).length / Math.max(keyWords.size, kWords.length) >= 0.35) return true;
  }
  fcRecentClaims.set(key, [now, claim]);
  return false;
}

// ── Live stream: speaker helpers ────────────────────────────────────────────

function parseSpeakersFromTitle(title: string): string[] {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = (name: string) => name.trim().split(' ').pop()!;
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

// ── Live stream: KB evaluation prompt ───────────────────────────────────────

function buildFCPrompt(contextText: string, title: string, lexicalSummary: string, snap: KBSnapshot | null): string {
  const entityList = snap
    ? snap.entities.slice(0, 40)
        .map(e => `  - ${e.label}${e.type ? ` [${e.type}]` : ''}: ${e.predicates.slice(0, 3).join(', ')}`)
        .join('\n')
    : '  (no KB snapshot — all claims will be marked KB_NEW)';

  const titleCtx = title ? `Source: "${title}"\n` : '';
  const lexCtx = lexicalSummary ? `\nLexical analysis: ${lexicalSummary}` : '';

  const checkedList = [...fcRecentClaims.values()]
    .filter(v => v[1]).map(v => v[1]).slice(-15).join('\n- ');
  const alreadyChecked = checkedList
    ? `\n\nClaims already checked — do NOT re-evaluate these or close variants:\n- ${checkedList}\n`
    : '';

  return `You are analyzing live speech against a personal knowledge base (KB). Extract check-worthy factual claims and compare them with the KB.

${titleCtx}Transcript: "${contextText}"${alreadyChecked}${lexCtx}

KNOWLEDGE BASE (${snap?.entityCount ?? 0} entities):
${entityList}

For each check-worthy factual claim, output a JSON array:
[
  {
    "claim": "concise claim statement",
    "verdict": "KB_CONFIRMED" | "KB_CONFLICT" | "KB_NEW" | "UNVERIFIABLE",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "explanation": "brief explanation referencing KB entities when applicable",
    "speaker": "speaker name or null",
    "speaker_confidence": "HIGH" | "MEDIUM" | "LOW",
    "triple": { "subject": "...", "predicate": "...", "object": "..." },
    "conflictNote": "what specific KB fact it contradicts (only for KB_CONFLICT)"
  }
]

Rules:
- Only extract CHECK-WORTHY factual claims (statistics, events, policies, scientific facts, stated relationships)
- Skip opinions, predictions, rhetorical questions, value judgments
- KB_CONFIRMED: claim aligns with or is supported by specific KB facts
- KB_CONFLICT: claim directly contradicts a specific KB fact — cite it in conflictNote
- KB_NEW: relevant factual claim about topics in the KB but with new/unknown details
- UNVERIFIABLE: KB has relevant entities but insufficient detail to verify
- Generate a structured triple (subject, predicate, object) for each claim
- Output only valid JSON array — no markdown, no prose`;
}

function parseFCResponse(raw: string): LiveClaim[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return arr.filter((r: any) => r.claim && r.verdict);
  } catch { return []; }
}

// ── Live stream: rolling window pipeline ────────────────────────────────────

let fcCurrentSpeakerId: number | null = null;

function resetFCWindow() {
  fcSentenceWindow = [];
  fcSentenceCount = 0;
  fcWindowLexical = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
  fcWindowStartTime = null;
  fcCurrentSpeakerId = null;
  fcSpeakerIdToName = {};
  fcConfirmedSpeakers = new Set();
  fcRecentClaims = new Map();
}

async function onFCSentence(text: string, speakerId: number | null) {
  const name = (speakerId !== null) ? fcSpeakerIdToName[speakerId] : null;
  const label = name ? `[${name}]` : (speakerId !== null ? `[Speaker ${speakerId}]` : null);
  const labeled = label ? `${label} ${text}` : text;

  fcSentenceWindow.push({ text: labeled, speakerId });
  if (fcSentenceWindow.length > FC_WINDOW_KEEP) fcSentenceWindow.shift();
  fcSentenceCount++;

  if (!fcWindowStartTime) fcWindowStartTime = Date.now();

  // Accumulate lexical
  const f = extractLexical(text);
  const r = f.rates, wr = fcWindowLexical.rates;
  wr.hedging       = Math.round((wr.hedging       + r.hedging)       / 2);
  wr.certainty     = Math.round((wr.certainty     + r.certainty)     / 2);
  wr.filler        = Math.round((wr.filler        + r.filler)        / 2);
  wr.emotional     = Math.round((wr.emotional     + r.emotional)     / 2);
  wr.exclusive     = Math.round((wr.exclusive     + r.exclusive)     / 2);
  wr.firstPersonSg = Math.round((wr.firstPersonSg + r.firstPersonSg) / 2);
  fcWindowLexical.wordCount += f.wordCount;

  if (fcSentenceCount % FC_WINDOW_SIZE === 0) {
    const contextText = fcSentenceWindow.map(s => s.text).join(' ');

    // Dominant speaker
    const counts: Record<string, number> = {};
    fcSentenceWindow.forEach(s => {
      if (s.speakerId !== null) counts[s.speakerId] = (counts[s.speakerId] || 0) + 1;
    });
    const domId = Object.keys(counts).length
      ? parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0])
      : null;
    const domSpeaker = domId !== null ? (fcSpeakerIdToName[domId] || null) : null;

    // Speech rate
    const elapsed = fcWindowStartTime ? (Date.now() - fcWindowStartTime) / 1000 : null;
    if (elapsed && elapsed > 0) fcWindowLexical.wordsPerSecond = Math.round(fcWindowLexical.wordCount / elapsed * 10) / 10;
    fcWindowStartTime = null;

    const lexSnap = JSON.parse(JSON.stringify(fcWindowLexical)) as LexicalSnapshot;
    const lexSummary = buildLexicalSummary(lexSnap);

    // Reset for next window
    fcWindowLexical = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };

    try {
      await evaluateFCClaims(contextText, lexSummary, lexSnap, domSpeaker);
    } catch (e) {
      console.error('[fc-pipeline] error:', e);
    }
  }
}

async function evaluateFCClaims(contextText: string, lexSummary: string, lexSnap: LexicalSnapshot, domSpeaker: string | null) {
  const title = fcSession?.pageTitle ?? '';
  const prompt = buildFCPrompt(contextText, title, lexSummary, snapshot);

  try {
    const raw = await callLLM(prompt);
    const results = parseFCResponse(raw);
    const valid = results.filter(r => !isDuplicateClaim(r.claim));
    if (!valid.length) return;

    const claims: LiveClaim[] = valid.map(r => ({
      ...r,
      speaker: domSpeaker || (r.speaker && !/^Speaker\s*\d+$/i.test(r.speaker) ? r.speaker : null),
      pending: false,
      lexical: lexSnap,
    }));

    // Add to session
    if (fcSession) fcSession.claims.push(...claims);
    await chrome.storage.local.set({ fcSession });

    // Send to overlay
    if (fcTabId) {
      chrome.tabs.sendMessage(fcTabId, { type: 'LIVE_VERDICT', claims } as ContentCommand).catch(() => {});
    }
    broadcast({ type: 'STATE', state: getState() });
  } catch (e) {
    console.error('[fc-pipeline] LLM error:', e);
    if (fcTabId) {
      chrome.tabs.sendMessage(fcTabId, {
        type: 'LIVE_ERROR', message: e instanceof Error ? e.message : String(e),
      } as ContentCommand).catch(() => {});
    }
  }
}

// ── Live stream: start / stop ───────────────────────────────────────────────

async function startLiveStream() {
  if (liveStreaming) return;

  if (!settings.apiKey) throw new Error('No LLM API key set. Open extension settings to add one.');

  const deepgramKey = settings.deepgramApiKey;
  const captureMode = deepgramKey ? 'deepgram' : 'whisper';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  fcTabId = tab.id;

  // Create offscreen document
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as any] });
  if ((existing as any[]).length === 0) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['USER_MEDIA' as any],
      justification: 'Capture tab audio for real-time transcription',
    });
  }

  // Get tab capture stream
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: fcTabId! }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });

  // Start capture in offscreen doc
  const resp = await chrome.runtime.sendMessage({ type: 'START_CAPTURE', streamId, deepgramKey, mode: captureMode });
  if (!resp?.ok) throw new Error('Failed to start audio capture: ' + (resp?.error || 'unknown'));

  // Initialize state
  liveStreaming = true;
  resetFCWindow();

  const speakers = parseSpeakersFromTitle(tab.title ?? '');
  fcSession = {
    claims: [],
    startedAt: Date.now(),
    pageTitle: tab.title ?? '',
    pageUrl: tab.url ?? '',
    speakers,
  };
  await chrome.storage.local.set({ fcSession });

  // Tell content script to show overlay
  chrome.tabs.sendMessage(fcTabId!, { type: 'LIVE_START', speakers } as ContentCommand).catch(() => {});

  fcKeepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  broadcast({ type: 'STATE', state: getState() });
}

function stopLiveStream() {
  if (!liveStreaming) return;

  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
  chrome.offscreen.closeDocument().catch(() => {});

  if (fcTabId) {
    chrome.tabs.sendMessage(fcTabId, { type: 'LIVE_STOP' } as ContentCommand).catch(() => {});
  }

  liveStreaming = false;
  fcTabId = null;
  resetFCWindow();

  if (fcKeepAliveInterval) { clearInterval(fcKeepAliveInterval); fcKeepAliveInterval = null; }

  broadcast({ type: 'STATE', state: getState() });
}

// ── Settings sync from options page ──────────────────────────────────────────

chrome.storage.onChanged.addListener((changes: any) => {
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

// MV3 service workers restart frequently. Store the load promise so message
// handlers can await it — prevents stale defaults being returned before
// chrome.storage resolves (the most common cause of "No API key set").
const _ready = loadState();
