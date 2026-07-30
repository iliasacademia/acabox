/**
 * Persistence for user-configured APIs (Settings → APIs).
 *
 * A near-clone of `connectorsStore.ts`, deliberately: that file's shape is
 * already correct and reviewed, and the two hold the same class of secret.
 *
 * Stored as an `apis` array in `cobuilding-settings.json` under userData —
 * NOT in the workspace, which the agent can write. An agent that could add its
 * own API entry could point one at an arbitrary host and exfiltrate through it;
 * see the header of `shared/connectors.ts` for the same argument. It shares the
 * settings file rather than getting its own because `block-secret-reads.sh`
 * already denies that path by basename, and splitting means two migrations.
 *
 * Secrets are encrypted at rest via `secretStore` (OS keychain) and never
 * cross the IPC boundary — `listApis()` blanks them and reports `hasSecret`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import {
  type ApiAuthStyle,
  type ApiConfig,
  type ApiConfigForUi,
  type ApiCounters,
  validateApi,
} from '../shared/apis';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  isEncryptionAvailable,
} from './secretStore';

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

function writeSettings(data: Record<string, unknown>): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function isAuthStyle(v: unknown): v is ApiAuthStyle {
  return v === 'none' || v === 'bearer' || v === 'header' || v === 'query';
}

/**
 * Coerce a persisted entry into a well-formed ApiConfig. A row written by an
 * older or hand-edited build must not crash the read path, so anything
 * unusable returns null and is dropped from the list.
 */
function normalize(raw: unknown): ApiConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : '';
  if (!id) return null;
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!baseUrl) return null;

  const rawAuth = (r.auth && typeof r.auth === 'object' ? r.auth : {}) as Record<string, unknown>;
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label : id,
    baseUrl,
    allowedHosts: Array.isArray(r.allowedHosts)
      ? r.allowedHosts.filter((h): h is string => typeof h === 'string' && !!h.trim())
      : [],
    auth: {
      style: isAuthStyle(rawAuth.style) ? rawAuth.style : 'none',
      ...(typeof rawAuth.headerName === 'string' ? { headerName: rawAuth.headerName } : {}),
      ...(typeof rawAuth.queryParam === 'string' ? { queryParam: rawAuth.queryParam } : {}),
      ...(typeof rawAuth.basicUser === 'string' ? { basicUser: rawAuth.basicUser } : {}),
      ...(typeof rawAuth.secret === 'string' ? { secret: rawAuth.secret } : {}),
    },
    // Absent means enabled: an API the user added is on unless turned off.
    enabled: r.enabled !== false,
    // Absent means READ ONLY. The safe default has to survive a row written by
    // a build that predates the field.
    allowWrites: r.allowWrites === true,
    notes: typeof r.notes === 'string' ? r.notes : undefined,
    catalogId: typeof r.catalogId === 'string' ? r.catalogId : undefined,
    docsUrl: typeof r.docsUrl === 'string' ? r.docsUrl : undefined,
  };
}

