/**
 * CloudFront Domain Validation Utility - Type Declarations
 *
 * Type definitions for validateCloudFrontDomain.js module
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
export function validateCloudFrontDomain(domain: string | undefined): boolean;
