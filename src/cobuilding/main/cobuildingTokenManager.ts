import { APIclient } from '../../apiClient';
import log from 'electron-log';

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
}

interface GatewayToken {
  token: string;
  gatewayEndpoint: string;
  expiresAt: Date;
}

let currentApiKey: string | null = null;
let currentBaseURL: string | undefined = undefined;
let cachedToken: GatewayToken | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export function getCredentials(): { apiKey: string | null; baseURL: string | undefined } {
  return { apiKey: currentApiKey, baseURL: currentBaseURL };
}

export function setCredentials(apiKey: string | null, baseURL?: string): void {
  currentApiKey = apiKey;
  currentBaseURL = baseURL;
}

export async function fetchGatewayCredentials(useGateway = true): Promise<AnthropicConfig & { keyIdentifier?: string }> {
  const client = await APIclient();
  const response = await client.get('v0/cobuilding/api_key', {
    params: useGateway ? { provider: 'cloudflare_ai_gateway' } : {},
    validateStatus: (status: number) => status >= 200 && status < 600,
  });

  if (response.status === 401) throw new Error('Not authenticated');
  if (response.status === 403) throw new Error(response.data?.error || 'API key has been deactivated');
  if (response.status === 503) throw new Error(response.data?.error || 'No API keys available. Please contact support.');
  if (response.status !== 200) throw new Error(`Unexpected response (${response.status})`);

  const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  const { provider, token, api_key, gateway_endpoint, expires_at, key_identifier } = data;

  if (provider === 'cloudflare_ai_gateway') {
    if (!token || !gateway_endpoint) {
      throw new Error('Missing token or gateway_endpoint in cloudflare response');
    }
    cachedToken = {
      token,
      gatewayEndpoint: gateway_endpoint,
      expiresAt: new Date(expires_at),
    };
    scheduleRefresh();
    const baseURL = `${gateway_endpoint}/anthropic`;
    log.info(`[TokenManager] Using Cloudflare AI Gateway: ${baseURL} (expires: ${expires_at})`);
    setCredentials(token, baseURL);
    return { apiKey: token, baseURL, keyIdentifier: key_identifier };
  }

  if (!api_key) throw new Error('No api_key in response');
  cachedToken = null;
  cancelRefresh();
  log.info(`[TokenManager] Using Anthropic API directly: https://api.anthropic.com (identifier: ${key_identifier})`);
  setCredentials(api_key, undefined);
  return { apiKey: api_key, keyIdentifier: key_identifier };
}

function scheduleRefresh() {
  cancelRefresh();
  if (!cachedToken) return;

  const delay = Math.max(cachedToken.expiresAt.getTime() - Date.now() - REFRESH_BEFORE_EXPIRY_MS, 0);
  log.debug(`[TokenManager] Token refresh scheduled in ${Math.round(delay / 1000)}s`);
  refreshTimer = setTimeout(async () => {
    try {
      const config = await fetchGatewayCredentials();
      log.info('[TokenManager] Token refreshed successfully');
    } catch (err) {
      log.warn('[TokenManager] Token refresh failed, retrying in 5 minutes:', err);
      refreshTimer = setTimeout(() => scheduleRefresh(), RETRY_DELAY_MS);
    }
  }, delay);
}

function cancelRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

export function destroyTokenManager() {
  cancelRefresh();
  cachedToken = null;
  currentApiKey = null;
  currentBaseURL = undefined;
}