/** APIs exactly as stored — secrets still encrypted. Internal. */
function readStoredApis(): ApiConfig[] {
  const raw = readSettings().apis;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ApiConfig[] = [];
  for (const entry of raw) {
    const a = normalize(entry);
    // A duplicate id would make `/‹id›/…` ambiguous in the proxy router; drop
    // it here so the UI, the proxy and the guidance all agree on the list.
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/**
 * APIs for the UI, with the credential removed entirely and replaced by a
 * boolean. Settings needs to know that a token exists, never what it is.
 *
 * A blank secret coming back on save means "keep the stored one" — see
 * `upsertApi`.
 */
export function listApis(): ApiConfigForUi[] {
  return readStoredApis().map((a) => {
    const { secret, ...auth } = a.auth;
    return { ...a, auth, hasSecret: !!secret };
  });
}

/**
 * APIs with real secrets, decrypted. Main-process only. This is what
 * `apiProxy` calls; never return it over IPC.
 */
export function listApisWithSecrets(): ApiConfig[] {
  return readStoredApis().map((a) => ({
    ...a,
    auth: { ...a.auth, secret: a.auth.secret ? decryptSecret(a.auth.secret) : undefined },
  }));
}

/** One API with its real secret, or null. Main-process only. */
export function getApiWithSecret(id: string): ApiConfig | null {
  return listApisWithSecrets().find((a) => a.id === id) ?? null;
}

function persist(apis: ApiConfig[]): void {
  const data = readSettings();
  data.apis = apis;
  writeSettings(data);
}

export interface ApiMutationResult {
  success: boolean;
  error?: string;
  apis: ApiConfigForUi[];
}

/**
 * Carry forward a secret the user didn't retype.
 *
 * The UI never receives the stored value, so an unedited form posts back an
 * empty string. Treat "empty and something was stored" as unchanged and reuse
 * the stored ciphertext, so editing a base URL doesn't silently wipe the token.
 * Clearing a credential is done with the explicit `clearSecret` flag, because
 * "blank" already means "unchanged".
 */
function resolveSecret(
  incoming: string | undefined,
  stored: string | undefined,
  clearSecret: boolean,
): string | undefined {
  if (clearSecret) return undefined;
  if (incoming && incoming.length) return encryptSecret(incoming);
  return stored;                      // already encrypted at rest
}

/**
 * Create or update an API. `originalId` identifies the row being edited (an
 * edit may rename it); omit it to add.
 */
export function upsertApi(
  api: ApiConfig,
  originalId?: string,
  clearSecret = false,
): ApiMutationResult {
  const stored = readStoredApis();
  const others = stored.filter((a) => a.id !== originalId);
  const candidate: ApiConfig = { ...api, id: (api.id ?? '').trim().toLowerCase() };
  const validation = validateApi(candidate, others.map((a) => a.id));
  if (!validation.ok) {
    return { success: false, error: validation.error, apis: listApis() };
  }

  const previous = originalId ? stored.find((a) => a.id === originalId) : undefined;
  const toStore: ApiConfig = {
    ...candidate,
    auth: {
      ...candidate.auth,
      secret: resolveSecret(candidate.auth.secret, previous?.auth.secret, clearSecret),
    },
  };

  // Replace in place so editing doesn't reorder the user's list.
  const next = previous
    ? stored.map((a) => (a.id === originalId ? toStore : a))
    : [...stored, toStore];
  persist(next);
  log.info(
    `[APIs] Saved "${toStore.id}" (${toStore.auth.style}, `
    + `${toStore.allowWrites ? 'read & write' : 'read only'}, enabled=${toStore.enabled})`,
  );
  return { success: true, apis: listApis() };
}

export function removeApi(id: string): ApiMutationResult {
  persist(readStoredApis().filter((a) => a.id !== id));
  resetApiCounters(id);
  log.info(`[APIs] Removed "${id}"`);
  return { success: true, apis: listApis() };
}

function mutateOne(id: string, patch: (a: ApiConfig) => ApiConfig): ApiMutationResult {
  const stored = readStoredApis();
  if (!stored.some((a) => a.id === id)) {
    return { success: false, error: `No API named "${id}".`, apis: listApis() };
  }
  // Persist the STORED rows (secrets still encrypted). Writing back a list that
  // came from `listApis()` here would drop every credential on the next toggle.
  persist(stored.map((a) => (a.id === id ? patch(a) : a)));
  return { success: true, apis: listApis() };
}

export function setApiEnabled(id: string, enabled: boolean): ApiMutationResult {
  const result = mutateOne(id, (a) => ({ ...a, enabled }));
  if (result.success) log.info(`[APIs] "${id}" ${enabled ? 'enabled' : 'disabled'}`);
  return result;
}

export function setApiAllowWrites(id: string, allowWrites: boolean): ApiMutationResult {
  const result = mutateOne(id, (a) => ({ ...a, allowWrites }));
  if (result.success) {
    log.info(`[APIs] "${id}" set to ${allowWrites ? 'read & write' : 'read only'}`);
  }
  return result;
}

/**
 * Encrypt API secrets written by a build that stored them in the clear. Runs
 * once at boot after app.ready, beside the two existing migrations —
 * `safeStorage` throws before ready. No-op when there is nothing to do.
 */
export function migratePlaintextApiSecrets(): void {
  if (!isEncryptionAvailable()) return;
  const stored = readStoredApis();
  const needsWork = stored.some((a) => a.auth.secret && !isEncrypted(a.auth.secret));
  if (!needsWork) return;

  persist(stored.map((a) => ({
    ...a,
    auth: {
      ...a.auth,
      secret: a.auth.secret ? encryptSecret(a.auth.secret) : undefined,
    },
  })));
  log.info('[SecretStore] Encrypted stored API secrets at rest.');
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/**
 * In-memory, reset on restart, and labelled "since launch" in the UI.
 *
 * Persisting would add a fourth write path into the settings file on every
 * single HTTP request, which is a worse trade than a slightly weaker number.
 * An API that has never been called has NO entry, so the UI can render nothing
 * rather than a zero that reads like a failure.
 */
const counters = new Map<string, ApiCounters>();

export function recordApiCall(
  id: string,
  outcome: { refused: boolean; status?: number },
): void {
  const c = counters.get(id) ?? { calls: 0, refused: 0, lastUsedAt: null, lastStatus: null };
  c.calls += 1;
  if (outcome.refused) c.refused += 1;
  c.lastUsedAt = Date.now();
  c.lastStatus = outcome.status ?? null;
  counters.set(id, c);
}

export function getApiCounters(): Record<string, ApiCounters> {
  return Object.fromEntries(counters);
}

export function resetApiCounters(id?: string): void {
  if (id) counters.delete(id);
  else counters.clear();
}
