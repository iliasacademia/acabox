import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { shell, app, safeStorage } from 'electron';
import { OAuth2Client } from 'google-auth-library';
import log from 'electron-log';
import { captureError } from '../shared/telemetry';

/**
 * OAuth + Google API client for Docs and Drive integration.
 *
 * Loopback OAuth flow with refresh tokens encrypted at rest via Electron
 * `safeStorage` (OS keychain). Requests Docs (read+write) and Drive
 * (read-only) scopes.
 *
 * OAuth client id + secret come from `process.env.GOOGLE_CLIENT_ID` and
 * `process.env.GOOGLE_CLIENT_SECRET`. In production those are baked into
 * the main bundle at build time via `webpack.DefinePlugin` (see
 * `webpack.main.config.js`). In dev, set them in the shell before launching
 * the app. No user-facing input form — credentials never live in plain
 * settings JSON.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
];

function isRateLimited(err: any): boolean {
  const status = err?.response?.status ?? err?.code;
  if (status === 429) return true;
  if (status === 403) {
    const reason = err?.response?.data?.error?.errors?.[0]?.reason;
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (isRateLimited(err) && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        log.warn(`[GoogleDocs] Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry: unreachable');
}

export interface DocsApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** When true, the caller should redirect the user to reconnect (refresh token revoked). */
  authExpired?: boolean;
}

function getTokensPath(): string {
  return path.join(app.getPath('userData'), 'google-docs-tokens.json');
}

/**
 * Read OAuth tokens from disk. Tokens are encrypted with Electron `safeStorage`
 * (OS keychain) when available, with a graceful fallback to plain JSON for:
 *   - dev environments where keychain integration isn't set up
 *   - tokens written by older builds before encryption was added
 * Decryption errors fall back to JSON parse so a re-encryption can happen on
 * the next write.
 */
function readTokens(): Record<string, unknown> | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(getTokensPath());
  } catch {
    return null;
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const decoded = safeStorage.decryptString(raw);
      return JSON.parse(decoded);
    } catch {
      // Fall through to plain-text path — likely a legacy file written before
      // encryption was added. Re-encryption happens on the next writeTokens.
    }
  }
  try {
    return JSON.parse(raw.toString('utf-8'));
  } catch {
    return null;
  }
}

function writeTokens(tokens: Record<string, unknown>): void {
  const json = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(getTokensPath(), safeStorage.encryptString(json));
  } else {
    fs.writeFileSync(getTokensPath(), json, 'utf-8');
  }
}

function deleteTokens(): void {
  try { fs.unlinkSync(getTokensPath()); } catch { /* ignore */ }
}

function makeOAuth2Client(redirectUri: string): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured. In production this means GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET were not set when the build was made; in dev set them in your shell before launching.');
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

export function hasCredentials(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isConnected(): boolean {
  return readTokens() !== null;
}

export function hasDriveScope(): boolean {
  const tokens = readTokens();
  if (!tokens) return false;
  const scope = tokens.scope as string | undefined;
  if (!scope) return false;
  return scope.includes('drive.readonly');
}

export function hasNativeApiScopes(): boolean {
  const tokens = readTokens();
  if (!tokens) return false;
  const scope = tokens.scope as string | undefined;
  if (!scope) return false;
  return scope.includes('spreadsheets.readonly') && scope.includes('presentations.readonly');
}

export function hasScopeFor(mimeType: string): boolean {
  const tokens = readTokens();
  if (!tokens) return false;
  const scope = tokens.scope as string | undefined;
  if (!scope) return false;
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return scope.includes('auth/documents');
    case 'application/vnd.google-apps.spreadsheet':
      return scope.includes('spreadsheets.readonly');
    case 'application/vnd.google-apps.presentation':
      return scope.includes('presentations.readonly');
    default:
      return false;
  }
}

export function disconnect(): void {
  sharedClient = null;
  deleteTokens();
}

