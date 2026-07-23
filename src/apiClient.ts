import FormData from 'form-data';
import axios, { AxiosInstance } from 'axios';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';
import { wrapper as axiosCookieJarSupport } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { EncryptedCookieStore } from './encryptedCookieStore';
import { defaultLogger as logger } from './utils/logger';
import { ApiLogData, DevToolsLogLevel } from './shared/types';

// In development mode, default to devdemia API
export const isDev = !app.isPackaged;
export const DEFAULT_URL = isDev ? 'https://api.devdemia.com/' : 'https://api.academia.edu/';
export const BASE_URL = process.env.ACADEMIA_API_URL || DEFAULT_URL;

let currentBaseUrl = BASE_URL;

export function setBaseUrl(url: string): void {
  currentBaseUrl = url;
  apiClient = null;
}

let apiClient: AxiosInstance | null = null;

// Helper to sanitize data for logging (avoid circular refs and non-serializable objects)
function sanitizeForLogging(data: any): any {
  if (!data) return data;

  // If it's FormData, extract non-file fields for logging
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    try {
      const fields: Record<string, string> = {};
      const streams: any[] = (data as any)._streams;
      if (Array.isArray(streams)) {
        for (let i = 0; i < streams.length; i++) {
          const header = streams[i];
          if (typeof header === 'string' && header.includes('Content-Disposition')) {
            const nameMatch = header.match(/name="([^"]+)"/);
            const value = streams[i + 1];
            if (nameMatch) {
              fields[nameMatch[1]] = typeof value === 'string' ? value : '[File/Stream]';
            }
          }
        }
      }
      if (Object.keys(fields).length > 0) {
        return { '[FormData]': fields };
      }
    } catch {
      // Fall through to default
    }
    return '[FormData - file upload]';
  }

  // If it's a stream or buffer, don't serialize
  if (data?.pipe || Buffer.isBuffer(data)) {
    return '[Stream/Buffer]';
  }

  // For objects, try to stringify to detect circular refs
  if (typeof data === 'object') {
    try {
      JSON.stringify(data);
      return data;
    } catch {
      return '[Complex Object - cannot serialize]';
    }
  }

  return data;
}

// API logging functions (only used by interceptors in this file)
function logApiRequest(method: string, endpoint: string, data?: any): void {
  const logData: ApiLogData = {
    type: 'request',
    method,
    endpoint,
    requestData: sanitizeForLogging(data),
  };
  logger.sendToDevTools('api', 'info', logData);
}

function logApiResponse(method: string, endpoint: string, status: number, statusText: string, data?: any): void {
  const level: DevToolsLogLevel = status >= 400 ? 'error' : 'info';
  const logData: ApiLogData = {
    type: 'response',
    method,
    endpoint,
    status,
    statusText,
    requestData: sanitizeForLogging(data),
  };
  logger.sendToDevTools('api', level, logData);
}

function logApiError(method: string, endpoint: string, url: string, message: string, status?: number, data?: any): void {
  const logData: ApiLogData = {
    type: 'error',
    method,
    endpoint,
    url,
    message,
    status,
    requestData: sanitizeForLogging(data),
  };
  logger.sendToDevTools('api', 'error', logData);
}

