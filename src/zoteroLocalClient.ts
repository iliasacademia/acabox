/**
 * Zotero local client integration.
 *
 * Talks to the Zotero connector HTTP server (127.0.0.1:23119) that ships with
 * the Zotero desktop client — the same endpoints the browser connector uses.
 *
 * - getZoteroLocalStatus(): probes the connector and falls back to filesystem
 *   checks for the app bundle so the renderer can disable the button when
 *   Zotero is not installed.
 * - addDoiToZotero(): launches Zotero if needed, fetches Crossref metadata for
 *   the DOI, maps it to a Zotero connector item, and POSTs to /connector/saveItems.
 */
import { app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { defaultLogger as logger } from './utils/logger';
import { getPublicationByDoi, type SlimPublication } from './cobuilding/main/citeright/reportSummary';

// Resolved lazily — writingAgentMain.ts overrides app.setPath('userData', ...) at module
// load, so capturing this value at import time would point to the wrong directory.
function getAddedDoisFile(): string {
  return path.join(app.getPath('userData'), 'zotero-added-dois.json');
}

/**
 * Persistent set of DOIs the user has successfully added to Zotero through us.
 * Shared between the desktop renderer (IPC) and the overlay (HTTP) so the "Added /
 * Open in Zotero" state is consistent across surfaces. Best-effort hint — a DOI
 * removed from Zotero externally still shows here, but the worst case is an empty
 * Zotero search when the user clicks "Open".
 */
function loadAddedDois(): Set<string> {
  try {
    const file = getAddedDoisFile();
    if (!fs.existsSync(file)) return new Set();
    const raw = fs.readFileSync(file, 'utf-8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    logger.warn('[Zotero] Failed to load added DOIs:', err);
    return new Set();
  }
}

let addedDoisCache: Set<string> | null = null;

function getAddedDoisSet(): Set<string> {
  if (!addedDoisCache) addedDoisCache = loadAddedDois();
  return addedDoisCache;
}

function persistAddedDois(): void {
  if (!addedDoisCache) return;
  try {
    fs.writeFileSync(getAddedDoisFile(), JSON.stringify([...addedDoisCache]), 'utf-8');
  } catch (err) {
    logger.warn('[Zotero] Failed to persist added DOIs:', err);
  }
}

function normalizeDoi(rawDoi: string): string {
  return rawDoi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/[.,;:]+$/, '').toLowerCase();
}

export function listAddedDois(): string[] {
  return [...getAddedDoisSet()];
}

function markDoiAdded(doi: string): void {
  const set = getAddedDoisSet();
  const before = set.size;
  set.add(normalizeDoi(doi));
  if (set.size !== before) persistAddedDois();
}

function markDoisAdded(dois: string[]): void {
  const set = getAddedDoisSet();
  const before = set.size;
  for (const d of dois) {
    const n = normalizeDoi(d);
    if (n) set.add(n);
  }
  if (set.size !== before) persistAddedDois();
}

// DOI → Zotero open info, populated as the agent's MCP tools surface items.
// Lets `openZoteroForDoi` jump straight to a specific item via
// `zotero://select/...` instead of `zotero://search?q=...` (which only opens
// Zotero's search panel).
interface DoiOpenInfo { key: string; libraryId?: number; libraryType?: string }
const doiOpenInfo = new Map<string, DoiOpenInfo>();

function recordOpenInfo(item: ZoteroSlimItem): void {
  if (!item.DOI || !item.key) return;
  doiOpenInfo.set(normalizeDoi(item.DOI), {
    key: item.key,
    libraryId: item.libraryId,
    libraryType: item.libraryType,
  });
}

function buildZoteroOpenUrl(rawDoi: string): string {
  const info = doiOpenInfo.get(normalizeDoi(rawDoi));
  if (info?.key) {
    if (info.libraryType === 'group' && info.libraryId) {
      return `zotero://select/groups/${info.libraryId}/items/${info.key}`;
    }
    return `zotero://select/library/items/${info.key}`;
  }
  return `zotero://search?q=${encodeURIComponent(rawDoi)}`;
}

// Open a Zotero item by DOI. Shells out to the OS launcher directly to avoid
// the "Allow this site to open zotero…" prompt that `shell.openExternal` /
// browser-based URL launches trigger on macOS.
export async function openZoteroForDoi(rawDoi: string): Promise<void> {
  const url = buildZoteroOpenUrl(rawDoi);
  const { spawn } = await import('child_process');
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const ZOTERO_CONNECTOR_BASE = 'http://127.0.0.1:23119';
const PING_TIMEOUT_MS = 1500;
const LAUNCH_WAIT_MS = 12000;
const LAUNCH_POLL_INTERVAL_MS = 500;

export type ZoteroLocalStatus = 'running' | 'not-running' | 'not-installed';

export interface AddDoiResult {
  success: boolean;
  error?: string;
  status: ZoteroLocalStatus;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function pingConnector(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${ZOTERO_CONNECTOR_BASE}/connector/ping`, { method: 'GET' }, PING_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

function isZoteroInstalled(): boolean {
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Zotero.app',
      path.join(process.env.HOME || '', 'Applications', 'Zotero.app'),
    ];
    return candidates.some(p => p && fs.existsSync(p));
  }
  if (process.platform === 'win32') {
    const candidates = [
      process.env['ProgramFiles'] && path.join(process.env['ProgramFiles']!, 'Zotero', 'zotero.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'Zotero', 'zotero.exe'),
      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA']!, 'Zotero', 'zotero.exe'),
    ].filter(Boolean) as string[];
    return candidates.some(p => fs.existsSync(p));
  }
  // Linux: detection is unreliable without spawning `which`. Assume installed and let
  // the launch step fail gracefully if not.
  return true;
}

export async function getZoteroLocalStatus(): Promise<ZoteroLocalStatus> {
  if (await pingConnector()) return 'running';
  if (!isZoteroInstalled()) return 'not-installed';
  return 'not-running';
}

/**
 * Best-effort lookup against Zotero's local web API to see if a DOI already
 * lives in the user's library. Requires Zotero 7's local API (default-on for
 * read access since Zotero 7.0; older Zoteros return 404, in which case we
 * remember the endpoint is unavailable and stop hammering it.
 *
 * Cache windows: 60s for boolean results so a freshly-added item shows up on
 * next render; 5min for "unknown" so we don't burn 3s timeouts per button when
 * the local API isn't there at all.
 */
const checkCache = new Map<string, { exists: boolean | null; at: number }>();
const CHECK_TTL_BOOL_MS = 60_000;
const CHECK_TTL_UNKNOWN_MS = 5 * 60_000;
const inflightChecks = new Map<string, Promise<boolean | null>>();

// Once we see a 404/401/403 from the local API, suppress further attempts for a
// while — the user would have to enable the API in Zotero prefs and restart it,
// and we don't want every button retrying every render.
let localApiUnavailableUntil = 0;

export async function checkDoiInZotero(rawDoi: string): Promise<boolean | null> {
  const doi = normalizeDoi(rawDoi);
  if (!doi) return null;

  if (getAddedDoisSet().has(doi)) return true;

  const cached = checkCache.get(doi);
  if (cached) {
    const ttl = cached.exists === null ? CHECK_TTL_UNKNOWN_MS : CHECK_TTL_BOOL_MS;
    if (Date.now() - cached.at < ttl) return cached.exists;
  }

  if (Date.now() < localApiUnavailableUntil) return null;

  // Single-flight per DOI: if the same DOI is in flight (same DOI rendered N
  // times in a chat → N buttons mount simultaneously), share the one query.
  const existing = inflightChecks.get(doi);
  if (existing) return existing;

  const promise = (async (): Promise<boolean | null> => {
    try {
      if (!(await pingConnector())) return null;

      const res = await fetchWithTimeout(
        // /items/top excludes child attachments/notes/annotations so the
        // search hits the parent journal article (which carries the DOI
        // field) instead of an attached PDF whose text happens to mention
        // the DOI.
        `${ZOTERO_CONNECTOR_BASE}/api/users/0/items/top?q=${encodeURIComponent(doi)}&qmode=everything&limit=5&format=json`,
        { headers: { 'Accept': 'application/json', 'Zotero-API-Version': '3' } },
        3000,
      );
      if (!res.ok) {
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          localApiUnavailableUntil = Date.now() + CHECK_TTL_UNKNOWN_MS;
        }
        checkCache.set(doi, { exists: null, at: Date.now() });
        return null;
      }
      const items = (await res.json()) as Array<{ data?: { DOI?: string; doi?: string; extra?: string } }>;
      const exists = Array.isArray(items) && items.some(item => {
        const d = item.data?.DOI ?? item.data?.doi;
        if (typeof d === 'string' && normalizeDoi(d) === doi) return true;
        // Books/preprints sometimes carry the DOI in the `extra` field as `DOI: ...`
        const extra = item.data?.extra;
        if (typeof extra === 'string' && extra.toLowerCase().includes(doi)) return true;
        return false;
      });
      checkCache.set(doi, { exists, at: Date.now() });
      if (exists) markDoiAdded(doi);
      return exists;
    } catch {
      checkCache.set(doi, { exists: null, at: Date.now() });
      return null;
    } finally {
      inflightChecks.delete(doi);
    }
  })();
  inflightChecks.set(doi, promise);
  return promise;
}

async function waitForConnector(timeoutMs = LAUNCH_WAIT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingConnector()) return true;
    await new Promise(r => setTimeout(r, LAUNCH_POLL_INTERVAL_MS));
  }
  return false;
}

interface CrossrefMessage {
  title?: string[] | string;
  'container-title'?: string[] | string;
  author?: Array<{ given?: string; family?: string; name?: string }>;
  issued?: { 'date-parts'?: number[][] };
  type?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  ISSN?: string[];
  abstract?: string;
}

async function fetchCrossref(doi: string): Promise<CrossrefMessage | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { headers: { 'User-Agent': 'AcademiaWritingAgent/1.0 (mailto:support@academia.edu)' } },
      8000,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { message?: CrossrefMessage };
    return json.message ?? null;
  } catch (err) {
    logger.warn('[Zotero] Crossref lookup failed:', err);
    return null;
  }
}

const CROSSREF_TYPE_TO_ZOTERO: Record<string, string> = {
  'journal-article': 'journalArticle',
  'book-chapter': 'bookSection',
  'book': 'book',
  'monograph': 'book',
  'edited-book': 'book',
  'proceedings-article': 'conferencePaper',
  'posted-content': 'preprint',
  'report': 'report',
  'dissertation': 'thesis',
};

function pickFirst<T>(v: T | T[] | undefined): T | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function buildItemFromCrossref(meta: CrossrefMessage, doi: string): Record<string, unknown> {
  const title = pickFirst(meta.title) ?? '';
  const containerTitle = pickFirst(meta['container-title']);
  const creators = Array.isArray(meta.author)
    ? meta.author.map(a => ({
        creatorType: 'author',
        firstName: a.given ?? '',
        lastName: a.family ?? a.name ?? '',
      }))
    : [];
  const issuedParts = meta.issued?.['date-parts']?.[0];
  const date = issuedParts && issuedParts.length > 0 ? issuedParts.join('-') : '';
  const itemType = (meta.type && CROSSREF_TYPE_TO_ZOTERO[meta.type]) || 'journalArticle';

  const item: Record<string, unknown> = {
    itemType,
    title,
    creators,
    date,
    DOI: doi,
    url: `https://doi.org/${doi}`,
  };
  if (containerTitle) item.publicationTitle = containerTitle;
  if (meta.volume) item.volume = meta.volume;
  if (meta.issue) item.issue = meta.issue;
  if (meta.page) item.pages = meta.page;
  if (meta.publisher) item.publisher = meta.publisher;
  if (Array.isArray(meta.ISSN) && meta.ISSN.length > 0) item.ISSN = meta.ISSN[0];
  if (meta.abstract) {
    // Crossref abstracts are sometimes wrapped in JATS XML; strip simple tags.
    item.abstractNote = String(meta.abstract).replace(/<[^>]+>/g, '').trim();
  }
  return item;
}

async function postSaveItems(item: Record<string, unknown>, doi: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      `${ZOTERO_CONNECTOR_BASE}/connector/saveItems`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Connector accepts requests with a Mozilla-style UA; mimic the Zotero browser connector.
          'User-Agent': 'Mozilla/5.0 (compatible; AcademiaWritingAgent)',
        },
        body: JSON.stringify({
          items: [item],
          uri: `https://doi.org/${doi}`,
          cookie: '',
        }),
      },
      10000,
    );
    if (res.status === 201 || res.ok) return { success: true };
    const text = await res.text().catch(() => '');
    // 403 typically means the connector rejected the Origin/UA, which usually points to
    // extensions.zotero.httpServer.enabled being off in Zotero's Config Editor.
    if (res.status === 403) {
      return {
        success: false,
        error:
          'Zotero rejected the request. In Zotero, open Edit → Preferences → Advanced → Config Editor and ensure extensions.zotero.httpServer.enabled is true.',
      };
    }
    return { success: false, error: `Zotero connector returned ${res.status}: ${text.slice(0, 200)}` };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

