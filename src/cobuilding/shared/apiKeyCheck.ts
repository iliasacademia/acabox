/**
 * Verdict on an Anthropic API key, from the status of one real
 * `GET /v1/models?limit=1` made with it. Pure, shaped like `interpretApiTest`
 * in `shared/apis.ts`, so it can be tested against observed statuses.
 *
 * Only 401/403 mean the key is wrong. Everything else (5xx, 429, a network
 * blip, a proxy that answers oddly) says nothing about the key, so it is
 * `unconfirmed` rather than a guess in either direction.
 */
export type ApiKeyVerdict = 'accepted' | 'rejected' | 'unconfirmed';

export interface ApiKeyCheck {
  verdict: ApiKeyVerdict;
  /** Set for `unconfirmed`: the status or error, for the user to read. */
  detail?: string;
}

export function interpretKeyCheck(r: { status: number } | { error: string }): ApiKeyCheck {
  if ('error' in r) return { verdict: 'unconfirmed', detail: r.error };
  const s = r.status;
  if (s >= 200 && s < 300) return { verdict: 'accepted' };
  if (s === 401 || s === 403) return { verdict: 'rejected' };
  if (s === 429) return { verdict: 'unconfirmed', detail: 'Anthropic is rate-limiting requests (HTTP 429)' };
  return { verdict: 'unconfirmed', detail: `HTTP ${s}` };
}

/** `sk-ant-api…abcd`: enough to recognise a key, never enough to use it. */
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 14) return '…' + key.slice(-4);
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

/** What `auth:getApiKeyStatus` returns. Built here so a test can pin that the key itself is absent. */
export function buildApiKeyStatus(args: {
  apiKey: string | null;
  baseURL?: string | null;
  source: 'env' | 'settings' | null;
}) {
  return {
    hasKey: !!args.apiKey,
    source: args.source,
    baseURL: args.baseURL ?? null,
    maskedKey: maskApiKey(args.apiKey),
  };
}
