import { APIclient, getCsrfToken } from './apiClient';
import { defaultLogger as logger } from './utils/logger';

export interface BackendApiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  data?: any;
  headers?: Record<string, string>;
}

export async function callBackendApi<T = any>(options: BackendApiCallOptions): Promise<T> {
  const { method, endpoint, data, headers: extraHeaders } = options;
  try {
    const client = await APIclient();

    const headers: Record<string, string> = { ...(extraHeaders || {}) };
    if (method !== 'GET') {
      headers['x-csrf-token'] = await getCsrfToken();
    }

    let response;
    switch (method) {
      case 'GET':
        response = await client.get(endpoint, { headers });
        break;
      case 'POST':
        response = await client.post(endpoint, data, { headers });
        break;
      case 'PUT':
        response = await client.put(endpoint, data, { headers });
        break;
      case 'PATCH':
        response = await client.patch(endpoint, data, { headers });
        break;
      case 'DELETE':
        response = await client.delete(endpoint, { headers });
        break;
      default:
        throw new Error(`Unsupported HTTP method: ${method}`);
    }

    return response.data as T;
  } catch (error: any) {
    const fullUrl = (error.config?.baseURL || '') + (error.config?.url || '');
    logger.error(`[API] ${method} ${endpoint} failed: ${JSON.stringify({
      url: fullUrl,
      status: error.response?.status,
      statusText: error.response?.statusText,
      message: error.message,
      data: error.response?.data,
    })}`);

    if (error.response) {
      const backendError = extractBackendErrorMessage(error.response.data);
      if (backendError) {
        throw new Error(`API Error: ${backendError}`);
      }
      throw new Error(`Request failed with status code ${error.response.status}`);
    }
    throw error;
  }
}

function extractBackendErrorMessage(data: any): string | null {
  if (!data) return null;
  if (data.error) return String(data.error);
  if (data.message) return String(data.message);
  if (data.errors) {
    const errors = data.errors;
    if (Array.isArray(errors)) return errors.join(', ');
    if (typeof errors === 'object') {
      return Object.values(errors).flat().join(', ');
    }
  }
  return null;
}
