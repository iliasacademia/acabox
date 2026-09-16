/**
 * Typed HTTP client for the `acabox-share-api` Worker (contract C4 in
 * `docs/design/sharing-tickets.md`). Ticket M4.
 *
 * Electron-free by design: it takes a plain `apiUrl` + `token` and uses the
 * global `fetch`, so it can run identically in the main process and under
 * Jest (Electron's bundled Node has global `fetch`). Nothing here imports
 * `electron` or `electron-log`.
 *
 * Retry policy (network error, 429, and 5xx only — never another 4xx):
 * exponential backoff `baseDelayMs * 2^attempt` between attempts, up to
 * `maxAttempts` tries total. The last failure is what gets thrown, as a
 * `ShareApiError` carrying the real HTTP status (0 for a network error, since
 * there was no response to carry one).
 */
import type { ArtifactMeta, ShareIndex, ShareKind } from '../../shared/share';
import { normalizeBaseUrl } from '../../shared/share';

export class ShareApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ShareApiError';
  }
}

export interface ShareApi {
  health(): Promise<void>;
  listArtifacts(): Promise<ShareIndex>;
  /** null on 404 — that is the expected shape of "nothing published yet", not an error. */
  getArtifact(kind: ShareKind, id: string): Promise<ArtifactMeta | null>;
  putFile(
    kind: ShareKind,
    id: string,
    hash: string,
    relPath: string,
    body: Uint8Array | ReadableStream,
    contentType: string,
  ): Promise<void>;
  commit(meta: ArtifactMeta): Promise<void>;
  remove(kind: ShareKind, id: string): Promise<void>;
}

export interface ShareApiClientOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Total attempts, including the first. Default 3. */
  maxAttempts?: number;
  /** Backoff base for `baseDelayMs * 2^attempt`. Default 250. Pass a small value in tests. */
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Each relPath segment is encoded on its own, so a literal `/` in the path stays a separator. */
function encodeRelPath(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isReadableStream(body: unknown): body is ReadableStream {
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
}

/** Options for the internal `request` helper only — not part of the public API. */
interface RequestOptions {
  /** Statuses that should be returned to the caller as a Response, not thrown as a ShareApiError. */
  passthroughStatuses?: number[];
}

export class ShareApiClient implements ShareApi {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(opts: ShareApiClientOptions) {
    this.apiUrl = normalizeBaseUrl(opts.apiUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  async health(): Promise<void> {
    await this.request('/v1/health');
  }

  async listArtifacts(): Promise<ShareIndex> {
    const response = await this.request('/v1/artifacts');
    return (await response.json()) as ShareIndex;
  }

  async getArtifact(kind: ShareKind, id: string): Promise<ArtifactMeta | null> {
    const response = await this.request(
      `/v1/artifacts/${kind}/${encodeURIComponent(id)}`,
      {},
      { passthroughStatuses: [404] },
    );
    if (response.status === 404) return null;
    return (await response.json()) as ArtifactMeta;
  }

  async putFile(
    kind: ShareKind,
    id: string,
    hash: string,
    relPath: string,
    body: Uint8Array | ReadableStream,
    contentType: string,
  ): Promise<void> {
    const path = `/v1/artifacts/${kind}/${encodeURIComponent(id)}/v/${encodeURIComponent(hash)}/${encodeRelPath(relPath)}`;
    const init: RequestInit = {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: body as BodyInit,
    };
    if (isReadableStream(body)) {
      // The DOM `RequestInit` type has no `duplex` field even though undici's
      // fetch requires it for a streaming body — cast, as the ticket directs.
      (init as RequestInit & { duplex: 'half' }).duplex = 'half';
    }
    await this.request(path, init);
  }

  async commit(meta: ArtifactMeta): Promise<void> {
    const path = `/v1/artifacts/${meta.kind}/${encodeURIComponent(meta.id)}`;
    await this.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
  }

  async remove(kind: ShareKind, id: string): Promise<void> {
    await this.request(`/v1/artifacts/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * Shared request path: attaches the bearer token, retries network errors,
   * 429s and 5xx with exponential backoff, and turns anything else non-2xx
   * (unless explicitly passed through) into a `ShareApiError`.
   */
  private async request(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);

    // A ReadableStream body can be consumed exactly once, so a second attempt
    // would send an empty (or errored) body and the server would store
    // garbage under a versioned key. Callers that want retries send bytes;
    // the publisher does (it buffers each staged file).
    const attempts = isReadableStream(init.body) ? 1 : this.maxAttempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const isLastAttempt = attempt === attempts - 1;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, headers });
      } catch (err) {
        if (!isLastAttempt) {
          await delay(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new ShareApiError(0, `Network error: ${message}`);
      }

      if (response.ok || opts.passthroughStatuses?.includes(response.status)) {
        return response;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && !isLastAttempt) {
        await delay(this.baseDelayMs * 2 ** attempt);
        continue;
      }

      throw new ShareApiError(response.status, await extractErrorMessage(response));
    }

    // Unreachable — the loop above always returns or throws on its final iteration.
    throw new ShareApiError(0, 'ShareApiClient: exhausted retries');
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // Body wasn't JSON (or was already consumed) — fall through to statusText.
  }
  return response.statusText || `HTTP ${response.status}`;
}