export async function startOAuthFlow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${addr.port}`;
      let oauth2Client: OAuth2Client;
      try {
        oauth2Client = makeOAuth2Client(redirectUri);
      } catch (err) {
        server.close();
        reject(err);
        return;
      }

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
      });

      shell.openExternal(authUrl);

      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Google Docs auth timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      server.on('request', async (req, res) => {
        const url = new URL(req.url!, redirectUri);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        const html = (msg: string) =>
          `<html><body style="font-family:sans-serif;padding:40px"><h2>${msg}</h2><p>You can close this tab.</p></body></html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error) {
          res.end(html('Authorization cancelled.'));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Google OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.end(html('No authorization code received.'));
          clearTimeout(timeout);
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          writeTokens(tokens as Record<string, unknown>);
          res.end(html('Connected to Google! You can return to Academia.'));
          clearTimeout(timeout);
          server.close();
          resolve();
        } catch (err) {
          res.end(html('Error connecting to Google Docs.'));
          clearTimeout(timeout);
          server.close();
          captureError(err, { subsystem: 'auth_oauth_google', extra: { phase: 'token_exchange' } });
          reject(err);
        }
      });
    });

    server.on('error', (err) => reject(err));
  });
}

let sharedClient: OAuth2Client | null = null;
let tokenWriteLock: Promise<void> = Promise.resolve();

/**
 * Get an authenticated OAuth2Client for API calls. Auto-refreshes when the
 * access token expires. Returns null when there are no stored tokens (user
 * hasn't connected) or the refresh token has been revoked.
 *
 * Returns a shared singleton so concurrent callers reuse the same client and
 * don't trigger parallel token refreshes.
 */
export async function getAuthedClient(): Promise<OAuth2Client | null> {
  const tokens = readTokens();
  if (!tokens) {
    sharedClient = null;
    return null;
  }
  if (sharedClient) return sharedClient;
  let oauth2Client: OAuth2Client;
  try {
    oauth2Client = makeOAuth2Client('http://127.0.0.1');
  } catch {
    return null;
  }
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    tokenWriteLock = tokenWriteLock.then(() => {
      const current = readTokens() ?? {};
      writeTokens({ ...current, ...newTokens });
    });
  });
  sharedClient = oauth2Client;
  return sharedClient;
}

/**
 * Render a single ParagraphElement as plain text. Smart chips (dates, people,
 * calendar events, file references) come back as `richLink` / `person` —
 * dropping them entirely loses doc structure (e.g. `"May 4, 2026 | 📅 Writing
 * Agent Standup"` becomes `"  |  "` if only `textRun` is read), so each chip
 * type emits the best available label.
 */
function renderParagraphElement(pe: any): string {
  if (pe?.textRun?.content) return pe.textRun.content;
  if (pe?.autoText?.content) return pe.autoText.content;
  if (pe?.person?.personProperties) {
    const p = pe.person.personProperties;
    return `⟦@${p.name || p.email || 'person'}⟧`;
  }
  if (pe?.richLink?.richLinkProperties) {
    const r = pe.richLink.richLinkProperties;
    return `⟦${r.title || r.uri || 'link'}⟧`;
  }
  if (pe?.equation) return '⟦equation⟧';
  if (pe?.horizontalRule) return '\n---\n';
  if (pe?.pageBreak || pe?.columnBreak) return '\n';
  if (pe?.footnoteReference) return '';
  if (pe?.inlineObjectElement) return '⟦image⟧';
  return '';
}

/**
 * Walk a Docs API `documents.get` response and concatenate every text run into
 * a single plain-text string. Handles top-level body, table cells, and the
 * multi-tab structure (`tabs[]` with optional `childTabs`). Tabs are separated
 * by their title for readability.
 */
