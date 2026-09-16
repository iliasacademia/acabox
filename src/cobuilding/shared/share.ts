/**
 * Sharing — types, ids, URLs and content types shared by every side of the
 * feature: main (the publisher), the renderer (Settings → Sharing, the
 * publish dialog), the two Cloudflare Workers (`src/share-workers/`), and the
 * viewer shim that stands in for the host bridge inside a shared, read-only
 * snapshot.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * (this file implements contract C1 verbatim).
 *
 * PURE MODULE — no Node, no Electron, no filesystem. The only platform call is
 * `globalThis.crypto.getRandomValues`, which exists in both Node 22+ and every
 * browser (including inside a Cloudflare Worker), so this file can be imported
 * unmodified by all four consumers.
 */

export type ShareKind = 'app' | 'file';

export interface ShareSettings {
  /** https://acabox-share.<acct>.workers.dev  (no trailing slash) */
  siteUrl: string;
  /** https://acabox-share-api.<acct>.workers.dev */
  apiUrl: string;
  /** Decrypted in main only; '' on the UI side — see the Secrets rule. */
  publishToken: string;
}

export interface PublishedInfo {
  /** slug, see mintShareId */
  id: string;
  kind: ShareKind;
  url: string; // artifactUrl(siteUrl, kind, id)
  /** snapshot hash at publish time (64 hex chars) */
  hash: string;
  publishedAt: string; // ISO 8601
  /** apps only */
  includeInput?: boolean;
}

/**
 * One file in a snapshot. `path` is posix, relative to the version root, e.g.
 * `w/.applications/x/output/a.json`.
 */
export interface SnapshotFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SnapshotGroup {
  count: number;
  bytes: number;
}

export interface SnapshotSummary {
  /** everything under w/.applications/<dir>/ except input/ and output/ */
  code: SnapshotGroup;
  /** w/.applications/<dir>/output/** */
  output: SnapshotGroup;
  /** w/.applications/<dir>/input/** */
  input: SnapshotGroup;
  /** w/.applications/_vendor/** */
  vendor: SnapshotGroup;
  total: SnapshotGroup;
}

/**
 * Stored in R2 at metaKey(kind, id). Read by the viewer shim and the listing
 * page.
 */
export interface ArtifactMeta {
  id: string;
  kind: ShareKind;
  title: string;
  description: string | null;
  hash: string;
  publishedAt: string;
  /**
   * app: `.applications/<dir>/src/index.html` (relative to `w/`).
   * file: the file's basename.
   */
  entry: string;
  /** apps only */
  dirName?: string;
  files: SnapshotFile[];
}

export interface ShareIndexEntry {
  id: string;
  kind: ShareKind;
  title: string;
  description: string | null;
  publishedAt: string;
  hash: string;
}

export interface ShareIndex {
  updatedAt: string;
  artifacts: ShareIndexEntry[];
}

export const SHARE_REFUSAL_MESSAGE =
  'This is a shared, read-only snapshot. Open the tool in Acabox to run it.';

/** `mintShareId` output alphabet: lowercase letters and digits, 36 symbols. */
const SHARE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SHARE_ID_LENGTH = 16;

/** 16 chars, [a-z0-9], from getRandomValues. */
export function mintShareId(): string {
  const bytes = new Uint8Array(SHARE_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += SHARE_ID_ALPHABET[bytes[i] % SHARE_ID_ALPHABET.length];
  }
  return out;
}

const SHARE_ID_PATTERN = /^[a-z0-9]{10,32}$/;

