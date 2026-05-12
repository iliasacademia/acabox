/**
 * URL validation utility for secure external URL opening
 */

import { app } from 'electron';

/**
 * Validates if a URL is safe to open externally
 * @param urlString The URL string to validate
 * @param isDevMode Optional override for development mode detection (useful for testing)
 * @returns Object with isValid boolean and optional error message
 */
export function validateExternalUrl(
  urlString: string,
  isDevMode?: boolean
): { isValid: boolean; error?: string } {
  const isDev = isDevMode !== undefined ? isDevMode : !app.isPackaged;

  if (!urlString || typeof urlString !== 'string') {
    return {
      isValid: false,
      error: 'URL is required and must be a string',
    };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return {
      isValid: false,
      error: 'Invalid URL format',
    };
  }

  // Allow trusted app deep-link protocols that don't involve network requests
  if (url.protocol === 'zotero:' || url.protocol === 'x-apple.systempreferences:') {
    return { isValid: true };
  }

  // Only allow HTTPS protocol (or HTTP in development mode)
  if (url.protocol !== 'https:' && !(isDev && url.protocol === 'http:')) {
    return {
      isValid: false,
      error: `Invalid protocol: ${url.protocol}. Only HTTPS is allowed${isDev ? ' (or HTTP in development)' : ''}`,
    };
  }

  return { isValid: true };
}

/**
 * Get the list of allowed domains (useful for logging/debugging)
 * @param isDevMode Optional override for development mode detection (useful for testing)
 */
export function getAllowedDomains(isDevMode?: boolean): string[] {
  const isDev = isDevMode !== undefined ? isDevMode : !app.isPackaged;
  return isDev
    ? [
        'academia.edu',
        'www.academia.edu',
        'api.academia.edu',
        'devdemia.com',
        'www.devdemia.com',
        'api.devdemia.com',
        'docs.google.com',
        'doi.org',
        'dx.doi.org',
      ]
    : [
        'academia.edu',
        'www.academia.edu',
        'api.academia.edu',
        'docs.google.com',
        'doi.org',
        'dx.doi.org',
      ];
}
