/**
 * URL validation utility for secure external URL opening
 * Ensures only whitelisted domains can be opened to prevent security vulnerabilities
 */

import { app } from 'electron';

/**
 * Get the list of allowed domains based on environment
 * @param isDevMode Optional override for development mode detection (useful for testing)
 */
function getAllowedDomainsForEnvironment(isDevMode?: boolean): string[] {
  // Determine if we're in development mode
  const isDev = isDevMode !== undefined ? isDevMode : !app.isPackaged;

  // Whitelist of allowed domains for external URL opening
  // Production: academia.edu and its subdomains
  // Development: devdemia.com and its subdomains
  return isDev
    ? [
        'academia.edu',
        'www.academia.edu',
        'api.academia.edu',
        'devdemia.com',
        'www.devdemia.com',
        'api.devdemia.com',
        'docs.google.com',
      ]
    : [
        'academia.edu',
        'www.academia.edu',
        'api.academia.edu',
        'docs.google.com',
      ];
}

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
  const ALLOWED_DOMAINS = getAllowedDomainsForEnvironment(isDev);
  // Check if URL is empty or null
  if (!urlString || typeof urlString !== 'string') {
    return {
      isValid: false,
      error: 'URL is required and must be a string',
    };
  }

  let url: URL;
  try {
    // Parse the URL to validate its structure
    url = new URL(urlString);
  } catch {
    return {
      isValid: false,
      error: 'Invalid URL format',
    };
  }

  // Allow trusted app deep-link protocols that don't involve network requests
  if (url.protocol === 'zotero:') {
    return { isValid: true };
  }

  // Only allow HTTPS protocol (or HTTP in development mode)
  if (url.protocol !== 'https:' && !(isDev && url.protocol === 'http:')) {
    return {
      isValid: false,
      error: `Invalid protocol: ${url.protocol}. Only HTTPS is allowed${isDev ? ' (or HTTP in development)' : ''}`,
    };
  }

  // Extract hostname and check against whitelist
  const hostname = url.hostname.toLowerCase();

  // Check if hostname matches any allowed domain or is a subdomain of an allowed domain
  const isAllowed = ALLOWED_DOMAINS.some((domain) => {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });

  if (!isAllowed) {
    return {
      isValid: false,
      error: `Domain not allowed: ${hostname}. Only ${ALLOWED_DOMAINS.join(', ')} and their subdomains are permitted`,
    };
  }

  // All checks passed
  return {
    isValid: true,
  };
}

/**
 * Get the list of allowed domains (useful for logging/debugging)
 * @param isDevMode Optional override for development mode detection (useful for testing)
 */
export function getAllowedDomains(isDevMode?: boolean): string[] {
  return [...getAllowedDomainsForEnvironment(isDevMode)];
}