function buildItemFromSlimPublication(pub: SlimPublication, doi: string): Record<string, unknown> {
  const creators = Array.isArray(pub.authors)
    ? pub.authors
        .map((a: any) => {
          if (typeof a === 'string') {
            const parts = a.trim().split(/\s+/);
            const lastName = parts.pop() ?? '';
            const firstName = parts.join(' ');
            return { creatorType: 'author', firstName, lastName };
          }
          return {
            creatorType: 'author',
            firstName: a.given ?? a.first_name ?? '',
            lastName: a.family ?? a.last_name ?? a.name ?? '',
          };
        })
        .filter(c => c.firstName || c.lastName)
    : [];

  const item: Record<string, unknown> = {
    itemType: 'journalArticle',
    title: pub.title ?? '',
    creators,
    date: pub.publication_year != null ? String(pub.publication_year) : '',
    DOI: doi,
    url: `https://doi.org/${doi}`,
  };
  if (pub.publication) item.publicationTitle = pub.publication;
  if (pub.abstract) item.abstractNote = pub.abstract;
  // Attach the OA PDF as an attachment so Zotero downloads it on save.
  if (pub.is_oa && typeof pub.pdf_url === 'string' && pub.pdf_url.length > 0) {
    item.attachments = [
      {
        title: 'Full Text PDF',
        url: pub.pdf_url,
        mimeType: 'application/pdf',
        snapshot: false,
      },
    ];
  }
  return item;
}

