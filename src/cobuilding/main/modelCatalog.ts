/**
 * Live model discovery — `GET /v1/models`, so a model Anthropic ships appears
 * in Acabox without a code change.
 *
 * WHY MAIN OWNS THIS. The call needs the API key, and the key never leaves the
 * main process (`secretStore.ts`). The renderer asks over IPC and gets ids and
 * display names back; the credential stays here, exactly as it does for the
 * API proxy.
 *
 * WHY IT IS BEST-EFFORT, ALWAYS. Every caller works from
 * `shared/models.ts`'s curated table when discovery has not answered — no key
 * configured, offline, rate-limited, or simply not back yet on a cold boot.
 * Discovery can only ever ADD to that table (see `mergeModels`), so its
 * failure mode is "the roster you had before", never an empty picker. That is
 * also why nothing here throws.
 */
import log from 'electron-log';
import { type DiscoveredModel } from '../shared/models';

/** Anthropic's models endpoint. `baseURL` overrides it for proxy users. */
const MODELS_PATH = '/v1/models';
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * One page is the whole roster in practice; the cap is a loop bound, not a
 * limit we expect to reach.
 */
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

/**
 * Short by design. This runs on the boot path, and a hung models endpoint must
 * not hold up the agent — the curated table is already a correct answer.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Re-ask at most this often. A model roster does not change by the minute. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cached: DiscoveredModel[] = [];
let cachedAt = 0;
let lastError: string | null = null;
/** Single-flight: a boot refresh and a picker open must not both fetch. */
let inFlight: Promise<DiscoveredModel[]> | null = null;

/** Whatever discovery last returned. Empty until it succeeds once. */
export function discoveredModels(): DiscoveredModel[] {
  return cached;
}

/** Why the last attempt failed, for the UI to show rather than guess. */
export function discoveryError(): string | null {
  return lastError;
}

/**
 * Fetch the roster, honouring the cache.
 *
 * `force` skips the TTL — used when the user saves a new key, since the old
 * answer may have been an auth failure.
 */
export async function refreshModels(
  creds: { apiKey: string | null; baseURL?: string },
  force = false,
): Promise<DiscoveredModel[]> {
  if (!force && cached.length > 0 && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = fetchModels(creds)
    .then((models) => {
      // Only replace a good roster with another good one. A transient failure
      // must not empty a list the picker is already showing.
      if (models.length > 0) {
        cached = models;
        cachedAt = Date.now();
        lastError = null;
        // Ids, not just a count: when someone reports "model X is missing",
        // the only question that matters is whether the account can see it,
        // and this is the line that answers it. Ids are public names — no
        // credential material goes anywhere near this log.
        log.info(`[Models] Discovered ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`);
      }
      return cached;
    })
    .catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`[Models] Discovery failed: ${lastError} — using the built-in list.`);
      return cached;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

async function fetchModels(creds: { apiKey: string | null; baseURL?: string }): Promise<DiscoveredModel[]> {
  if (!creds.apiKey) throw new Error('No API key configured.');

  const base = (creds.baseURL?.trim() || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
  const out: DiscoveredModel[] = [];
  let afterId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(base + MODELS_PATH);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (afterId) url.searchParams.set('after_id', afterId);

    // AbortSignal.timeout rather than a manual timer: it rejects the fetch
    // itself, so a hung socket cannot outlive the deadline.
    const res = await fetch(url.toString(), {
      headers: {
        'x-api-key': creds.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      // The body can carry the key back in an echoed request; never log it.
      throw new Error(`HTTP ${res.status} from ${MODELS_PATH}`);
    }

    const body = await res.json() as { data?: unknown; has_more?: boolean; last_id?: string };
    if (!Array.isArray(body.data)) throw new Error('Malformed response: no data array.');

    for (const raw of body.data) {
      const m = raw as Record<string, unknown>;
      // Ignore anything without an id rather than letting `undefined` reach a
      // Set of allowed model strings.
      if (typeof m.id !== 'string' || !m.id) continue;
      out.push({
        id: m.id,
        display_name: typeof m.display_name === 'string' ? m.display_name : undefined,
        created_at: typeof m.created_at === 'string' ? m.created_at : undefined,
      });
    }

    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }

  return out;
}

/** Test seam: reset module state between cases. */
export function __resetModelCatalogForTests(): void {
  cached = [];
  cachedAt = 0;
  lastError = null;
  inFlight = null;
}
