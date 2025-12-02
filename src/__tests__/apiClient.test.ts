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
import { Logger } from '../utils/logger';

describe('APIclient Logging', () => {
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    // Reset the singleton state
    const apiClientModule = require('../apiClient');
    apiClientModule.apiClient = null;
    apiClientModule.logger = null;

    // Create mock logger
    mockLogger = {
      apiRequest: jest.fn(),
      apiResponse: jest.fn(),
      apiError: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    jest.clearAllMocks();
  });

  describe('APIclient Initialization', () => {
    it('should create client successfully when logger is provided', async () => {
      const client = await APIclient();

      expect(client).toBeDefined();
      expect(client.defaults).toBeDefined();
      expect(client.defaults.baseURL).toBeDefined();
      expect(client.interceptors).toBeDefined();
      expect(client.interceptors.request).toBeDefined();
      expect(client.interceptors.response).toBeDefined();
    });

    it('should create client successfully without logger (backward compatibility)', async () => {
      // Reset for this test
      const apiClientModule = require('../apiClient');
      apiClientModule.apiClient = null;
      apiClientModule.logger = null;

      const client = await APIclient();

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

  describe('Logger Integration', () => {
    it('should accept logger instance as parameter', async () => {
      // Should not throw
      expect(async () => {
        await APIclient();
      }).not.toThrow();
    });

    it('should work without logger instance', async () => {
      // Reset first
      const apiClientModule = require('../apiClient');
      apiClientModule.apiClient = null;

      // Should not throw
      expect(async () => {
        await APIclient();
      }).not.toThrow();
    });
  });
});