export async function addDoiToZotero(rawDoi: string): Promise<AddDoiResult> {
  const doi = rawDoi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/[.,;:]+$/, '');
  if (!doi) return { success: false, error: 'Empty DOI', status: 'not-running' };

  let running = await pingConnector();
  if (!running) {
    if (!isZoteroInstalled()) {
      return { success: false, error: 'Zotero is not installed.', status: 'not-installed' };
    }
    logger.info('[Zotero] Launching Zotero to add DOI:', doi);
    try {
      await shell.openExternal('zotero://');
    } catch (err) {
      logger.warn('[Zotero] shell.openExternal(zotero://) failed:', err);
    }
    running = await waitForConnector();
    if (!running) {
      return { success: false, error: 'Zotero did not respond after launch.', status: 'not-running' };
    }
  }

  // Prefer the CiteRight-cached SlimPublication (already authoritative; carries OA pdf_url),
  // fall back to Crossref, then to a bare-DOI item.
  const cached = getPublicationByDoi(doi);
  let item: Record<string, unknown>;
  if (cached) {
    item = buildItemFromSlimPublication(cached, doi);
  } else {
    const meta = await fetchCrossref(doi);
    item = meta
      ? buildItemFromCrossref(meta, doi)
      : {
          itemType: 'journalArticle',
          title: `DOI: ${doi}`,
          creators: [],
          DOI: doi,
          url: `https://doi.org/${doi}`,
        };
  }

  const result = await postSaveItems(item, doi);
  if (result.success) markDoiAdded(doi);
  return { ...result, status: 'running' };
}

