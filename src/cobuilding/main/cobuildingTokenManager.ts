/**
 * In-memory Anthropic credential store.
 *
 * Acabox has no login: the API key comes from the user (env var or the
 * Settings screen, resolved in index.ts). This module just holds the resolved
 * key + optional base URL in memory so getCredentials() can serve every agent
 * spawn, chat turn, and scan without re-reading disk each time.
 */

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
}

let currentApiKey: string | null = null;
let currentBaseURL: string | undefined = undefined;

export function getCredentials(): { apiKey: string | null; baseURL: string | undefined } {
  return { apiKey: currentApiKey, baseURL: currentBaseURL };
}

export function setCredentials(apiKey: string | null, baseURL?: string): void {
  currentApiKey = apiKey;
  currentBaseURL = baseURL;
}

export function destroyTokenManager(): void {
  currentApiKey = null;
  currentBaseURL = undefined;
}
