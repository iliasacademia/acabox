/**
 * Persistence for Settings → Sharing: the publish token (encrypted at rest)
 * and the registry of files the user has published individually.
 *
 * A near-clone of `main/apiStore.ts`, deliberately — that file's shape is
 * already reviewed and correct for the same class of secret (a bearer
 * credential that must survive editing the surrounding settings without being
 * retyped, and must never cross the IPC boundary in the clear).
 *
 * Stored as a `sharing` object in `cobuilding-settings.json` under userData —
 * not in the workspace, which the agent can write; see the header of
 * `shared/connectors.ts` for the same argument applied to a different secret.
 *
 * The publish token is encrypted at rest via `secretStore` (OS keychain) and
 * never crosses the IPC boundary — `getShareSettingsForUi()` has no token
 * field at all, only `hasToken`. It is also never logged, not even at debug
 * level: every `log.*` call below is checked to carry no token material.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * (this file implements ticket M7).
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import log from 'electron-log';
import {
  type PublishedInfo,
  type ShareKind,
  type ShareSettings,
  normalizeBaseUrl,
  validateShareSettings,
} from '../../shared/share';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  isEncryptionAvailable,
} from '../secretStore';

export interface ShareSettingsForUi {
  siteUrl: string;
  apiUrl: string;
  hasToken: boolean;
}

/** Shape of the `sharing` key as it sits on disk. `publishToken` may be
 * encrypted (`enc:v1:…`), legacy plaintext, or `''`. */
interface StoredSharing {
  siteUrl: string;
  apiUrl: string;
  publishToken: string;
  files: Record<string, PublishedInfo>;
}

function emptySharing(): StoredSharing {
  return { siteUrl: '', apiUrl: '', publishToken: '', files: {} };
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Atomic write (temp file + rename, as `manifestIO.ts` does for per-tool
 * manifests). Readers of `cobuilding-settings.json` only ever see a complete
 * file, never a truncated one from a write that raced a read.
 */
function writeSettings(data: Record<string, unknown>): void {
  const settingsPath = getSettingsPath();
  const tmpPath = path.join(
    path.dirname(settingsPath),
    `.cobuilding-settings-${randomUUID()}.tmp`,
  );
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, settingsPath);
}

function isShareKind(v: unknown): v is ShareKind {
  return v === 'app' || v === 'file';
}

/**
 * Coerce a persisted registry entry into a well-formed `PublishedInfo`. A row
 * written by an older or hand-edited build must not crash the read path, so
 * anything unusable is dropped rather than thrown.
 */
function normalizePublishedInfo(raw: unknown): PublishedInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (!isShareKind(r.kind)) return null;
  if (typeof r.url !== 'string' || !r.url) return null;
  if (typeof r.hash !== 'string' || !r.hash) return null;
  if (typeof r.publishedAt !== 'string' || !r.publishedAt) return null;
  const info: PublishedInfo = {
    id: r.id,
    kind: r.kind,
    url: r.url,
    hash: r.hash,
    publishedAt: r.publishedAt,
  };
  if (typeof r.includeInput === 'boolean') info.includeInput = r.includeInput;
  return info;
}

function normalizeSharing(raw: unknown): StoredSharing {
  if (!raw || typeof raw !== 'object') return emptySharing();
  const r = raw as Record<string, unknown>;
  const filesRaw = r.files && typeof r.files === 'object' ? (r.files as Record<string, unknown>) : {};
  const files: Record<string, PublishedInfo> = {};
  for (const [relPath, entry] of Object.entries(filesRaw)) {
    const info = normalizePublishedInfo(entry);
    if (info) files[relPath] = info;
  }
  return {
    siteUrl: typeof r.siteUrl === 'string' ? r.siteUrl : '',
    apiUrl: typeof r.apiUrl === 'string' ? r.apiUrl : '',
    publishToken: typeof r.publishToken === 'string' ? r.publishToken : '',
    files,
  };
}

/** Sharing settings exactly as stored — the token still encrypted. Internal. */
function readSharing(): StoredSharing {
  return normalizeSharing(readSettings().sharing);
}

