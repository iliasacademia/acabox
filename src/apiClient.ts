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
export const DEFAULT_URL = isDev ? 'https://api.devdemia.com' : 'https://api.academia.edu';
export const BASE_URL = process.env.ACADEMIA_API_URL || DEFAULT_URL;

let apiClient: AxiosInstance | null = null;

// API logging functions (only used by interceptors in this file)
function logApiRequest(method: string, endpoint: string, data?: any): void {
  const logData: ApiLogData = {
    type: 'request',
    method,
    endpoint,
    requestData: data,
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
    requestData: data,
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
    requestData: data,
  };
  logger.sendToDevTools('api', 'error', logData);
}

export const APIclient = async (enableLogging = true): Promise<AxiosInstance> => {
  if (apiClient) {
    return apiClient;
  }
  axiosCookieJarSupport(axios);
  // Use encrypted cookie store instead of plaintext FileCookieStore
  const cookieStore = new EncryptedCookieStore(path.join(app.getPath('userData'), 'backendCookies.encrypted'));
  const cookieJar = new CookieJar(cookieStore);
  const agentArgs = {
    cookies: { jar: cookieJar },
    rejectUnauthorized: !BASE_URL.includes('devdemia'),
  };
  apiClient = axios.create({
    baseURL: BASE_URL,
    withCredentials: false,
    httpsAgent: new HttpsCookieAgent(agentArgs),
    httpAgent: new HttpCookieAgent(agentArgs),
    headers: {
      Accept: 'application/json',
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
    'User-Agent': 'curl/8.4.0',
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
          logger.error('Login error headers:', error.response.headers);
          // Log only non-sensitive error info to console
        }
      }
      throw error;
    });
  return response;
};

export const logout = async () => {
  await APIclient();
  const cookieJarPath = path.join(app.getPath('userData'), 'backendCookies.encrypted');

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