/**
 * Lightweight metadata returned to the renderer so it can decorate DOI links with
 * an "Open PDF" affordance when the upstream publication is open access.
 */
export interface DoiMetadata {
  title?: string;
  publicationYear?: string | number;
  publication?: string;
  isOpenAccess?: boolean;
  pdfUrl?: string;
}

export function getDoiMetadata(rawDoi: string): DoiMetadata | null {
  const pub = getPublicationByDoi(rawDoi);
  if (!pub) return null;
  return {
    title: pub.title,
    publicationYear: pub.publication_year,
    publication: pub.publication,
    isOpenAccess: pub.is_oa,
    pdfUrl: pub.pdf_url,
  };
}

// =============================================================================
// Library search — talks to Zotero 7's local web API at /api/users/0/items.
// Read-only; the user must have extensions.zotero.httpServer.enabled = true.
// =============================================================================

export interface ZoteroSlimItem {
  key: string;
  itemType: string;
  title?: string;
  creators?: Array<{ firstName?: string; lastName?: string; name?: string; creatorType?: string }>;
  date?: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  publisher?: string;
  abstractNote?: string;
  tags?: string[];
  libraryId?: number;
  libraryType?: string;
}

export type ZoteroQMode = 'titleCreatorYear' | 'everything' | 'regex';