export const APIclient = async (enableLogging = true): Promise<AxiosInstance> => {
  if (apiClient) {
    return apiClient;
  }
  axiosCookieJarSupport(axios);
  // Use encrypted cookie store instead of plaintext FileCookieStore
  const isDevEndpoint = currentBaseUrl.includes('devdemia');
  const cookieFileName = app.isPackaged ? 'backendCookies.encrypted' : (isDevEndpoint ? 'backendCookies.dev.encrypted' : 'backendCookies.prod.encrypted');
  const cookieStore = new EncryptedCookieStore(path.join(app.getPath('userData'), cookieFileName));
  const cookieJar = new CookieJar(cookieStore);
  const agentArgs = {
    cookies: { jar: cookieJar },
    rejectUnauthorized: !isDevEndpoint,
  };
  apiClient = axios.create({
    baseURL: currentBaseUrl,
    withCredentials: false,
    httpsAgent: new HttpsCookieAgent(agentArgs),
    httpAgent: new HttpCookieAgent(agentArgs),
    headers: {
      Accept: 'application/json',
      'User-Agent': `Acabox/${app.getVersion()}`,
    },
  });


  // Add request interceptor for logging
  if (enableLogging) {
    apiClient.interceptors.request.use(
      (config) => {
        const method = config.method?.toUpperCase() || 'UNKNOWN';
        const endpoint = config.url || '';
        const data = config.data || config.params;

        logApiRequest(method, endpoint, data);
        return config;
      },
      (error) => {
        // Request setup failed
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    apiClient.interceptors.response.use(
      (response) => {
        // Success handler - but check for error status codes
        const method = response.config.method?.toUpperCase() || 'UNKNOWN';
        const endpoint = response.config.url || '';
        const status = response.status;

        // Check if this is actually an error (for validateStatus: () => true cases)
        if (status >= 400) {
          logApiError(
            method,
            endpoint,
            (response.config.baseURL || '') + endpoint,
            response.statusText,
            status,
            response.data
          );
        } else {
          logApiResponse(
            method,
            endpoint,
            status,
            response.statusText,
            response.data
          );
        }

        return response;
      },
      (error) => {
        // Error handler for network errors and HTTP errors (when validateStatus not overridden)
        const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
        const endpoint = error.config?.url || '';
        const url = (error.config?.baseURL || '') + endpoint;

        if (error.response) {
          // HTTP error response (4xx, 5xx)
          logApiError(
            method,
            endpoint,
            url,
            error.response.statusText || error.message,
            error.response.status,
            error.response.data
          );
        } else {
          // Network error (no response)
          logApiError(
            method,
            endpoint,
            url,
            error.message
          );
        }

        return Promise.reject(error);
      }
    );
  }

  return apiClient;
};

export const getCsrfToken = async (): Promise<string> => {
  const client = await APIclient();
  const headers = {
    Accept: '*/*',
    'User-Agent': `Acabox/${app.getVersion()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': 0,
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  };
  const transitional = {
    silentJSONParsing: false,
    forcedJSONParsing: false,
  };
  const csrfResponse = await client.post('csrf_meta', {}, { headers, transitional, maxRedirects: 0, transformResponse: (x) => x });
  return csrfResponse.data;
};

export const checkLogin = async (): Promise<boolean> => {
  const client = await APIclient();
  const response = await client.get('/v0/user', {
    validateStatus: (status) => {
      return (status >= 200 && status < 300) || status === 401;
    },
  });
  return response.status !== 401;
};

export const getCurrentUser = async (): Promise<{ id: number } | null> => {
  const client = await APIclient();
  const response = await client.get('/v0/user', {
    validateStatus: (status) => {
      return (status >= 200 && status < 300) || status === 401;
    },
  });
  if (response.status === 401) {
    return null;
  }
  return response.data;
};

export const login = async (email: string, password: string) => {
  const client = await APIclient();
  const formData = new FormData();
  formData.append('login_email', email);
  formData.append('password', password);
  formData.append('remember_me', 'true');
  const response = await client
    .post('/v0/login', formData, {
      headers: { 'x-csrf-token': await getCsrfToken(), ...formData.getHeaders() },
    })
    .catch((error) => {
      if (logger) {
        logger.error('Login error:', error);
        // Security: Do NOT write sensitive error data to disk
        // Previous code wrote to /tmp/wtf.html which was world-readable
        if (error.response) {
          logger.error('Login error status:', error.response.status);
          // Do NOT log headers - may contain sensitive tokens/cookies
        }
      }
      throw error;
    });
  return response;
};

export const logout = async () => {
  await APIclient();
  const isDevEndpoint = currentBaseUrl.includes('devdemia');
  const cookieFileName = app.isPackaged ? 'backendCookies.encrypted' : (isDevEndpoint ? 'backendCookies.dev.encrypted' : 'backendCookies.prod.encrypted');
  const cookieJarPath = path.join(app.getPath('userData'), cookieFileName);

  // Clear cookies from the jar
  if (fs.existsSync(cookieJarPath)) {
    fs.unlinkSync(cookieJarPath);
  }

  // Also clean up legacy plaintext cookie file if it exists
  const legacyCookiePath = path.join(app.getPath('userData'), 'backendCookies.json');
  if (fs.existsSync(legacyCookiePath)) {
    fs.unlinkSync(legacyCookiePath);
  }

  // Reset the API client so it creates a new cookie jar
  apiClient = null;

  return { success: true };
};

export function hasSessionCookie(): boolean {
  const cookieFileName = app.isPackaged ? 'backendCookies.encrypted' : 'backendCookies.dev.encrypted';
  const cookieJarPath = path.join(app.getPath('userData'), cookieFileName);
  return fs.existsSync(cookieJarPath);
}
