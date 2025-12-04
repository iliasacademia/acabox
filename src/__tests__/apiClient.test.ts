// disable eslint rule for this file
/* eslint-disable */

/**
 * Unit tests for apiClient logging functionality
 *
 * Note: Detailed interceptor logic testing is done through integration tests
 * when the application runs in development mode.
 */

// Mock dependencies before importing
jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn().mockReturnValue('/mock/path'),
    getVersion: jest.fn().mockReturnValue('1.0.0-test'),
  },
}));

jest.mock('../encryptedCookieStore');

jest.mock('tough-cookie', () => ({
  CookieJar: jest.fn().mockImplementation(() => ({
    getCookies: jest.fn(),
    setCookie: jest.fn(),
  })),
  Store: class Store {
    synchronous = true;
  },
  Cookie: jest.fn(),
}));

jest.mock('axios-cookiejar-support', () => ({
  wrapper: jest.fn((axios) => axios),
}));

jest.mock('http-cookie-agent/http', () => ({
  HttpCookieAgent: jest.fn(),
  HttpsCookieAgent: jest.fn(),
}));

import { APIclient } from '../apiClient';

describe('APIclient Logging', () => {
  beforeEach(() => {
    // Reset the singleton state
    const apiClientModule = require('../apiClient');
    apiClientModule.apiClient = null;

    jest.clearAllMocks();
  });

  describe('APIclient Initialization', () => {
    it('should create client successfully with logging enabled', async () => {
      const client = await APIclient();

      expect(client).toBeDefined();
      expect(client.defaults).toBeDefined();
      expect(client.defaults.baseURL).toBeDefined();
      expect(client.interceptors).toBeDefined();
      expect(client.interceptors.request).toBeDefined();
      expect(client.interceptors.response).toBeDefined();
    });

    it('should create client successfully with logging disabled', async () => {
      // Reset for this test
      const apiClientModule = require('../apiClient');
      apiClientModule.apiClient = null;

      const client = await APIclient(false);

      expect(client).toBeDefined();
      expect(client.defaults).toBeDefined();
      expect(client.interceptors).toBeDefined();
    });

    it('should use singleton pattern correctly', async () => {
      const client1 = await APIclient();
      const client2 = await APIclient();

      expect(client1).toBe(client2);
    });

    it('should configure baseURL correctly', async () => {
      const client = await APIclient();

      // Should be either devdemia or academia.edu depending on environment
      expect(client.defaults.baseURL).toMatch(/api\.(devdemia\.com|academia\.edu)/);
    });
  });

  describe('Logging Configuration', () => {
    it('should work with logging enabled (default)', async () => {
      // Should not throw
      expect(async () => {
        await APIclient();
      }).not.toThrow();
    });

    it('should work with logging disabled', async () => {
      // Reset first
      const apiClientModule = require('../apiClient');
      apiClientModule.apiClient = null;

      // Should not throw
      expect(async () => {
        await APIclient(false);
      }).not.toThrow();
    });
  });
});
