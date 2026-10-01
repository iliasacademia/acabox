import { interpretKeyCheck, type ApiKeyCheck } from '../shared/apiKeyCheck';

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const CHECK_TIMEOUT_MS = 8_000;

/**
 * One cheap authenticated GET to learn whether Anthropic accepts a key.
 * Electron-free and `fetch`-injectable so tests never touch the network.
 * Never throws: a failure to reach the server is an `unconfirmed` verdict.
 */
export async function checkAnthropicKey(
  apiKey: string,
  baseURL?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiKeyCheck> {
  const base = (baseURL?.trim() || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/v1/models?limit=1`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    return interpretKeyCheck({ status: res.status });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return interpretKeyCheck({
      error: timedOut ? 'no answer within 8 seconds' : err instanceof Error ? err.message : String(err),
    });
  }
}
