import FormData from 'form-data';
import axios, { AxiosInstance } from 'axios';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';
import { wrapper as axiosCookieJarSupport } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import FileCookieStore from 'tough-cookie-file-store';
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'fs/promises';
import { app } from 'electron';

// In development mode, default to devdemia API
const isDev = !app.isPackaged;
const DEFAULT_URL = isDev ? 'https://api.devdemia.com/' : 'https://api.academia.edu/';
const BASE_URL = process.env.ACADEMIA_API_URL || DEFAULT_URL;

let apiClient: AxiosInstance | null = null;

const APIclient = async (): Promise<AxiosInstance> => {
  if (apiClient) {
    return apiClient;
  }
  axiosCookieJarSupport(axios);
  const cookieJar = new CookieJar(new FileCookieStore(path.join(app.getPath('userData'), 'backendCookies.json')));
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
  return apiClient;
};

const getCsrfToken = async (): Promise<string> => {
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
  const response = await client.get('v0/user', {
    validateStatus: (status) => {
      return (status >= 200 && status < 300) || status === 401;
    },
  });
  return response.status !== 401;
};

export const getCurrentUser = async (): Promise<{ id: number } | null> => {
  const client = await APIclient();
  const response = await client.get('v0/user', {
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
    .post('v0/login', formData, {
      headers: { 'x-csrf-token': await getCsrfToken(), ...formData.getHeaders() },
    })
    .catch((error) => {
      console.error('Login error:', error);
      if (error.response) {
        const data = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data, null, 2);
        fs.writeFileSync('/tmp/wtf.html', data);
      }
      throw error;
    });
  return response;
};

const getTitle = async (filePath: string): Promise<string | undefined> => {
  const arrayBuffer = await readFile(filePath);
  const pdf = await PDFDocument.load(arrayBuffer);
  return pdf.getTitle();
};

// Some PDFs have newlines and multiple spaces in the title, as well as control characters.
const normalizeTitle = async (filePath: string, basePath: string): Promise<string> => {
  let title = (await getTitle(filePath)) || filePath.replace(basePath, '');
  // normalize newlines, paragraph-, & line-endings into spaces
  title = title.replace(/\n/g, ' ');
  title = title.replace(/\p{Zl}/gu, ' ');
  title = title.replace(/\p{Zp}/gu, ' ');

  // strip control characters, but not surrogates or formats
  title = title.replace(/\p{Cc}/gu, '');
  title = title.replace(/\p{Co}/gu, '');
  title = title.replace(/\p{Cn}/gu, '');

  // normalize whitespace
  title = title.replace(/\p{Zs}+/gu, ' ');

  return title.trim();
};

export const uploadFile = async (filePath: string, basePath: string) => {
  const client = await APIclient();
  const formData = new FormData();
  const title = await normalizeTitle(filePath, basePath);
  const csrfToken = await getCsrfToken();
  formData.append('title', title);
  formData.append('file', fs.createReadStream(filePath));
  const response = await client.post('v0/private_papers', formData, {
    headers: { 'x-csrf-token': csrfToken, ...formData.getHeaders() },
    validateStatus: () => {
      // Allow everything so we can give the user feedback on the error
      return true;
    },
  });
  return response;
};

export const searchFiles = async (searchTerm: string) => {
  const client = await APIclient();
  const response = await client.get('v0/private_papers/', {
    params: { search: searchTerm },
  });
  return response.data;
};

export const logout = async () => {
  await APIclient();
  const cookieJarPath = path.join(app.getPath('userData'), 'backendCookies.json');

  // Clear cookies from the jar
  if (fs.existsSync(cookieJarPath)) {
    fs.unlinkSync(cookieJarPath);
  }

  // Reset the API client so it creates a new cookie jar
  apiClient = null;

  return { success: true };
};

// Desktop Notifications API
export interface DesktopNotification {
  created_at: number;
  title: string;
  description: string;
  shown_at: number | null;
}

export interface GetNotificationsResponse {
  notifications: DesktopNotification[];
}

export const getNotifications = async (): Promise<GetNotificationsResponse> => {
  const client = await APIclient();
  const response = await client.get('/v0/desktop_notifications/get_notifications');
  return response.data;
};

export const updateNotification = async (userId: number, createdAt: number): Promise<void> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  await client.patch(
    '/v0/desktop_notifications/update_notification',
    {
      user_id: userId,
      created_at: createdAt,
    },
    {
      headers: { 'x-csrf-token': csrfToken },
    }
  );
};

// Sync Folder API
export interface SyncFolder {
  folder_name: string;
  path: string;
  user_id: number;
  created_at: string;
  updated_at: string;
}

export interface SyncedFile {
  key: string;
  file_name: string;
  relative_path: string;
  size: number;
  last_modified: string;
}

