/**
 * CloudFront Domain Validation Utility
 *
 * Validates that a domain follows the required security pattern for CloudFront distributions.
 * Only allows domains matching *.cloudfront.net to prevent malicious update server redirects.
 *
 * This validation is used in two places:
 * 1. Build-time validation in webpack.plugins.js (fails build if invalid)
 * 2. Runtime validation in src/main.ts (defense-in-depth)
 */

/**
 * Validates that a CloudFront domain follows the required security pattern.
 *
 * Security Requirements:
 * - Must be a valid CloudFront domain (*.cloudfront.net)
 * - Must start with alphanumeric character
 * - Can contain alphanumeric characters and hyphens (but not start/end with hyphen)
 * - Must not contain protocols, paths, query parameters, or other URL components
 * - Length must be between 1 and 255 characters
 *
 * @param domain - The domain to validate
 * @returns true if the domain is a valid CloudFront domain, false otherwise
 *
 * @example
 * validateCloudFrontDomain('d111111abcdef8.cloudfront.net') // true
 * validateCloudFrontDomain('evil.com') // false
 * validateCloudFrontDomain('https://d111111abcdef8.cloudfront.net') // false
 */
export function validateCloudFrontDomain(domain: string | undefined): boolean {
  if (!domain || typeof domain !== 'string') {
    return false;
  }

  const trimmed = domain.trim();

  // Check length constraints
  if (trimmed.length === 0 || trimmed.length > 255) {
    return false;
  }

  // Strict CloudFront domain pattern
  // Format: <distribution-id>.cloudfront.net
  // - Must start with alphanumeric
  // - Can contain alphanumeric and hyphens (but not start/end with hyphen)
  // - Must end with .cloudfront.net
  const cloudfrontPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudfront\.net$/i;

  return cloudfrontPattern.test(trimmed);
}