export interface SearchZoteroOptions {
  limit?: number;
  qmode?: ZoteroQMode;
  itemType?: string;
}

interface RawZoteroItem {
  key: string;
  library?: { type?: string; id?: number };
  data?: {
    key?: string;
    itemType?: string;
    title?: string;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string; creatorType?: string }>;
    date?: string;
    DOI?: string;
    doi?: string;
    url?: string;
    publicationTitle?: string;
    publisher?: string;
    abstractNote?: string;
    tags?: Array<{ tag?: string }>;
    extra?: string;
  };
}

function slimItem(raw: RawZoteroItem): ZoteroSlimItem {
  const data = raw.data ?? {};
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t) => t?.tag).filter((t): t is string => typeof t === 'string')
    : undefined;
  return {
    key: raw.key,
    itemType: data.itemType ?? 'unknown',
    title: data.title || undefined,
    creators: Array.isArray(data.creators) && data.creators.length > 0 ? data.creators : undefined,
    date: data.date || undefined,
    DOI: data.DOI || data.doi || undefined,
    url: data.url || undefined,
    publicationTitle: data.publicationTitle || undefined,
    publisher: data.publisher || undefined,
    abstractNote: data.abstractNote || undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    libraryId: raw.library?.id,
    libraryType: raw.library?.type,
  };
}

export async function searchZoteroLibrary(
  query: string,
  opts: SearchZoteroOptions = {},
): Promise<ZoteroSlimItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (!(await pingConnector())) {
    throw new Error('Zotero local API is not reachable. Is Zotero running?');
  }
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const qmode = opts.qmode ?? 'titleCreatorYear';
  const params = new URLSearchParams({
    q: trimmed,
    qmode,
    limit: String(limit),
    format: 'json',
  });
  if (opts.itemType) params.set('itemType', opts.itemType);

  const res = await fetchWithTimeout(
    // /items/top — exclude child attachments/notes so search hits parent
    // bibliographic entries (which carry DOI / publication metadata).
    `${ZOTERO_CONNECTOR_BASE}/api/users/0/items/top?${params.toString()}`,
    { headers: { 'Accept': 'application/json', 'Zotero-API-Version': '3' } },
    8000,
  );
  if (!res.ok) {
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new Error(
        'Zotero local web API is not enabled. In Zotero, open Edit → Settings → Advanced → Config Editor and set extensions.zotero.httpServer.enabled to true, then restart Zotero.',
      );
    }
    throw new Error(`Zotero local API returned ${res.status}`);
  }
  const items = (await res.json()) as RawZoteroItem[];
  if (!Array.isArray(items)) return [];
  const slim = items.map(slimItem);
  for (const item of slim) recordOpenInfo(item);
  markDoisAdded(slim.map((i) => i.DOI).filter((d): d is string => typeof d === 'string'));
  return slim;
}

export async function getZoteroItem(key: string): Promise<ZoteroSlimItem | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (!(await pingConnector())) {
    throw new Error('Zotero local API is not reachable. Is Zotero running?');
  }
  const res = await fetchWithTimeout(
    `${ZOTERO_CONNECTOR_BASE}/api/users/0/items/${encodeURIComponent(trimmed)}?format=json`,
    { headers: { 'Accept': 'application/json', 'Zotero-API-Version': '3' } },
    8000,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Zotero local API returned ${res.status}`);
  const raw = (await res.json()) as RawZoteroItem;
  const slim = slimItem(raw);
  recordOpenInfo(slim);
  if (slim.DOI) markDoisAdded([slim.DOI]);
  return slim;
}