export const downloadFileFromS3 = async (folderName: string, fileKey: string, relativePath: string): Promise<Buffer> => {
  const client = await APIclient();
  const response = await client.get(
    '/v0/sync_agent/download',
    {
      params: {
        folder_name: folderName,
        file_key: fileKey,
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(response.data);
};

// New Sync Agent API

export interface SyncAgentFolder {
  folder_name: string;
  folder_path: string;
  created_at: string;
  updated_at: string;
  files: Array<{
    file_name: string;
    relative_path: string;
    size: number;
    last_modified: string;
    key: string;
  }>;
}

export interface GetLatestResponse {
  folders: SyncAgentFolder[];
  total_folders: number;
  total_files: number;
}

export const getLatestFiles = async (): Promise<GetLatestResponse> => {
  const client = await APIclient();
  const response = await client.get('/v0/sync_agent/get_latest');
  return response.data;
};

export const syncFile = async (
  actionType: 'add' | 'update' | 'remove',
  folderName: string,
  relativePath: string,
  filePath?: string
): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  if (actionType === 'remove') {
    const response = await client.post(
      '/v0/sync_agent/sync',
      {
        action_type: actionType,
        folder_name: folderName,
        relative_path: relativePath,
      },
      {
        headers: { 'x-csrf-token': csrfToken },
        validateStatus: () => true,
      }
    );
    return response;
  } else {
    // For add/update, we need to send the file
    if (!filePath) {
      throw new Error('filePath is required for add/update operations');
    }

    const formData = new FormData();
    formData.append('action_type', actionType);
    formData.append('folder_name', folderName);
    formData.append('relative_path', relativePath);
    formData.append('file', fs.createReadStream(filePath));

    const response = await client.post(
      '/v0/sync_agent/sync',
      formData,
      {
        headers: {
          'x-csrf-token': csrfToken,
          ...formData.getHeaders(),
        },
        validateStatus: () => true,
      }
    );
    return response;
  }
};

export const addSyncAgentFolder = async (folderPath: string): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  const folderName = path.basename(folderPath);

  const response = await client.post(
    '/v0/sync_agent/add_folder',
    {
      path: folderPath,
      folder_name: folderName,
    },
    {
      headers: {
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  return response;
};

export const removeSyncAgentFolder = async (folderName: string): Promise<void> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  await client.delete('/v0/sync_agent/remove_folder', {
    headers: { 'x-csrf-token': csrfToken },
    data: { folder_name: folderName },
  });
};

// New Sync Agent API (aligned with STATUS.md plan)

/**
 * Get complete sync status for user (startup endpoint)
 */
export const getStatus = async (): Promise<any> => {
  const client = await APIclient();
  console.log('[API] Calling GET /v0/sync_agent/status');
  const response = await client.get('/v0/sync_agent/status');
  console.log('[API] Response status:', response.status);
  console.log('[API] Response data:', JSON.stringify(response.data, null, 2));
  return response.data;
};

/**
 * Add new folder to sync
 */
export const addFolder = async (folderName: string, folderPath: string): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  const response = await client.post(
    '/v0/sync_agent/folders',
    {
      folder_name: folderName,
      path: folderPath,
    },
    {
      headers: {
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  return response;
};

/**
 * Remove folder from sync
 */
export const removeFolder = async (folderName: string): Promise<void> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  await client.delete(`/v0/sync_agent/folders/${folderName}`, {
    headers: { 'x-csrf-token': csrfToken },
  });
};

/**
 * Upload or update a file with checksum support
 */
export const createFile = async (
  folderName: string,
  relativePath: string,
  filePath: string,
  checksum: string,
  mtime: string
): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  const formData = new FormData();
  formData.append('folder_name', folderName);
  formData.append('relative_path', relativePath);
  formData.append('checksum', checksum);
  formData.append('mtime', mtime);
  formData.append('file', fs.createReadStream(filePath));

  const response = await client.post(
    '/v0/sync_agent/files',
    formData,
    {
      headers: {
        'x-csrf-token': csrfToken,
        ...formData.getHeaders(),
      },
      validateStatus: () => true,
    }
  );
  return response;
};

/**
 * Delete a file from sync
 */
export const deleteFile = async (
  folderName: string,
  relativePath: string
): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  const response = await client.delete(
    '/v0/sync_agent/files',
    {
      headers: { 'x-csrf-token': csrfToken },
      data: {
        folder_name: folderName,
        relative_path: relativePath,
      },
      validateStatus: () => true,
    }
  );
  return response;
};

/**
 * List files in a folder
 */
export const listFiles = async (folderName: string): Promise<any> => {
  const client = await APIclient();
  console.log('[API] Calling GET /v0/sync_agent/files?folder_name=' + folderName);
  const response = await client.get('/v0/sync_agent/files', {
    params: { folder_name: folderName },
    validateStatus: () => true,
  });
  console.log('[API] Response status:', response.status);
  console.log('[API] Response data:', JSON.stringify(response.data, null, 2));
  return response.data;
};