export function isValidShareId(id: string): boolean {
  return SHARE_ID_PATTERN.test(id);
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function isValidHash(hash: string): boolean {
  return HASH_PATTERN.test(hash);
}

/** Trim, strip trailing slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * `http:` is allowed only against these hosts — local wrangler dev and tests.
 * Anything else must be `https:`.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1';
}

function validateOneUrl(raw: string, label: string): { ok: true } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `${label} is required.` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `${label} is not a valid URL.` };
  }
  const isAllowedHttp = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isAllowedHttp) {
    return { ok: false, error: `${label} must start with https://` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: `${label} must not contain a username or password.` };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: `${label} must not contain a query string or fragment.` };
  }
  return { ok: true };
}

/**
 * Both must parse; https: only, except http: on 127.0.0.1 / localhost (tests,
 * local wrangler dev); no userinfo; no query/hash.
 */
export function validateShareSettings(
  s: { siteUrl: string; apiUrl: string }
): { ok: true } | { ok: false; error: string } {
  const site = validateOneUrl(s.siteUrl, 'Site URL');
  if (!site.ok) return site;
  const api = validateOneUrl(s.apiUrl, 'API URL');
  if (!api.ok) return api;
  return { ok: true };
}

export function kindPrefix(kind: ShareKind): 'a' | 'f' {
  return kind === 'app' ? 'a' : 'f';
}

/** `${base}/a/${id}/` | `${base}/f/${id}/` */
export function artifactUrl(siteUrl: string, kind: ShareKind, id: string): string {
  return `${normalizeBaseUrl(siteUrl)}/${kindPrefix(kind)}/${id}/`;
}

/** `a/<id>/meta.json` */
export function metaKey(kind: ShareKind, id: string): string {
  return `${kindPrefix(kind)}/${id}/meta.json`;
}

/** `a/<id>/v/<hash>/` */
export function versionPrefix(kind: ShareKind, id: string, hash: string): string {
  return `${kindPrefix(kind)}/${id}/v/${hash}/`;
}

/** app: `/a/<id>/v/<hash>/w`   file: `/f/<id>/v/<hash>` */
export function versionedBase(kind: ShareKind, id: string, hash: string): string {
  const base = `/${kindPrefix(kind)}/${id}/v/${hash}`;
  return kind === 'app' ? `${base}/w` : base;
}

export const INDEX_KEY = 'index.json';

/**
 * Groups by prefix: `w/.applications/<dirName>/output/`, `…/input/`,
 * `w/.applications/_vendor/`, else code. `total` is the sum of all four.
 */
export function summarizeSnapshot(files: SnapshotFile[], dirName: string): SnapshotSummary {
  const summary: SnapshotSummary = {
    code: { count: 0, bytes: 0 },
    output: { count: 0, bytes: 0 },
    input: { count: 0, bytes: 0 },
    vendor: { count: 0, bytes: 0 },
    total: { count: 0, bytes: 0 },
  };
  const outputPrefix = `w/.applications/${dirName}/output/`;
  const inputPrefix = `w/.applications/${dirName}/input/`;
  const vendorPrefix = `w/.applications/_vendor/`;

  for (const file of files) {
    let group: SnapshotGroup;
    if (file.path.startsWith(outputPrefix)) {
      group = summary.output;
    } else if (file.path.startsWith(inputPrefix)) {
      group = summary.input;
    } else if (file.path.startsWith(vendorPrefix)) {
      group = summary.vendor;
    } else {
      group = summary.code;
    }
    group.count += 1;
    group.bytes += file.size;
    summary.total.count += 1;
    summary.total.bytes += file.size;
  }

  return summary;
}

/**
 * The usual types (matches the `mime-types`/`mime-db` convention this
 * ecosystem uses elsewhere, hand-copied rather than imported — this module
 * stays dependency-free). Text-ish types carry `; charset=utf-8`; everything
 * else is served as-is.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/vnd.microsoft.icon',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeFor(path: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path);
  if (!match) return DEFAULT_CONTENT_TYPE;
  const ext = match[1].toLowerCase();
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * For the shim and the web Worker: strip leading './' and '/', collapse '//',
 * resolve '.' segments, return null if any '..' segment remains or the result
 * is empty. A '..' segment is refused outright, never resolved — this is a
 * security boundary (R2 keys, not a real filesystem, so there is nothing to
 * "resolve" up past).
 */
export function normalizeSnapshotPath(input: string): string | null {
  const segments = input.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    out.push(segment);
  }
  if (out.length === 0) return null;
  return out.join('/');
}
