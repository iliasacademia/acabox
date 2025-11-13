/**
 * Unit tests for CloudFront Domain Validation
 *
 * Tests the security validation logic for CLOUDFRONT_DOMAIN environment variable
 * to prevent malicious update server redirection attacks.
 */

import { validateCloudFrontDomain } from '../utils/validateCloudFrontDomain';

describe('CloudFront Domain Validation', () => {

  describe('Valid CloudFront domains', () => {
    test('should accept valid CloudFront distribution domain', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net')).toBe(true);
    });

    test('should accept numeric-only distribution ID', () => {
      expect(validateCloudFrontDomain('d123456789012.cloudfront.net')).toBe(true);
    });

    test('should accept alphanumeric distribution ID', () => {
      expect(validateCloudFrontDomain('dabc123def456.cloudfront.net')).toBe(true);
    });

    test('should accept distribution ID with hyphens', () => {
      expect(validateCloudFrontDomain('d111-abc-def.cloudfront.net')).toBe(true);
    });

    test('should accept uppercase letters (case insensitive)', () => {
      expect(validateCloudFrontDomain('D111111ABCDEF8.CLOUDFRONT.NET')).toBe(true);
      expect(validateCloudFrontDomain('D111111ABCDEF8.cloudfront.net')).toBe(true);
    });

    test('should accept mixed case', () => {
      expect(validateCloudFrontDomain('D111abc-DEF456.CloudFront.Net')).toBe(true);
    });

    test('should accept single character distribution ID', () => {
      expect(validateCloudFrontDomain('d.cloudfront.net')).toBe(true);
    });

    test('should accept two character distribution ID', () => {
      expect(validateCloudFrontDomain('d1.cloudfront.net')).toBe(true);
    });
  });

  describe('Invalid CloudFront domains - Attack vectors', () => {
    test('should reject evil.com domain', () => {
      expect(validateCloudFrontDomain('evil.com')).toBe(false);
    });

    test('should reject non-CloudFront CDN domains', () => {
      expect(validateCloudFrontDomain('cdn.jsdelivr.net')).toBe(false);
      expect(validateCloudFrontDomain('unpkg.com')).toBe(false);
      expect(validateCloudFrontDomain('fastly.net')).toBe(false);
    });

    test('should reject domain with protocol prefix', () => {
      expect(validateCloudFrontDomain('https://d111111abcdef8.cloudfront.net')).toBe(false);
      expect(validateCloudFrontDomain('http://d111111abcdef8.cloudfront.net')).toBe(false);
    });

    test('should reject domain with path', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net/path')).toBe(false);
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net/malicious')).toBe(false);
    });

    test('should reject domain with path traversal', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net/../')).toBe(false);
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net/..')).toBe(false);
    });

    test('should reject domain with query parameters', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net?param=value')).toBe(false);
    });

    test('should reject domain with fragment', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net#fragment')).toBe(false);
    });

    test('should reject domain with port', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net:8080')).toBe(false);
    });

    test('should reject domain with @ character (potential credential injection)', () => {
      expect(validateCloudFrontDomain('user@d111111abcdef8.cloudfront.net')).toBe(false);
    });

    test('should reject subdomain under cloudfront.net', () => {
      expect(validateCloudFrontDomain('evil.d111111abcdef8.cloudfront.net')).toBe(false);
    });

    test('should reject domains with cloudfront.net in middle', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net.evil.com')).toBe(false);
    });

    test('should reject distribution ID starting with hyphen', () => {
      expect(validateCloudFrontDomain('-d111111abcdef8.cloudfront.net')).toBe(false);
    });

    test('should reject distribution ID ending with hyphen', () => {
      expect(validateCloudFrontDomain('d111111abcdef8-.cloudfront.net')).toBe(false);
    });

    test('should reject domain with special characters', () => {
      expect(validateCloudFrontDomain('d111$abc.cloudfront.net')).toBe(false);
      expect(validateCloudFrontDomain('d111_abc.cloudfront.net')).toBe(false);
      expect(validateCloudFrontDomain('d111*abc.cloudfront.net')).toBe(false);
    });

    test('should reject similar TLDs', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.com')).toBe(false);
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.org')).toBe(false);
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.io')).toBe(false);
    });
  });

  describe('Edge cases - Empty and invalid inputs', () => {
    test('should reject undefined', () => {
      expect(validateCloudFrontDomain(undefined)).toBe(false);
    });

    test('should reject null', () => {
      expect(validateCloudFrontDomain(null as any)).toBe(false);
    });

    test('should reject empty string', () => {
      expect(validateCloudFrontDomain('')).toBe(false);
    });

    test('should reject whitespace-only string', () => {
      expect(validateCloudFrontDomain('   ')).toBe(false);
      expect(validateCloudFrontDomain('\t')).toBe(false);
      expect(validateCloudFrontDomain('\n')).toBe(false);
    });

    test('should reject non-string types', () => {
      expect(validateCloudFrontDomain(123 as any)).toBe(false);
      expect(validateCloudFrontDomain({} as any)).toBe(false);
      expect(validateCloudFrontDomain([] as any)).toBe(false);
      expect(validateCloudFrontDomain(true as any)).toBe(false);
    });

    test('should reject domain exceeding 255 characters', () => {
      const longDomain = 'd' + 'a'.repeat(250) + '.cloudfront.net';
      expect(validateCloudFrontDomain(longDomain)).toBe(false);
    });

    test('should accept valid domain with leading/trailing whitespace (trimmed)', () => {
      expect(validateCloudFrontDomain('  d111111abcdef8.cloudfront.net  ')).toBe(true);
    });
  });

  describe('CloudFront format edge cases', () => {
    test('should reject just .cloudfront.net', () => {
      expect(validateCloudFrontDomain('.cloudfront.net')).toBe(false);
    });

    test('should reject cloudfront.net without subdomain', () => {
      expect(validateCloudFrontDomain('cloudfront.net')).toBe(false);
    });

    test('should reject multiple dots in a row', () => {
      expect(validateCloudFrontDomain('d111..cloudfront.net')).toBe(false);
    });

    test('should reject newline injection attempts', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net\nevil.com')).toBe(false);
    });

    test('should reject carriage return injection attempts', () => {
      expect(validateCloudFrontDomain('d111111abcdef8.cloudfront.net\revil.com')).toBe(false);
    });
  });

  describe('Security regression tests', () => {
    test('should prevent GitHub Actions variable injection attack', () => {
      // Simulates an attacker modifying the GitHub Actions CLOUDFRONT_DOMAIN variable
      expect(validateCloudFrontDomain('attacker-controlled.com')).toBe(false);
    });

    test('should prevent DNS rebinding attacks', () => {
      // CloudFront distribution IDs cannot contain dots, only alphanumeric and hyphens
      expect(validateCloudFrontDomain('localhost.cloudfront.net')).toBe(true); // Valid format
      expect(validateCloudFrontDomain('127-0-0-1.cloudfront.net')).toBe(true); // Valid format (hyphens allowed)
      expect(validateCloudFrontDomain('127.0.0.1.cloudfront.net')).toBe(false); // Invalid (dots not allowed in distribution ID)
      expect(validateCloudFrontDomain('127.0.0.1')).toBe(false); // Invalid (not cloudfront.net)
    });

    test('should prevent SSRF via malicious domain', () => {
      expect(validateCloudFrontDomain('internal-server.local')).toBe(false);
      expect(validateCloudFrontDomain('169.254.169.254')).toBe(false); // AWS metadata endpoint
    });

    test('should prevent homograph attacks with similar Unicode characters', () => {
      // Note: The regex uses ASCII-only pattern, so Unicode will fail
      expect(validateCloudFrontDomain('d111111аbcdef8.cloudfront.net')).toBe(false); // 'а' is Cyrillic
    });
  });
});