function persistSharing(sharing: StoredSharing): void {
  const data = readSettings();
  data.sharing = sharing;
  writeSettings(data);
}

/** Decrypted settings. Main-process only — never send this over IPC. */
export function getShareSettings(): ShareSettings {
  const stored = readSharing();
  return {
    siteUrl: stored.siteUrl,
    apiUrl: stored.apiUrl,
    publishToken: stored.publishToken ? decryptSecret(stored.publishToken) : '',
  };
}

/** Settings for the UI: the token is reduced to a boolean, never sent whole. */
export function getShareSettingsForUi(): ShareSettingsForUi {
  const stored = readSharing();
  return {
    siteUrl: stored.siteUrl,
    apiUrl: stored.apiUrl,
    hasToken: !!stored.publishToken,
  };
}

/**
 * Carry forward a token the user didn't retype.
 *
 * The UI never receives the stored value, so an unedited form posts back an
 * empty string. Treat "blank" as unchanged and reuse the stored ciphertext, so
 * editing a URL doesn't silently wipe the token. Clearing is the explicit
 * `clearToken` flag, because blank already means "unchanged".
 */
function resolveToken(
  incoming: string | undefined,
  stored: string,
  clearToken: boolean,
): string {
  if (clearToken) return '';
  if (incoming && incoming.length) return encryptSecret(incoming);
  return stored; // already encrypted at rest (or legacy plaintext, untouched)
}

/**
 * Validate and persist the site/API URLs and (optionally) the publish token.
 * A blank/omitted `publishToken` keeps whatever is stored; `clearToken`
 * removes it. Validation failures leave the store untouched.
 */
export function saveShareSettings(patch: {
  siteUrl: string;
  apiUrl: string;
  publishToken?: string;
  clearToken?: boolean;
}): { ok: true } | { ok: false; error: string } {
  const validation = validateShareSettings({ siteUrl: patch.siteUrl, apiUrl: patch.apiUrl });
  if (!validation.ok) return validation;

  const stored = readSharing();
  const publishToken = resolveToken(patch.publishToken, stored.publishToken, !!patch.clearToken);

  persistSharing({
    siteUrl: normalizeBaseUrl(patch.siteUrl),
    apiUrl: normalizeBaseUrl(patch.apiUrl),
    publishToken,
    files: stored.files, // never touched by a settings save
  });
  log.info(`[Share] Settings saved (hasToken=${!!publishToken})`);
  return { ok: true };
}

/** True once a site URL, an API URL, and a publish token are all set. */
export function isShareConfigured(): boolean {
  const s = getShareSettings();
  return !!s.siteUrl && !!s.apiUrl && !!s.publishToken;
}

/**
 * Encrypt a publish token written by a build that stored it in the clear.
 * Runs once at boot after `app.whenReady()` (`safeStorage` throws before
 * ready) — no-op when there is nothing to do or the OS has no keyring.
 */
export function migratePlaintextShareToken(): void {
  if (!isEncryptionAvailable()) return;
  const stored = readSharing();
  if (!stored.publishToken || isEncrypted(stored.publishToken)) return;
  persistSharing({ ...stored, publishToken: encryptSecret(stored.publishToken) });
  log.info('[SecretStore] Encrypted the stored share publish token at rest.');
}

// ---------------------------------------------------------------------------
// Published-files registry
// ---------------------------------------------------------------------------

export function getPublishedFile(relPath: string): PublishedInfo | null {
  return readSharing().files[relPath] ?? null;
}

export function setPublishedFile(relPath: string, info: PublishedInfo): void {
  const stored = readSharing();
  persistSharing({ ...stored, files: { ...stored.files, [relPath]: info } });
}

export function removePublishedFile(relPath: string): void {
  const stored = readSharing();
  if (!(relPath in stored.files)) return;
  const files = { ...stored.files };
  delete files[relPath];
  persistSharing({ ...stored, files });
}

export function listPublishedFiles(): Array<{ relPath: string; info: PublishedInfo }> {
  return Object.entries(readSharing().files).map(([relPath, info]) => ({ relPath, info }));
}
