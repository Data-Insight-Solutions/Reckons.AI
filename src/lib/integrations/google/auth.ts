/**
 * Google Identity Services (GIS) OAuth 2.0 — implicit / token flow.
 * Token lives only in memory; nothing is ever persisted to disk or localStorage.
 * Scopes cover Drive (app-scoped files only) and Calendar (full read/write).
 */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar'
].join(' ');

type TokenClient = {
  requestAccessToken: (opts?: { prompt?: string }) => void;
  callback: (resp: TokenResponse) => void;
};

type TokenResponse = {
  access_token: string;
  expires_in: number;
  error?: string;
  error_description?: string;
};

let tokenClient: TokenClient | null = null;
let accessToken: string | null = null;
let tokenExpiry = 0;
let initializedClientId = '';

/** Lazy-load the GIS script once. */
function loadGIS(): Promise<void> {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="accounts.google.com/gsi"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
}

/** Initialize the token client for a given OAuth client ID. */
export async function initGoogle(clientId: string): Promise<void> {
  if (initializedClientId === clientId && tokenClient) return;
  await loadGIS();
  initializedClientId = clientId;
  tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: () => {} // overridden per-request in signIn()
  });
}

export function isSignedIn(): boolean {
  return accessToken !== null && Date.now() < tokenExpiry;
}

/** Returns the current access token or throws if not authenticated. */
export function getToken(): string {
  if (!accessToken || Date.now() >= tokenExpiry) {
    throw new Error('Not signed in to Google. Please connect your account in Settings.');
  }
  return accessToken;
}

/**
 * Open the Google consent popup and acquire a token.
 * Uses `prompt: ''` so the popup is skipped if consent was already granted.
 */
export async function signIn(clientId: string): Promise<void> {
  await initGoogle(clientId);
  return new Promise((resolve, reject) => {
    tokenClient!.callback = (resp: TokenResponse) => {
      if (resp.error) {
        reject(new Error(resp.error_description ?? resp.error));
        return;
      }
      accessToken = resp.access_token;
      // Expire 60 s early so we re-auth before the token actually dies
      tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      resolve();
    };
    tokenClient!.requestAccessToken({ prompt: '' });
  });
}

export function signOut(): void {
  if (accessToken) {
    (window as any).google?.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiry = 0;
}

/** Sign in if not already authenticated. */
export async function ensureAuth(clientId: string): Promise<void> {
  if (!isSignedIn()) await signIn(clientId);
}