function extractPlainText(doc: any): string {
  const parts: string[] = [];

  function walkBody(body: any): void {
    if (!body?.content) return;
    for (const elem of body.content) {
      if (elem.paragraph?.elements) {
        for (const pe of elem.paragraph.elements) {
          parts.push(renderParagraphElement(pe));
        }
      } else if (elem.table?.tableRows) {
        for (const row of elem.table.tableRows) {
          for (const cell of row.tableCells || []) {
            walkBody({ content: cell.content });
          }
        }
      }
    }
  }

  function walkTab(tab: any, depth: number): void {
    const title = tab?.tabProperties?.title;
    if (title) parts.push(`\n--- Tab: ${title} ---\n`);
    walkBody(tab?.documentTab?.body);
    for (const child of tab?.childTabs ?? []) walkTab(child, depth + 1);
  }

  if (Array.isArray(doc?.tabs) && doc.tabs.length > 0) {
    for (const tab of doc.tabs) walkTab(tab, 0);
  } else {
    walkBody(doc?.body);
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n');
}

/**
 * Read the full text of a Google Doc by id. Includes content from all tabs
 * when the doc uses the Document Tabs feature.
 */
export async function getDocText(documentId: string): Promise<DocsApiResult<{ text: string; title: string }>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google Docs' };

  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?includeTabsContent=true`;
  try {
    const resp = await withRetry(() => client.request<any>({ url, method: 'GET' }));
    const text = extractPlainText(resp.data);
    const title = (resp.data?.title as string | undefined) ?? '';
    return { success: true, data: { text, title } };
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    if (status === 401) {
      return { success: false, error: 'Google session expired. Please reconnect in Settings.', authExpired: true };
    }
    if (status === 429 || isRateLimited(err)) {
      return { success: false, error: 'Google Docs rate limit exceeded. Please try again in a moment.' };
    }
    if (status === 403) {
      return { success: false, error: 'Google denied access. Either the doc is restricted or the OAuth scope is missing.' };
    }
    if (status === 404) {
      return { success: false, error: 'Document not found. The id may be wrong, or you may not have access to this doc.' };
    }
    return { success: false, error: `Docs API error${status ? ' ' + status : ''}: ${err?.message ?? String(err)}` };
  }
}

/**
 * List every tabId in a doc (including nested `childTabs`). Returns an empty
 * array for legacy non-tabbed docs; in that case the caller should omit
 * `tabsCriteria` and let the API apply to the body. Errors are swallowed —
 * if the lookup fails we fall back to the no-tabsCriteria path so the call
 * still does *something* on single-tab docs.
 */
async function listAllTabIds(client: OAuth2Client, documentId: string): Promise<string[]> {
  try {
    const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?includeTabsContent=true&fields=tabs(tabProperties(tabId),childTabs)`;
    const resp = await withRetry(() => client.request<any>({ url, method: 'GET' }));
    const ids: string[] = [];
    function walk(tabs: any[] | undefined): void {
      for (const t of tabs ?? []) {
        const id = t?.tabProperties?.tabId;
        if (id) ids.push(id);
        walk(t?.childTabs);
      }
    }
    walk(resp.data?.tabs);
    return ids;
  } catch {
    return [];
  }
}

/**
 * Apply find-and-replace to a doc using `documents.batchUpdate`. Always uses
 * `replaceAllText` (Docs API doesn't have a "first-occurrence-only" mode);
 * when the caller asks for `first` we still call replaceAllText but the agent
 * is responsible for picking a search string unique enough to match once.
 *
 * For multi-tab documents we first list every tab id (including nested
 * `childTabs`) and pass them via `tabsCriteria.tabIds`. Without that, the
 * Docs API only applies the replacement to the first tab.
 */
export async function findAndReplace(
  documentId: string,
  searchText: string,
  replaceText: string,
  matchCase: boolean,
): Promise<DocsApiResult<{ replacementsCount: number }>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google Docs' };

  const tabIds = await listAllTabIds(client, documentId);

  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`;
  const body: any = {
    requests: [
      {
        replaceAllText: {
          containsText: { text: searchText, matchCase },
          replaceText,
          ...(tabIds.length > 0 ? { tabsCriteria: { tabIds } } : {}),
        },
      },
    ],
  };
  try {
    const resp = await withRetry(() => client.request<any>({ url, method: 'POST', data: body }));
    const occurrences = resp.data?.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
    return { success: true, data: { replacementsCount: occurrences } };
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    if (status === 401) {
      return { success: false, error: 'Google session expired. Please reconnect in Settings.', authExpired: true };
    }
    if (status === 429 || isRateLimited(err)) {
      return { success: false, error: 'Google Docs rate limit exceeded. Please try again in a moment.' };
    }
    if (status === 403) {
      return { success: false, error: 'You do not have edit access to this document.' };
    }
    if (status === 404) {
      return { success: false, error: 'Document not found.' };
    }
    return { success: false, error: `Docs API error${status ? ' ' + status : ''}: ${err?.message ?? String(err)}` };
  }
}
