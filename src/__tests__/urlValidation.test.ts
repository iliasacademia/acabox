/**
 * Tests for URL validation utility
 */

// Mock electron app before importing the validation module
jest.mock('electron', () => ({
  app: {
    isPackaged: false, // Default to development mode
  },
}));

import { validateExternalUrl, getAllowedDomains } from '../utils/urlValidation';

describe('URL Validation', () => {
  describe('validateExternalUrl', () => {
    describe('Valid URLs', () => {
      test('should accept HTTPS URLs from academia.edu', () => {
        const result = validateExternalUrl('https://academia.edu/desktop/authorize?device_id=123');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should accept HTTPS URLs from www.academia.edu', () => {
        const result = validateExternalUrl('https://www.academia.edu/papers');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should accept HTTPS URLs from api.academia.edu', () => {
        const result = validateExternalUrl('https://api.academia.edu/v0/user');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should accept URLs from devdemia.com in development mode', () => {
        const result = validateExternalUrl('https://devdemia.com/test');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should accept URLs from www.devdemia.com in development mode', () => {
        const result = validateExternalUrl('https://www.devdemia.com/test');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should accept HTTP URLs in development mode', () => {
        const result = validateExternalUrl('http://devdemia.com/test');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should accept subdomains of allowed domains', () => {
        const result = validateExternalUrl('https://blog.academia.edu/article');
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Invalid URLs', () => {
      test('should reject empty URLs', () => {
        const result = validateExternalUrl('');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('URL is required');
      });

      test('should reject null URLs', () => {
        const result = validateExternalUrl(null as any);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('URL is required');
      });

      test('should reject non-string URLs', () => {
        const result = validateExternalUrl(123 as any);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('must be a string');
      });

      test('should reject malformed URLs', () => {
        const result = validateExternalUrl('not-a-valid-url');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Invalid URL format');
      });

      test('should reject URLs from non-whitelisted domains', () => {
        const result = validateExternalUrl('https://evil.com/malicious');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Domain not allowed');
      });

      test('should reject file:// protocol URLs', () => {
        const result = validateExternalUrl('file:///etc/passwd');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Invalid protocol');
      });

      test('should reject javascript: protocol URLs', () => {
        const result = validateExternalUrl('javascript:alert("XSS")');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Invalid protocol');
      });

      test('should reject data: protocol URLs', () => {
        const result = validateExternalUrl('data:text/html,<script>alert("XSS")</script>');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Invalid protocol');
      });

      test('should reject FTP protocol URLs', () => {
        const result = validateExternalUrl('ftp://academia.edu/file');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Invalid protocol');
      });

      test('should reject URLs from similar but different domains', () => {
        const result = validateExternalUrl('https://academia.edu.evil.com/phishing');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Domain not allowed');
      });

      test('should reject URLs with typosquatting domains', () => {
        const result = validateExternalUrl('https://acedemia.edu/fake');
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Domain not allowed');
      });
    });

    describe('Production Mode', () => {
      test('should reject HTTP URLs in production mode', () => {
        const result = validateExternalUrl('http://academia.edu/test', false); // false = production mode
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Invalid protocol');
        expect(result.error).not.toContain('development');
      });

      test('should accept HTTPS URLs in production mode', () => {
        const result = validateExternalUrl('https://academia.edu/test', false); // false = production mode
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('should reject devdemia.com in production mode', () => {
        const result = validateExternalUrl('https://devdemia.com/test', false); // false = production mode
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('Domain not allowed');
      });
    });
  });

  describe('getAllowedDomains', () => {
    test('should return list of allowed domains', () => {
      const domains = getAllowedDomains();
      expect(Array.isArray(domains)).toBe(true);
      expect(domains.length).toBeGreaterThan(0);
      expect(domains).toContain('academia.edu');
    });

    test('should not allow modification of internal list', () => {
      const domains1 = getAllowedDomains();
      const domains2 = getAllowedDomains();

      // Modify the returned array
      domains1.push('evil.com');

      // The second call should not include the modification
      expect(domains2).not.toContain('evil.com');
    });
  });
});
